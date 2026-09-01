import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import type { AddressInfo } from "net";
import fs from "fs";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { getAppSettings } from "../lib/app-settings";
import { log } from "../lib/logger";
import { getCoveFrontendDir, getCoveVoicePort } from "../cove/runtime-manager";
import type {
  RemoteApprovalInput,
  RemoteServerEvent,
  RemoteSessionSettingsInput,
} from "@shared/types/remote";
import { isAcpPermissionBehavior } from "@shared/types/engine";
import { RemoteControlBridge } from "./bridge";

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_PORT = 8787;

const REMOTE_CLIENT_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#f6f8fa"><meta name="mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.webmanifest"><title>Harnss Remote</title>
<link rel="stylesheet" href="/remote-client.css"></head>
<body><main id="app"><div class="boot-screen"><div class="brand-mark">H</div><p>Connecting to Harnss…</p></div></main>
<script src="/remote-client.js"></script></body></html>`;

const REMOTE_CLIENT_CSS = `:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b1020;color:#f8fafc;--bg:#0b1020;--panel:#121a2b;--panel-2:#172136;--line:#273450;--muted:#94a3b8;--soft:#cbd5e1;--accent:#8b9cff;--accent-strong:#6f7fff;--green:#4ade80;--amber:#fbbf24;--red:#fb7185}
*{box-sizing:border-box}body{margin:0;min-width:320px;background:radial-gradient(circle at 100% 0,#1c2850 0,transparent 32%),linear-gradient(160deg,#10182b 0,#090d18 72%);min-height:100vh}
button,input,textarea{font:inherit}button{border:0;color:inherit;cursor:pointer}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
main{max-width:760px;margin:0 auto;padding:env(safe-area-inset-top) 16px calc(28px + env(safe-area-inset-bottom))}
.boot-screen,.auth-screen{min-height:100svh;display:grid;place-items:center;text-align:center;color:var(--muted)}.boot-screen{align-content:center;gap:14px}.boot-screen p{margin:0}
.auth-screen{padding:28px 0}.auth-card{width:100%;max-width:420px;padding:28px 22px;border:1px solid var(--line);border-radius:28px;background:rgba(18,26,43,.9);box-shadow:0 24px 70px rgba(0,0,0,.3);text-align:left}
.brand-mark{display:grid;place-items:center;width:42px;height:42px;border-radius:14px;background:linear-gradient(135deg,#9aa7ff,#6475ee);color:#0b1020;font-weight:850;font-size:22px;box-shadow:0 10px 24px rgba(111,127,255,.3)}
.auth-card .brand-mark{margin-bottom:24px}.auth-card h1{margin:0;font-size:28px;letter-spacing:-.03em}.auth-card p{color:var(--muted);line-height:1.55}.auth-card label{display:block;margin:22px 0 8px;font-size:13px;font-weight:700;color:var(--soft)}
.auth-card input,.search-box input,.composer textarea{width:100%;border:1px solid var(--line);border-radius:14px;background:#0d1423;color:inherit;padding:13px 14px}
.auth-card input{height:50px}.auth-card .primary{width:100%;margin-top:14px}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:18px 0 8px;gap:12px}.brand-lockup{display:flex;align-items:center;gap:11px}.brand-lockup .brand-mark{width:34px;height:34px;border-radius:11px;font-size:18px}.eyebrow,.kicker{margin:0;color:#8290b0;font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}.topbar-title{margin:2px 0 0;font-size:17px;letter-spacing:-.02em}.topbar-actions{display:flex;align-items:center;gap:8px}
.icon-button,.back-button{display:grid;place-items:center;width:40px;height:40px;border:1px solid var(--line);border-radius:13px;background:rgba(23,33,54,.72);color:var(--soft)}.icon-button svg,.back-button svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.connection{display:flex;align-items:center;gap:6px;padding:7px 10px;border:1px solid rgba(74,222,128,.22);border-radius:999px;background:rgba(74,222,128,.08);color:#86efac;font-size:11px;font-weight:700}.connection.offline{border-color:rgba(148,163,184,.2);background:rgba(148,163,184,.08);color:var(--muted)}.dot{width:7px;height:7px;border-radius:50%;background:currentColor}.connection:not(.offline) .dot{box-shadow:0 0 0 4px rgba(74,222,128,.1)}
.page-heading{padding:22px 0 18px}.page-heading h1{margin:5px 0 7px;font-size:31px;line-height:1.05;letter-spacing:-.045em}.subtitle{margin:0;color:var(--muted);font-size:14px}
.overview-card{display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:1px;margin-bottom:18px;border:1px solid var(--line);border-radius:20px;overflow:hidden;background:var(--line)}.metric{padding:15px 14px;background:linear-gradient(145deg,rgba(28,42,72,.96),rgba(18,26,43,.96))}.metric-value{display:block;font-size:22px;font-weight:800;letter-spacing:-.03em}.metric-label{display:block;margin-top:3px;color:var(--muted);font-size:11px}
.toolbar{position:sticky;top:0;z-index:5;padding:6px 0 12px;background:linear-gradient(var(--bg) 72%,transparent)}.search-box{position:relative;display:block}.search-box svg{position:absolute;left:14px;top:50%;width:17px;height:17px;transform:translateY(-50%);fill:none;stroke:var(--muted);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.search-box input{height:48px;padding-left:42px;background:rgba(18,26,43,.95)}.filters{display:flex;gap:7px;overflow:auto;padding:10px 0 2px;scrollbar-width:none}.filters::-webkit-scrollbar{display:none}.filter{flex:0 0 auto;padding:8px 12px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--muted);font-size:12px;font-weight:700}.filter.active{border-color:rgba(139,156,255,.6);background:rgba(139,156,255,.14);color:#c7ceff}
.section-header{display:flex;align-items:center;justify-content:space-between;margin:8px 0 9px}.section-header h2{margin:0;font-size:14px}.section-header span{color:var(--muted);font-size:12px}.session-list{display:grid;align-content:start;align-items:start;gap:8px}.session-card{align-self:start;display:grid;grid-template-columns:34px minmax(0,1fr) auto;align-items:center;gap:11px;width:100%;min-height:76px;height:auto;padding:11px 12px;border:1px solid var(--line);border-radius:16px;background:rgba(18,26,43,.78);text-align:left;transition:transform .15s,border-color .15s,background .15s}.session-card:active{transform:scale(.99)}.session-card:hover{border-color:#3c4e76;background:rgba(23,33,54,.96)}.session-card.attention{border-color:rgba(251,191,36,.52);background:linear-gradient(110deg,rgba(75,56,19,.35),rgba(18,26,43,.8))}
.session-icon{display:grid;place-items:center;width:34px;height:34px;border-radius:11px;background:#202d4b;color:#aeb8ff;font-size:15px;font-weight:850}.session-icon.working{background:rgba(139,156,255,.16);color:#b9c2ff}.session-icon.attention{background:rgba(251,191,36,.14);color:#fcd34d}.session-copy{min-width:0}.session-title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:750}.session-meta{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:4px;color:var(--muted);font-size:11px}.session-status{display:flex;align-items:center;gap:5px;margin-top:4px;color:var(--muted);font-size:11px;font-weight:700}.session-status.working{color:#aeb8ff}.session-status.attention{color:#fcd34d}.session-status .dot{width:6px;height:6px}.chevron{width:16px;height:16px;fill:none;stroke:#64748b;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.empty-state{padding:32px 16px;border:1px dashed #33415f;border-radius:18px;color:var(--muted);text-align:center}.empty-state strong{display:block;margin-bottom:5px;color:var(--soft)}
.detail-topbar{position:sticky;top:0;z-index:8;margin:0 -16px;padding:12px 16px 11px;background:rgba(11,16,32,.9);backdrop-filter:blur(18px);border-bottom:1px solid rgba(39,52,80,.7)}.detail-heading{display:flex;align-items:center;gap:10px;min-width:0}.detail-heading-copy{min-width:0}.detail-heading h1{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0;font-size:17px;letter-spacing:-.02em}.detail-heading p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:4px 0 0;color:var(--muted);font-size:11px}.detail-actions{margin-left:auto;display:flex;align-items:center;gap:7px}.detail-actions .icon-button{width:36px;height:36px}
.detail-status{display:flex;align-items:center;gap:7px;margin:16px 0 12px;padding:12px 14px;border:1px solid var(--line);border-radius:15px;background:rgba(18,26,43,.82);color:var(--soft);font-size:12px}.detail-status.working{border-color:rgba(139,156,255,.5);color:#c7ceff}.detail-status.attention{border-color:rgba(251,191,36,.55);color:#fcd34d}
.approval-panel{position:sticky;top:70px;z-index:7;margin:0 0 14px;padding:16px;border:1px solid rgba(251,191,36,.48);border-radius:20px;background:linear-gradient(145deg,rgba(67,52,19,.98),rgba(32,29,25,.97));box-shadow:0 14px 35px rgba(0,0,0,.22)}.approval-header{display:flex;gap:11px;align-items:flex-start}.approval-icon{display:grid;place-items:center;flex:0 0 34px;height:34px;border-radius:11px;background:rgba(251,191,36,.16);color:#fcd34d;font-size:17px}.approval-panel h2{margin:0;font-size:15px}.approval-panel p{margin:5px 0 0;color:#d6c58d;font-size:12px;line-height:1.45}.approval-question{margin-top:15px}.approval-question label{display:block;margin-bottom:8px;color:#f5e8bd;font-size:12px;font-weight:700}.choice-group{display:grid;gap:7px}.choice{padding:10px 11px;border:1px solid rgba(251,191,36,.25);border-radius:12px;background:rgba(15,18,25,.4);color:#eadfbf;text-align:left;font-size:12px}.choice.is-selected{border-color:#fbbf24;background:rgba(251,191,36,.16);color:#fff3c4}.answer-input{width:100%;border:1px solid rgba(251,191,36,.3);border-radius:12px;background:rgba(15,18,25,.45);color:inherit;padding:10px 11px}.approval-actions{display:grid;grid-template-columns:1fr 1.2fr 1fr;gap:7px;margin-top:16px}.primary,.secondary,.danger{min-height:42px;padding:10px 13px;border-radius:13px;font-size:13px;font-weight:750}.primary{background:linear-gradient(135deg,#9aa7ff,#7182f4);color:#0c1222;box-shadow:0 8px 18px rgba(111,127,255,.2)}.secondary{border:1px solid var(--line);background:#202d48;color:var(--soft)}.danger{border:1px solid rgba(251,113,133,.25);background:rgba(251,113,133,.08);color:#fda4af}
.conversation{display:grid;gap:10px;padding:2px 0 122px}.message{max-width:92%;padding:12px 13px;border:1px solid var(--line);border-radius:17px;background:#172136;color:#e5e7eb;font-size:13px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}.message.user{justify-self:end;border-color:rgba(139,156,255,.25);border-bottom-right-radius:6px;background:linear-gradient(145deg,#344270,#2b375e)}.message.assistant,.message.summary{justify-self:start;border-bottom-left-radius:6px}.message.system{justify-self:center;max-width:100%;border-color:rgba(251,191,36,.2);background:rgba(67,52,19,.5);color:#fcd34d;font-size:12px}.message-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px;color:#9eacd0;font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}.message-time{font-size:10px;font-weight:500;letter-spacing:0;text-transform:none;color:#71809e}.message-body{min-width:0}.message-body.thinking{margin-top:9px;padding-top:8px;border-top:1px solid rgba(148,163,184,.16);color:#94a3b8;font-size:12px}.tool-message{justify-self:stretch;max-width:100%;border:1px solid rgba(71,85,105,.5);border-radius:14px;background:rgba(15,23,42,.72);color:#94a3b8;font-size:12px}.tool-message summary{padding:11px 12px;cursor:pointer;list-style:none}.tool-message summary::-webkit-details-marker{display:none}.tool-message summary:before{content:"›";display:inline-block;margin-right:8px;color:#64748b;font-size:18px;line-height:10px;vertical-align:-2px}.tool-message[open] summary:before{transform:rotate(90deg)}.tool-message .tool-body{padding:0 12px 12px;white-space:pre-wrap;overflow-wrap:anywhere}.task-progress{padding:0 12px 12px}.task-progress-head{display:flex;justify-content:space-between;gap:8px;margin-bottom:7px;color:var(--soft);font-size:10px;font-weight:750}.task-progress-bar{height:5px;overflow:hidden;border-radius:99px;background:var(--line)}.task-progress-bar span{display:block;height:100%;border-radius:inherit;background:var(--accent)}.task-steps{display:grid;gap:5px;margin-top:9px}.task-step{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:11px}.task-step:before{content:"○";display:inline-block;width:16px;color:var(--accent);font-weight:800}.task-step.done:before{content:"✓"}.task-step.error:before{content:"!";color:var(--red)}.streaming:after{content:"";display:inline-block;width:7px;height:7px;margin-left:5px;border-radius:50%;background:var(--accent);animation:pulse 1s infinite}@keyframes pulse{50%{opacity:.25}}
.composer-wrap{position:fixed;z-index:9;right:0;bottom:0;left:0;padding:10px 16px calc(10px + env(safe-area-inset-bottom));background:linear-gradient(transparent,rgba(7,11,21,.96) 22%)}.composer{display:flex;align-items:flex-end;gap:8px;max-width:728px;margin:0 auto;padding:7px;border:1px solid #324263;border-radius:18px;background:rgba(18,26,43,.97);box-shadow:0 12px 30px rgba(0,0,0,.3)}.composer textarea{min-height:44px;max-height:130px;resize:none;border:0;background:transparent;padding:10px 8px;line-height:1.4}.composer textarea:focus-visible{outline:0}.send-button{display:grid;place-items:center;flex:0 0 42px;width:42px;height:42px;border-radius:13px;background:var(--accent-strong);color:#0b1020;font-size:20px;font-weight:900}.send-button:disabled{opacity:.45}.send-button svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.loading-card{padding:22px;border:1px solid var(--line);border-radius:18px;color:var(--muted);text-align:center}.error-banner{margin:12px 0;padding:12px 14px;border:1px solid rgba(251,113,133,.3);border-radius:14px;background:rgba(127,29,29,.2);color:#fda4af;font-size:13px;line-height:1.45}
.detail-control-button{min-height:36px;padding:8px 11px;border:1px solid rgba(139,156,255,.35);border-radius:12px;background:rgba(139,156,255,.12);color:#c7ceff;font-size:11px;font-weight:750}.session-insights{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 14px}.insight-card{padding:12px 13px;border:1px solid var(--line);border-radius:15px;background:rgba(18,26,43,.78)}.insight-label{display:block;color:var(--muted);font-size:10px;font-weight:750;text-transform:uppercase;letter-spacing:.05em}.insight-value{display:block;margin-top:4px;color:var(--soft);font-size:14px;font-weight:800}.context-meter{height:5px;margin-top:9px;overflow:hidden;border-radius:99px;background:#26334d}.context-meter span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#8b9cff,#6f7fff)}.session-controls{margin:0 0 14px;padding:15px;border:1px solid rgba(139,156,255,.4);border-radius:20px;background:linear-gradient(145deg,rgba(29,40,72,.98),rgba(18,26,43,.98));box-shadow:0 14px 35px rgba(0,0,0,.2)}.controls-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}.controls-heading h2{margin:0;font-size:15px}.controls-heading p{margin:4px 0 0;color:var(--muted);font-size:11px;line-height:1.4}.control-grid{display:grid;gap:10px}.control-field{display:grid;gap:6px}.control-field>span,.toggle-row strong{color:var(--soft);font-size:11px;font-weight:750}.control-field select{width:100%;height:42px;padding:0 11px;border:1px solid var(--line);border-radius:12px;background:#0d1423;color:var(--soft);font-size:12px}.control-field small,.toggle-row small{color:var(--muted);font-size:10px;line-height:1.35}.control-note{padding:11px;border:1px dashed var(--line);border-radius:12px;color:var(--muted);font-size:11px;line-height:1.45}.toggle-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 11px;border:1px solid var(--line);border-radius:12px;background:rgba(13,20,35,.7)}.toggle-copy{display:grid;gap:3px}.toggle-row input{width:20px;height:20px;accent-color:var(--accent-strong)}.controls-actions{display:grid;grid-template-columns:1fr 1.25fr;gap:8px;margin-top:14px}.session-controls .primary,.session-controls .secondary{min-height:40px}@media (min-width:640px){main{padding-right:24px;padding-left:24px}.detail-topbar{margin-right:-24px;margin-left:-24px;padding-right:24px;padding-left:24px}.composer-wrap{padding-right:24px;padding-left:24px}.page-heading h1{font-size:36px}}
/* Mobile operations console: calm, light, and information-dense. */
:root{color-scheme:light;background:#f6f8fa;color:#1f2328;--bg:#f6f8fa;--panel:#fff;--panel-2:#f6f8fa;--line:#d0d7de;--muted:#656d76;--soft:#424a53;--accent:#0969da;--accent-strong:#0969da;--green:#1a7f37;--amber:#9a6700;--red:#cf222e}
body{background:#f6f8fa;color:#1f2328}
main{padding-bottom:104px}
.brand-mark{background:#1f2328;color:#fff;box-shadow:none}
.topbar{padding-top:14px}.eyebrow,.kicker{color:#656d76}.topbar-title{color:#1f2328}.icon-button,.back-button{border-color:#d0d7de;background:#fff;color:#57606a}.connection{border-color:#aceebb;background:#dafbe1;color:#1a7f37}.connection.offline{border-color:#d0d7de;background:#fff;color:#656d76}
.page-heading{padding:20px 0 16px}.page-heading h1{color:#1f2328}.subtitle{color:#656d76}.overview-card{border-color:#d0d7de;background:#d0d7de}.metric{background:#fff}.metric-value{color:#1f2328}.metric-label{color:#656d76}.toolbar{background:linear-gradient(#f6f8fa 72%,transparent)}.search-box input{border-color:#d0d7de;background:#fff;color:#1f2328}.filter{border-color:#d0d7de;background:#fff;color:#656d76}.filter.active{border-color:#54aeff;background:#ddf4ff;color:#0969da}
.section-header h2{color:#1f2328}.session-card{border-color:#d0d7de;background:#fff;box-shadow:0 1px 2px rgba(31,35,40,.04)}.session-card:hover{border-color:#54aeff;background:#fff}.session-card.attention{border-color:#d4a72c;background:#fff8c5}.session-icon{background:#ddf4ff;color:#0969da}.session-icon.working{background:#ddf4ff;color:#0969da}.session-icon.attention{background:#fff1b8;color:#9a6700}.session-title{color:#1f2328}.session-meta,.session-status{color:#656d76}.session-status.working{color:#0969da}.session-status.attention{color:#9a6700}.chevron{stroke:#8c959f}.empty-state{border-color:#d0d7de;background:#fff;color:#656d76}.empty-state strong{color:#424a53}
.detail-topbar{background:rgba(246,248,250,.94);border-color:#d8dee4}.detail-heading h1{color:#1f2328}.detail-heading p{color:#656d76}.detail-status{border-color:#d0d7de;background:#fff;color:#424a53}.detail-status.working{border-color:#54aeff;color:#0969da}.detail-status.attention{border-color:#d4a72c;color:#9a6700}.detail-control-button{border-color:#54aeff;background:#ddf4ff;color:#0969da}.session-insights .insight-card{border-color:#d0d7de;background:#fff}.insight-label,.control-field small,.toggle-row small{color:#656d76}.insight-value,.control-field>span,.toggle-row strong{color:#1f2328}.context-meter{background:#d8dee4}.context-meter span{background:#0969da}
.session-controls{border-color:#54aeff;background:#fff;box-shadow:0 8px 24px rgba(31,35,40,.08)}.controls-heading h2{color:#1f2328}.controls-heading p{color:#656d76}.control-field select{border-color:#d0d7de;background:#fff;color:#1f2328}.control-note{border-color:#d0d7de;color:#656d76}.toggle-row{border-color:#d0d7de;background:#f6f8fa}.secondary{border-color:#d0d7de;background:#f6f8fa;color:#424a53}.primary{background:#1f883d;color:#fff;box-shadow:none}.danger{border-color:#ff8182;background:#fff;color:#cf222e}
.message{border-color:#d0d7de;background:#fff;color:#1f2328}.message.user{border-color:#54aeff;background:#ddf4ff;color:#1f2328}.message-head{color:#656d76}.message-time{color:#8c959f}.message.system{border-color:#d4a72c;background:#fff8c5;color:#7d4e00}.tool-message{border-color:#d0d7de;background:#fff;color:#656d76}.tool-message .tool-body{color:#424a53}.composer-wrap{background:linear-gradient(transparent,rgba(246,248,250,.98) 22%)}.composer{border-color:#d0d7de;background:#fff;box-shadow:0 8px 24px rgba(31,35,40,.1)}.composer textarea{color:#1f2328}.send-button{background:#1f883d;color:#fff}.loading-card{border-color:#d0d7de;background:#fff;color:#656d76}.error-banner{border-color:#ff8182;background:#ffebe9;color:#cf222e}
.home-hero{padding:20px;border:1px solid #d0d7de;border-radius:20px;background:linear-gradient(135deg,#fff,#f1f8ff);box-shadow:0 1px 2px rgba(31,35,40,.04)}.home-hero h1{margin:5px 0 8px;color:#1f2328;font-size:26px;letter-spacing:-.04em}.home-hero p{margin:0;color:#656d76;font-size:13px;line-height:1.5}.home-section{margin-top:22px}.home-section .section-header{margin-bottom:10px}.section-link{padding:0;background:none;color:#0969da;font-size:12px;font-weight:700}.attention-summary{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid #d4a72c;border-radius:16px;background:#fff8c5;color:#7d4e00}.attention-summary strong{display:block;color:#7d4e00;font-size:14px}.attention-summary span{display:block;margin-top:3px;font-size:12px}.attention-summary .summary-icon{display:grid;place-items:center;flex:0 0 34px;width:34px;height:34px;border-radius:11px;background:#fff1b8;color:#9a6700;font-weight:800}.mini-session-list{display:grid;gap:8px}.bottom-nav{position:fixed;z-index:20;right:0;bottom:0;left:0;display:grid;grid-template-columns:repeat(3,1fr);max-width:760px;margin:0 auto;padding:8px 10px calc(8px + env(safe-area-inset-bottom));border-top:1px solid #d0d7de;background:rgba(255,255,255,.96);backdrop-filter:blur(16px)}.nav-item{position:relative;display:grid;justify-items:center;gap:4px;padding:5px 4px;border-radius:10px;background:none;color:#656d76;font-size:10px;font-weight:700}.nav-item svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.nav-item.active{color:#0969da;background:#ddf4ff}.nav-badge{position:absolute;top:1px;right:calc(50% - 18px);display:grid;place-items:center;min-width:16px;height:16px;padding:0 4px;border-radius:99px;background:#cf222e;color:#fff;font-size:9px}
.auth-card{border-color:#d0d7de;background:#fff;box-shadow:0 12px 32px rgba(31,35,40,.08)}.auth-card h1{color:#1f2328}.auth-card p{color:#656d76}.auth-card label{color:#424a53}.auth-card input{border-color:#d0d7de;background:#fff;color:#1f2328}.auth-card .primary{background:#1f883d;color:#fff}.primary:disabled,.secondary:disabled{cursor:not-allowed;opacity:.5}
.agent-actions{margin:0 0 14px;padding:14px;border:1px solid #d0d7de;border-radius:16px;background:#fff}.agent-actions-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.agent-actions-heading strong{display:block;margin-top:4px;color:#1f2328;font-size:14px}.agent-actions-heading>span{color:#656d76;font-size:11px}.action-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.action-button{min-height:40px;padding:9px 11px;border:1px solid #d0d7de;border-radius:11px;background:#f6f8fa;color:#424a53;font-size:12px;font-weight:750}.action-button:hover{border-color:#54aeff;color:#0969da}.action-button.danger-action{border-color:#ff8182;background:#fff;color:#cf222e}.action-note{grid-column:1/-1;padding:9px 10px;color:#656d76;font-size:11px}
.language-toggle{min-width:42px;height:36px;padding:0 9px;border:1px solid #d0d7de;border-radius:11px;background:#fff;color:#424a53;font-size:11px;font-weight:800}.language-toggle:hover{border-color:#54aeff;color:#0969da}.cove-button{width:auto;padding:0 10px;font-size:11px;font-weight:800;color:#0969da}.cove-button:hover{border-color:#54aeff;background:#ddf4ff}.auth-actions{display:flex;justify-content:flex-end;margin:-8px -6px 8px}
@media (min-width:640px){main{padding-bottom:112px}}

/* v2 mobile polish: chat ergonomics, markdown, tool grouping. */
html{-webkit-text-size-adjust:100%}
body{overscroll-behavior-y:none}
.topbar{position:sticky;top:0;z-index:12;margin:0 -16px;padding:calc(10px + env(safe-area-inset-top)) 16px 10px;background:rgba(246,248,250,.92);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
.session-list{gap:10px}
.session-card{grid-template-columns:38px minmax(0,1fr) 16px;gap:12px;min-height:66px;padding:12px 14px;border-radius:14px}
.session-card .chevron{width:16px;height:16px}
.session-icon{position:relative;width:38px;height:38px;border-radius:12px;font-size:16px}
.session-card.unread .session-icon:after{content:"";position:absolute;top:-3px;right:-3px;width:9px;height:9px;border:2px solid #fff;border-radius:50%;background:#0969da}
.session-title{font-size:14px;font-weight:650}
.session-meta{margin-top:3px;font-size:11.5px}
.session-status{margin-top:5px;font-size:11px}
.home-hero{padding:24px 20px;border-radius:22px}
.detail-topbar{z-index:15;padding-top:calc(10px + env(safe-area-inset-top))}
.detail-status{margin:14px 0 12px;padding:9px 13px;border-radius:999px;font-weight:650}
.detail-status .dot{flex:none}
.detail-status.working .dot{animation:pulse 1.2s infinite}
.conversation{gap:12px;padding:4px 0 128px}
.message{max-width:86%;padding:11px 13px;border-radius:16px;font-size:14px;line-height:1.6;box-shadow:0 1px 2px rgba(31,35,40,.04)}
.message.user{border-color:#0969da;background:#0969da;color:#fff;border-bottom-right-radius:6px}
.message.user .message-head{color:rgba(255,255,255,.85)}
.message.user .message-time{color:rgba(255,255,255,.7)}
.message.assistant,.message.summary{border-bottom-left-radius:6px}
.message.system{font-size:12px}
.message-head{margin-bottom:4px}
.md-inline{padding:1px 5px;border:1px solid #d8dee4;border-radius:6px;background:#eff1f3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;white-space:pre-wrap}
.message.user .md-inline{border-color:transparent;background:rgba(255,255,255,.18);color:#fff}
.md-code{display:block;margin:8px 0;padding:10px 12px;overflow-x:auto;border-radius:10px;background:#0d1117;color:#e6edf3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;white-space:pre}
.md-h{display:block;margin:6px 0 2px;font-size:1.05em}
.thinking-box{margin-top:8px;border:1px dashed #d0d7de;border-radius:10px;background:#f6f8fa;color:#656d76;font-size:12px}
.thinking-box summary{padding:7px 10px;cursor:pointer;list-style:none;font-weight:650}
.thinking-box summary::-webkit-details-marker{display:none}
.thinking-box .thinking{padding:0 10px 10px;white-space:pre-wrap;overflow-wrap:anywhere}
.tool-message{border-radius:12px;background:#fff}
.tool-message summary{display:flex;align-items:center;gap:8px;padding:9px 12px}
.tool-message summary:before{display:none}
.tool-summary-line{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;color:#424a53;font-size:12px}
.tool-status{flex:none;width:8px;height:8px;border-radius:50%;background:#1a7f37}
.tool-status.error{background:#cf222e}
.tool-status.running{background:#0969da;animation:pulse 1.2s infinite}
.tool-group{overflow:hidden;border:1px solid #d0d7de;border-radius:14px;background:#fff}
.tool-group>summary{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;list-style:none;color:#424a53;font-size:12px;font-weight:650}
.tool-group>summary::-webkit-details-marker{display:none}
.tool-group .group-icon{display:grid;place-items:center;flex:none;width:20px;height:20px;border-radius:6px;background:#ddf4ff;color:#0969da;font-size:11px}
.tool-group .group-hint{margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;color:#8c959f;font-size:11px;font-weight:500}
.tool-group-body{display:grid;border-top:1px solid #eaeef2}
.tool-group-body .tool-message{border:0;border-radius:0;background:#fafbfc}
.tool-group-body .tool-message+.tool-message{border-top:1px solid #eaeef2}
.composer-wrap{padding:10px 12px calc(12px + env(safe-area-inset-bottom))}
.composer{border-radius:22px;padding:6px 6px 6px 14px}
.composer textarea{min-height:40px;padding:9px 2px}
.send-button{flex:0 0 40px;width:40px;height:40px;border-radius:50%}
.nav-item{border-radius:12px}
.primary{border-radius:12px}

/* v2.1 overflow guards: stop iOS shrink-to-fit when tool content is long. */
html,body{overflow-x:clip}
.conversation>*{min-width:0}
.tool-message,.tool-group{max-width:100%;min-width:0}
.tool-group-body>*{min-width:0}
.tool-message summary,.tool-group>summary{overflow:hidden}
.tool-group>summary .group-hint{flex:1;min-width:0;text-align:right}
.tool-message .tool-body{overflow-x:auto}
.md-code{max-width:100%}
.message,.message-body{min-width:0}
.detail-heading .back-button,.detail-actions,.detail-actions>*{flex:none}
.detail-control-button{white-space:nowrap}

/* v2.2 settings as a mobile bottom sheet. */
.controls-overlay{position:fixed;inset:0;z-index:40;display:flex;align-items:flex-end;justify-content:center;background:rgba(31,35,40,.42);animation:fadeIn .18s ease}
.controls-sheet{width:100%;max-width:640px;max-height:82vh;overflow-y:auto;overscroll-behavior:contain;animation:slideUp .22s ease}
.controls-sheet .session-controls{margin:0;padding-bottom:calc(16px + env(safe-area-inset-bottom));border-bottom:0;border-radius:22px 22px 0 0;box-shadow:0 -12px 40px rgba(0,0,0,.18)}
.controls-sheet .controls-heading{position:sticky;top:0;z-index:1;margin:0 -15px;padding:6px 15px 12px;background:#fff;border-radius:22px 22px 0 0}
.controls-sheet .controls-heading:before{content:"";display:block;width:36px;height:4px;margin:0 auto 10px;border-radius:99px;background:#d0d7de}
@keyframes fadeIn{from{opacity:0}}
@keyframes slideUp{from{transform:translateY(32px);opacity:.5}}

/* v2.3 agent identity, stop control, date dividers, copy toast, approval sheet. */
.session-icon.acp{background:#ddf4ff;color:#0969da}
.session-icon.claude{background:#fbe9e2;color:#b45309}
.session-icon.codex{background:#d9f5e5;color:#0a7d5d}
.session-icon.attention{background:#fff1b8;color:#9a6700}
.engine-badge{display:inline-block;margin-right:5px;padding:1px 6px;border-radius:6px;background:#ddf4ff;color:#0969da;font-size:9px;font-weight:800;letter-spacing:.05em;vertical-align:1px}
.engine-badge.claude{background:#fbe9e2;color:#b45309}
.engine-badge.codex{background:#d9f5e5;color:#0a7d5d}
.send-button.stop{flex:0 0 40px;width:40px;height:40px;border:1.5px solid #cf222e;border-radius:50%;background:#fff;color:#cf222e}
.date-divider{justify-self:center;margin:2px 0}
.date-divider span{padding:3px 10px;border-radius:99px;background:#eaeef2;color:#656d76;font-size:10px;font-weight:700}
.copy-toast{position:fixed;left:50%;bottom:110px;z-index:60;padding:8px 14px;border-radius:99px;background:#1f2328;color:#fff;font-size:12px;font-weight:650;transform:translate(-50%,8px);opacity:0;pointer-events:none;transition:opacity .18s,transform .18s}
.copy-toast.show{opacity:1;transform:translate(-50%,0)}
.approval-overlay{z-index:45}
.approval-overlay .approval-panel{position:static;margin:0;border-bottom:0;border-radius:22px 22px 0 0;box-shadow:0 -12px 40px rgba(0,0,0,.18)}

/* v2.4 real agent logos, aligned with the desktop registry design. */
.session-icon .agent-logo{width:20px;height:20px;object-fit:contain}
.detail-heading .agent-logo{width:16px;height:16px;border-radius:4px;object-fit:contain;vertical-align:-3px;margin-right:6px}
.agent-logo-emoji{font-size:17px;line-height:1}
.session-icon .agent-logo-emoji{font-size:19px}
.engine-name{margin-right:6px;color:#656d76;font-size:10px;font-weight:700;letter-spacing:.02em}

`;

const REMOTE_CLIENT_JS = `(() => {
const root=document.getElementById("app");
const params=new URLSearchParams(location.search);
let token=params.get("token")||localStorage.getItem("harnss-remote-token")||"";
if(token){localStorage.setItem("harnss-remote-token",token);history.replaceState(null,"","/");}
let isZh=(localStorage.getItem("harnss-remote-language")||(/^(zh)/i.test(navigator.language||"")?"zh":"en"))==="zh";
document.documentElement.lang=isZh?"zh-CN":"en";
const text=(en,zh)=>isZh?zh:en;
const createLabels=()=>({
  app:text("Remote control","远程控制"),overview:text("Overview","总览"),sessions:text("Sessions","会话"),approvals:text("Approvals","审批"),cove:text("COVE Voice","COVE 语音"),refresh:text("Refresh","刷新"),connected:text("Live","已连接"),
  offline:text("Offline","离线"),all:text("All","全部"),working:text("Working","运行中"),approval:text("Needs approval","待审批"),
  active:text("active","运行中"),needsAttention:text("needs attention","待处理"),noSessions:text("No sessions yet","暂无会话"),
  noSessionsHint:text("Start an agent session in Harnss to see it here.","在 Harnss 中启动一个代理会话后，它会显示在这里。"),
  search:text("Search sessions","搜索会话"),recent:text("Your sessions","你的会话"),select:text("Select a session to view its conversation.","选择一个会话查看对话。"),
  back:text("Back to sessions","返回会话"),workingNow:text("Agent is working","代理正在工作"),idle:text("Idle","空闲"),waiting:text("Waiting for your approval","等待你的审批"),
  you:text("You","你"),assistant:text("Assistant","助手"),system:text("System","系统"),summary:text("Summary","摘要"),tool:text("Tool activity","工具活动"),subagentProgress:text("Agent progress","代理进度"),steps:text("steps","步"),send:text("Send message","发送消息"),thoughts:text("Thinking","思考过程"),toolsRun:text("tools","个工具"),
  connectTitle:text("Connect to Harnss","连接到 Harnss"),connectBody:text("Enter the pairing token from Harnss → Settings → General → Remote Control. It stays on this device.","输入 Harnss → 设置 → 常规 → 远程控制中的配对 Token。Token 只保存在此设备。"),
  token:text("Pairing token","配对 Token"),connect:text("Connect","连接"),invalidToken:text("That token was rejected. Check the token in Harnss and try again.","Token 无效，请检查 Harnss 中的配对 Token 后重试。"),
  permission:text("Permission required","需要权限"),allow:text("Allow","允许"),allowSession:text("Allow session","本会话允许"),deny:text("Deny","拒绝"),
  answer:text("Answer","回答"),older:text("Older messages omitted","较早消息已省略"),noMessage:text("No messages yet","暂无消息"),loading:text("Loading…","加载中…"),
  tokenRequired:text("Enter a pairing token to continue.","请输入配对 Token 继续。"),
  controls:text("Controls","控制"),model:text("Model","模型"),permissionMode:text("Permission mode","权限模式"),acpPermission:text("ACP permissions","ACP 权限"),acpAsk:text("Ask before tools","工具调用前询问"),acpAutoAccept:text("Auto accept","自动接受"),acpAllowAll:text("Allow all","全部允许"),
  agentActions:text("Agent actions","代理操作"),openSession:text("Open session","打开会话"),retry:text("Retry last message","重试上一条"),stop:text("Stop agent","停止代理"),settings:text("Model & permissions","模型与权限"),configHint:text("Send or retry a turn to load this agent's live controls.","发送或重试一次对话后，加载此 agent 的实时配置。"),
  planMode:text("Plan mode","计划模式"),planHint:text("Review the plan before changes","先审阅计划再修改"),apply:text("Apply changes","应用更改"),cancel:text("Cancel","取消"),
  context:text("Context","上下文"),cost:text("Cost","费用"),noModelOptions:text("Model list unavailable","模型列表暂不可用"),
  settingsHint:text("Changes apply to this session","更改仅应用于此会话"),defaultModel:text("Default model","默认模型"),today:text("Today","今天"),needsAction:text("Needs your attention","需要你的处理"),allClear:text("All clear","一切正常"),allClearHint:text("No approvals are waiting right now.","当前没有等待处理的审批。"),recentActivity:text("Recent activity","最近活动"),seeAll:text("See all","查看全部"),overviewTitle:text("Good to see you.","今天，一切尽在掌控。"),overviewHint:text("A quick view of your agents and the work that needs you next.","快速查看代理状态，以及下一步需要你处理的事项。"),
  askFirst:text("Ask before edits","编辑前询问"),acceptEdits:text("Accept edits","自动接受编辑"),allowAll:text("Allow all","全部允许"),effort:text("Reasoning effort","推理强度"),
  effortLow:text("Low","低"),effortMedium:text("Medium","中"),effortHigh:text("High","高"),effortMax:text("Max","最高"),agentOptions:text("Agent options","代理配置"),configUnavailable:text("No live configuration options are available for this agent.","此代理当前没有可用的实时配置选项。"),copied:text("Copied","已复制")
});
let labels=createLabels();
const languageToggleHtml=()=>'<button type="button" class="language-toggle" data-language-toggle aria-label="'+(isZh?"Switch to English":"切换到中文")+'">'+(isZh?"EN":"中文")+'</button>';
const setLanguage=(language)=>{isZh=language==="zh";labels=createLabels();localStorage.setItem("harnss-remote-language",isZh?"zh":"en");document.documentElement.lang=isZh?"zh-CN":"en";render()};
const bindLanguageToggle=()=>{const button=document.querySelector("[data-language-toggle]");if(button)button.onclick=()=>setLanguage(isZh?"en":"zh")};
const esc=(v)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const icon=(name)=>name==="search"?'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>':name==="arrow"?'<svg class="chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13"></path><path d="m13 6 6 6-6 6"></path></svg>':name==="stop"?'<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"></rect></svg>':name==="back"?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>':name==="refresh"?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-14.9-4L3 10"></path><path d="M3 4v6h6"></path><path d="M4 13a8.1 8.1 0 0 0 14.9 4L21 14"></path><path d="M21 20v-6h-6"></path></svg>':name==="home"?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-7 9 7"></path><path d="M5 9v11h14V9"></path><path d="M9 20v-6h6v6"></path></svg>':name==="list"?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13"></path><path d="M8 12h13"></path><path d="M8 18h13"></path><path d="M3 6h.01"></path><path d="M3 12h.01"></path><path d="M3 18h.01"></path></svg>':name==="bell"?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M10 21h4"></path></svg>':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>';
const engineMeta=(engine)=>engine==="acp"?{label:"ACP",cls:"acp"}:engine==="codex"?{label:"Codex",cls:"codex"}:{label:"Claude",cls:"claude"};
const localAgentIcon=url=>{const marker="cdn.agentclientprotocol.com/registry/";const at=url.indexOf(marker);if(at<0)return url;const file=url.slice(at+marker.length).split("/").pop();return /^[\\w-]+\\.svg$/.test(file)?"/agent-icons/"+file:url};
const agentMark=(session,fallback)=>{const icon=session.engineIcon;if(!icon)return fallback;if(/^https?:/.test(icon))return'<img class="agent-logo" src="'+esc(localAgentIcon(icon))+'" alt="" draggable="false">';if(icon.codePointAt(0)>255)return'<span class="agent-logo-emoji">'+esc(icon)+'</span>';return fallback};
const engineTag=(session)=>{const meta=engineMeta(session.engine);const mark=agentMark(session,"");return mark?mark+'<span class="engine-name">'+meta.label+'</span>':'<span class="engine-badge '+meta.cls+'">'+meta.label+'</span>'};
const sessions=[]; const snapshots=new Map(); let selectedId=null; let previousView="overview"; let view="overview"; let search=""; let filter="all"; let loading=false; let connected=false; let socket=null; let reconnectTimer=null; let sessionRefreshTimer=null; let renderFrame=0; let controlsOpen=false; let detailSessionId=null; let detailStructureKey="";
const scheduleRender=()=>{if(renderFrame)return;renderFrame=requestAnimationFrame(()=>{renderFrame=0;render()})};
const summaryFor=(snapshot)=>snapshot.session;
const statusFor=(session)=>session.hasPendingPermission?"attention":session.isProcessing?"working":"idle";
const statusText=(session)=>statusFor(session)==="attention"?labels.approval:statusFor(session)==="working"?labels.working:labels.idle;
const sessionRank=(session)=>session.hasPendingPermission?0:session.isProcessing?1:2;
const relativeTime=(timestamp)=>{if(!timestamp)return"";const delta=Math.max(0,Date.now()-timestamp);if(delta<60e3)return text("just now","刚刚");if(delta<3600e3)return Math.floor(delta/60e3)+text("m ago","分钟前");if(delta<86400e3)return Math.floor(delta/3600e3)+text("h ago","小时前");return new Date(timestamp).toLocaleDateString(isZh?"zh-CN":"en-US",{month:"short",day:"numeric"})};
const api=async(path,options={})=>{const headers=Object.assign({"content-type":"application/json"},options.headers||{});if(token)headers.authorization="Bearer "+token;const response=await fetch(path,Object.assign({},options,{headers}));const raw=await response.text();let body={};try{body=raw?JSON.parse(raw):{}}catch{}if(response.status===401){throw Error("AUTH_REQUIRED")}if(!response.ok)throw Error(body.error||text("Request failed","请求失败"));return body};
const upsertSession=(session)=>{const index=sessions.findIndex(item=>item.id===session.id);if(index===-1)sessions.push(session);else sessions[index]=session};
const selectedSnapshot=()=>selectedId?snapshots.get(selectedId):null;
const modelLabel=(value,models=[])=>{const option=models.find(item=>item.value===value);return option?.displayName||(!value||value==="default"?labels.defaultModel:value)};
const permissionLabel=(value)=>value==="acceptEdits"?labels.acceptEdits:value==="bypassPermissions"?labels.allowAll:labels.askFirst;
function contextHtml(snapshot){const usage=snapshot.contextUsage;const hasCost=Number(snapshot.totalCost)>0;if(!usage&&!hasCost)return"";const used=usage?Math.min(usage.contextWindow,usage.inputTokens+usage.cacheReadTokens+usage.cacheCreationTokens):0;const percent=usage&&usage.contextWindow>0?Math.round(used/usage.contextWindow*100):0;return'<section class="session-insights">'+(usage?'<div class="insight-card"><span class="insight-label">'+labels.context+'</span><span class="insight-value">'+percent+'%</span><div class="context-meter"><span style="width:'+percent+'%"></span></div></div>':"")+(hasCost?'<div class="insight-card"><span class="insight-label">'+labels.cost+'</span><span class="insight-value">$'+Number(snapshot.totalCost).toFixed(3)+'</span></div>':"")+'</section>'}
function sessionControlsHtml(snapshot){const session=snapshot.session,models=session.availableModels||[],configOptions=session.availableConfigOptions||[],selectedModel=session.model||"default",mode=session.permissionMode||"default",acpBehavior=session.acpPermissionBehavior||"ask",selectedOption=models.find(item=>item.value===selectedModel),effortOptions=selectedOption?.supportedEffortLevels?.length?selectedOption.supportedEffortLevels:(selectedOption?.supportsEffort?["low","medium","high","max"]:[]),selectedEffort=session.effort||selectedOption?.defaultReasoningEffort||effortOptions[1]||effortOptions[0]||"",isAcp=session.engine==="acp",canApply=!isAcp||configOptions.length>0||!!session.acpPermissionBehavior;const modelOptions=models.length?models.map(model=>'<option value="'+esc(model.value)+'" '+(model.value===selectedModel?'selected':'')+'>'+esc(model.displayName)+(model.description?' · '+esc(model.description):'')+'</option>').join(""):('<option value="'+esc(selectedModel)+'" selected>'+esc(modelLabel(selectedModel))+'</option>');const modelField=isAcp?"":'<label class="control-field"><span>'+labels.model+'</span><select id="settings-model">'+modelOptions+'</select></label>';const effortField=effortOptions.length&&!isAcp?'<label class="control-field"><span>'+labels.effort+'</span><select id="settings-effort">'+effortOptions.map(value=>'<option value="'+esc(value)+'" '+(value===selectedEffort?'selected':'')+'>'+esc(value==="low"?labels.effortLow:value==="medium"?labels.effortMedium:value==="high"?labels.effortHigh:value==="max"?labels.effortMax:value)+'</option>').join("")+'</select></label>':"";const acpFields=configOptions.length?configOptions.map(option=>{const values=(option.options||[]).flatMap(item=>Array.isArray(item.options)?item.options:[item]);return'<label class="control-field"><span>'+esc(option.name)+'</span><select data-config-id="'+esc(option.id)+'">'+values.map(value=>'<option value="'+esc(value.value)+'" '+(value.value===option.currentValue?'selected':'')+'>'+esc(value.name)+(value.description?' · '+esc(value.description):'')+'</option>').join("")+'</select></label>'}).join(""):('<div class="control-note">'+labels.configUnavailable+'</div>');const acpPermissionField=isAcp?'<label class="control-field"><span>'+labels.acpPermission+'</span><select id="settings-acp-permission"><option value="ask" '+(acpBehavior==="ask"?'selected':'')+'>'+labels.acpAsk+'</option><option value="auto_accept" '+(acpBehavior==="auto_accept"?'selected':'')+'>'+labels.acpAutoAccept+'</option><option value="allow_all" '+(acpBehavior==="allow_all"?'selected':'')+'>'+labels.acpAllowAll+'</option></select></label>':"";return'<section class="session-controls"><div class="controls-heading"><div><h2>'+labels.controls+'</h2><p>'+labels.settingsHint+'</p></div><button type="button" class="detail-control-button" id="controls-close">'+labels.cancel+'</button></div><form id="settings-form"><div class="control-grid">'+(isAcp?acpPermissionField+acpFields:modelField+effortField+'<label class="control-field"><span>'+labels.permissionMode+'</span><select id="settings-permission"><option value="default" '+(mode==="default"?'selected':'')+'>'+labels.askFirst+'</option><option value="acceptEdits" '+(mode==="acceptEdits"?'selected':'')+'>'+labels.acceptEdits+'</option><option value="bypassPermissions" '+(mode==="bypassPermissions"?'selected':'')+'>'+labels.allowAll+'</option></select></label><label class="toggle-row"><span class="toggle-copy"><strong>'+labels.planMode+'</strong><small>'+labels.planHint+'</small></span><input id="settings-plan" type="checkbox" '+(session.planMode?'checked':'')+'></label>')+'</div><div class="controls-actions"><button type="button" class="secondary" id="controls-cancel">'+labels.cancel+'</button><button type="submit" class="primary" '+(canApply?"":"disabled")+'>'+labels.apply+'</button></div></form></section>'}
function authScreen(message=""){root.innerHTML='<div class="auth-screen"><section class="auth-card"><div class="auth-actions">'+languageToggleHtml()+'</div><div class="brand-mark">H</div><p class="eyebrow">HARNSS REMOTE</p><h1>'+labels.connectTitle+'</h1><p>'+labels.connectBody+'</p>'+(message?'<div class="error-banner">'+esc(message)+'</div>':'')+'<form id="token-form"><label for="token">'+labels.token+'</label><input id="token" type="password" autocomplete="current-password" placeholder="'+labels.token+'" required><button class="primary" type="submit">'+labels.connect+'</button></form></section></div>';bindLanguageToggle();const form=document.getElementById("token-form");form.onsubmit=(event)=>{event.preventDefault();const value=document.getElementById("token").value.trim();if(!value)return;token=value;localStorage.setItem("harnss-remote-token",token);history.replaceState(null,"","/");boot()};}
function connectionHtml(){return'<div class="connection '+(connected?"":"offline")+'"><span class="dot"></span>'+ (connected?labels.connected:labels.offline)+'</div>'}
function sessionCard(session){const status=statusFor(session), title=session.title||text("Untitled session","未命名会话");return'<button class="session-card '+(status==="attention"?"attention":"")+(session.hasUnreadCompletion?" unread":"")+'" data-session-id="'+esc(session.id)+'"><span class="session-icon '+status+' '+engineMeta(session.engine).cls+'">'+(status==="attention"?"!":agentMark(session,engineMeta(session.engine).label.charAt(0)))+'</span><span class="session-copy"><span class="session-title">'+esc(title)+'</span><span class="session-meta">'+esc(session.projectName||session.projectId||"")+' · '+esc(modelLabel(session.model||session.engine||"agent"))+(session.lastMessageAt?" · "+relativeTime(session.lastMessageAt):"")+'</span><span class="session-status '+status+'"><span class="dot"></span>'+statusText(session)+'</span></span>'+icon("arrow")+'</button>'}
function navHtml(active,attention){return'<nav class="bottom-nav" aria-label="'+labels.app+'"><button class="nav-item '+(active==="overview"?"active":"")+'" data-view="overview">'+icon("home")+'<span>'+labels.overview+'</span></button><button class="nav-item '+(active==="sessions"?"active":"")+'" data-view="sessions">'+icon("list")+'<span>'+labels.sessions+'</span></button><button class="nav-item '+(active==="approvals"?"active":"")+'" data-view="approvals">'+icon("bell")+(attention?'<span class="nav-badge">'+attention+'</span>':"")+'<span>'+labels.approvals+'</span></button></nav>'}
function matchesSession(session,query){return!query||[session.title,session.projectName,session.projectId,session.engine,session.model].some(value=>String(value||"").toLowerCase().includes(query))}
function orderedSessions(items){return items.slice().sort((a,b)=>(sessionRank(a)-sessionRank(b))||((b.lastMessageAt||b.createdAt||0)-(a.lastMessageAt||a.createdAt||0)))}
function listMarkup(items){return items.length?'<section class="session-list">'+orderedSessions(items).map(sessionCard).join("")+'</section>':'<div class="empty-state"><strong>'+labels.noSessions+'</strong>'+labels.noSessionsHint+'</div>'}
function renderList(){const active=sessions.filter(session=>session.isProcessing).length,attention=sessions.filter(session=>session.hasPendingPermission).length;const query=search.trim().toLowerCase();const matching=sessions.filter(session=>matchesSession(session,query));const filtered=matching.filter(session=>filter==="all"||(filter==="working"&&session.isProcessing)||(filter==="approval"&&session.hasPendingPermission));const recent=orderedSessions(matching).slice(0,3);let body="";if(view==="overview"){const attentionBody=attention?'<button class="attention-summary" data-view="approvals"><span class="summary-icon">!</span><span><strong>'+attention+" "+labels.approval+'</strong><span>'+labels.needsAction+'</span></span>'+icon("arrow")+'</button>':'<div class="attention-summary"><span class="summary-icon">✓</span><span><strong>'+labels.allClear+'</strong><span>'+labels.allClearHint+'</span></span></div>';body='<section class="home-hero"><p class="kicker">'+labels.today+'</p><h1>'+labels.overviewTitle+'</h1><p>'+labels.overviewHint+'</p></section><section class="overview-card"><div class="metric"><span class="metric-value">'+sessions.length+'</span><span class="metric-label">'+labels.sessions+'</span></div><div class="metric"><span class="metric-value">'+active+'</span><span class="metric-label">'+labels.active+'</span></div><div class="metric"><span class="metric-value">'+attention+'</span><span class="metric-label">'+labels.needsAttention+'</span></div></section><section class="home-section"><div class="section-header"><h2>'+labels.needsAction+'</h2><span>'+attention+'</span></div>'+attentionBody+'</section><section class="home-section"><div class="section-header"><h2>'+labels.recentActivity+'</h2><button class="section-link" data-view="sessions">'+labels.seeAll+'</button></div>'+listMarkup(recent)+'</section>'}else{const title=view==="approvals"?labels.approvals:labels.sessions;const list=view==="approvals"?filtered.filter(session=>session.hasPendingPermission):filtered;body='<section class="page-heading"><p class="kicker">'+labels.app+'</p><h1>'+title+'</h1><p class="subtitle">'+(view==="approvals"?labels.needsAction:text("Monitor every agent from one place.","从一个地方掌控所有代理。"))+'</p></section>'+(view==="sessions"?'<div class="toolbar"><label class="search-box">'+icon("search")+'<input id="search" type="search" value="'+esc(search)+'" placeholder="'+labels.search+'" autocomplete="off"></label><div class="filters"><button class="filter '+(filter==="all"?"active":"")+'" data-filter="all">'+labels.all+'</button><button class="filter '+(filter==="working"?"active":"")+'" data-filter="working">'+labels.working+'</button><button class="filter '+(filter==="approval"?"active":"")+'" data-filter="approval">'+labels.approval+'</button></div></div>':"")+'<div class="section-header"><h2>'+title+'</h2><span>'+list.length+'</span></div>'+(loading&&!sessions.length?'<div class="loading-card">'+labels.loading+'</div>':listMarkup(list))}root.innerHTML='<div class="topbar"><div class="brand-lockup"><div class="brand-mark">H</div><div><p class="eyebrow">HARNSS</p><p class="topbar-title">'+labels.app+'</p></div></div><div class="topbar-actions">'+languageToggleHtml()+connectionHtml()+'<button class="icon-button cove-button" id="cove" type="button" title="'+labels.cove+'">'+labels.cove+'</button><button class="icon-button" id="refresh" aria-label="'+labels.refresh+'" title="'+labels.refresh+'">'+icon("refresh")+'</button></div></div>'+body+navHtml(view,attention);bindLanguageToggle();document.getElementById("cove").onclick=()=>{location.href="/cove/"};document.getElementById("refresh").onclick=()=>loadSessions();document.querySelectorAll("[data-view]").forEach(button=>button.onclick=()=>{view=button.dataset.view;renderList()});if(view==="sessions"){const searchInput=document.getElementById("search");searchInput.oninput=event=>{search=event.target.value;renderList();const next=document.getElementById("search");next.focus();next.setSelectionRange(search.length,search.length)}}document.querySelectorAll("[data-filter]").forEach(button=>button.onclick=()=>{filter=button.dataset.filter;renderList()});document.querySelectorAll("[data-session-id]").forEach(button=>button.onclick=()=>selectSession(button.dataset.sessionId))}

function taskProgressHtml(message){const steps=message.subagentSteps||[];if(!steps.length)return"";const completed=steps.filter(step=>step.status==="completed").length,percent=message.subagentStatus==="completed"?100:Math.round(completed/steps.length*100);return'<div class="task-progress"><div class="task-progress-head"><span>'+labels.subagentProgress+'</span><span>'+completed+'/'+steps.length+" "+labels.steps+'</span></div><div class="task-progress-bar"><span style="width:'+percent+'%"></span></div><div class="task-steps">'+steps.map(step=>'<div class="task-step '+(step.status==="completed"?"done":step.status==="error"?"error":"")+'">'+esc(step.toolName)+'</div>').join("")+'</div></div>'}
function mdLite(src){let s=esc(src);const tick=String.fromCharCode(96);s=s.replace(new RegExp(tick+tick+tick+"[\\\\w-]*\\\\n?([\\\\s\\\\S]*?)"+tick+tick+tick,"g"),function(_,code){return'<pre class="md-code">'+code.replace(/\\n+$/,"")+'</pre>'});s=s.replace(new RegExp(tick+"([^"+tick+"\\n]+)"+tick,"g"),'<code class="md-inline">$1</code>');s=s.replace(/\\*\\*([^*\\n]+)\\*\\*/g,'<strong>$1</strong>');s=s.replace(/^#{1,3} +(.+)$/gm,'<strong class="md-h">$1</strong>');return s}
function messageHtml(message){const content=message.displayContent||message.content||message.toolSummary||"";const role=message.role==="user"?labels.you:message.role==="assistant"?labels.assistant:message.role==="system"?labels.system:message.role==="summary"?labels.summary:labels.tool;if(message.role==="tool_call"||message.role==="tool_result")return toolMessageHtml(message);const rich=message.role!=="user";const body='<div class="message-head"><span>'+role+'</span><span class="message-time">'+relativeTime(message.timestamp)+'</span></div><div class="message-body">'+(rich?mdLite(content):esc(content))+'</div>'+(message.thinking?'<details class="thinking-box"><summary>'+labels.thoughts+'</summary><div class="thinking">'+esc(message.thinking)+'</div></details>':'');return'<article class="message '+esc(message.role)+(message.isStreaming?" streaming":"")+'">'+body+'</article>'}
function toolMessageHtml(message){const status=message.toolError?"error":message.subagentStatus==="running"?"running":"done";return'<details class="tool-message"><summary><span class="tool-status '+status+'"></span><span class="tool-summary-line">'+esc(message.toolName||labels.tool)+(message.toolSummary?" · "+esc(message.toolSummary):"")+'</span></summary>'+taskProgressHtml(message)+'<div class="tool-body">'+esc(message.content||message.toolSummary||text("No details available","暂无详细信息"))+'</div></details>'}
function conversationHtml(messages){const parts=[];let i=0,lastDay="";const dayOf=ts=>{const d=new Date(ts||0);return d.getFullYear()+"-"+d.getMonth()+"-"+d.getDate()};const dayLabel=ts=>new Date(ts||Date.now()).toLocaleDateString(isZh?"zh-CN":"en-US",{month:"short",day:"numeric"});const pushDivider=ts=>{const key=dayOf(ts);if(key!==lastDay){lastDay=key;parts.push('<div class="date-divider"><span>'+dayLabel(ts)+'</span></div>')}};while(i<messages.length){const message=messages[i];if(message.role==="tool_call"||message.role==="tool_result"){const run=[];while(i<messages.length&&(messages[i].role==="tool_call"||messages[i].role==="tool_result")){run.push(messages[i]);i++}pushDivider(run[0].timestamp);parts.push(run.length===1?toolMessageHtml(run[0]):'<details class="tool-group"><summary><span class="group-icon">⚙</span>'+run.length+" "+labels.toolsRun+'<span class="group-hint">'+esc(run[run.length-1].toolName||"")+'</span></summary><div class="tool-group-body">'+run.map(toolMessageHtml).join("")+'</div></details>');continue}pushDivider(message.timestamp);parts.push(messageHtml(message));i++}return parts.join("")}
function questionHtml(question){const options=question.options||[];return'<div class="approval-question"><label>'+esc(question.header||question.question)+'</label>'+(options.length?'<div class="choice-group">'+options.map(option=>'<button type="button" class="choice" data-question="'+esc(question.id)+'" data-value="'+esc(option.label)+'" data-multi="'+(question.multiSelect?"true":"false")+'">'+esc(option.label)+(option.description?'<br><span>'+esc(option.description)+'</span>':'')+'</button>').join("")+'</div>':'<input class="answer-input" data-answer-input="'+esc(question.id)+'" placeholder="'+labels.answer+'">')+'</div>'}
function approvalHtml(permission){const title=permission.kind==="user-input"?labels.answer:labels.permission;return'<section class="approval-panel"><div class="approval-header"><div class="approval-icon">!</div><div><h2>'+title+(permission.toolName?": "+esc(permission.toolName):"")+'</h2>'+(permission.summary?'<p>'+esc(permission.summary)+'</p>':'')+'</div></div>'+(permission.questions||[]).map(questionHtml).join("")+'<div class="approval-actions"><button type="button" class="danger" id="deny">'+labels.deny+'</button><button type="button" class="secondary" id="allow-session">'+labels.allowSession+'</button><button type="button" class="primary" id="allow">'+labels.allow+'</button></div></section>'}
function agentActionsHtml(snapshot){const session=snapshot.session,hasLastUser=snapshot.messages.some(message=>message.role==="user"),buttons=[];if(snapshot.isProcessing)buttons.push('<button type="button" class="action-button danger-action" data-agent-action="interrupt">'+labels.stop+'</button>');if(!snapshot.isConnected)buttons.push('<button type="button" class="action-button" data-agent-action="activate">'+labels.openSession+'</button>');if(hasLastUser&&!snapshot.isProcessing)buttons.push('<button type="button" class="action-button" data-agent-action="retry">'+labels.retry+'</button>');return'<section class="agent-actions"><div class="agent-actions-heading"><div><p class="kicker">'+labels.agentActions+'</p><strong>'+esc(session.engine==="acp"?"ACP":session.engine==="codex"?"Codex":"Claude")+'</strong></div><span>'+statusText(session)+'</span></div><div class="action-grid">'+(buttons.length?buttons.join(""):'<span class="action-note">'+labels.allClearHint+'</span>')+'</div></section>'}
function renderDetail(){const previousField=document.getElementById("message"),previousDraft=previousField?.value,previousSelectionStart=previousField?.selectionStart,previousSelectionEnd=previousField?.selectionEnd,previousScroll=previousField?window.scrollY:null;const followLatest=previousScroll===null||document.documentElement.scrollHeight-(previousScroll+window.innerHeight)<160;const current=selectedSnapshot(),summary=sessions.find(session=>session.id===selectedId)||current?.session;if(!summary){selectedId=null;detailSessionId=null;detailStructureKey="";renderList();return}if(!current){detailSessionId=selectedId;detailStructureKey="loading";root.innerHTML='<div class="detail-topbar"><div class="detail-heading"><button class="back-button" id="back" aria-label="'+labels.back+'">'+icon("back")+'</button><div class="detail-heading-copy"><h1>'+esc(summary.title)+'</h1><p>'+esc(summary.projectName||summary.projectId||"")+'</p></div></div></div><div class="loading-card">'+labels.loading+'</div>';document.getElementById("back").onclick=()=>{selectedId=null;detailSessionId=null;view=previousView;renderList()};return}const status=statusFor(current.session);const structureKey=[controlsOpen?1:0,current.pendingPermission?1:0,current.isProcessing?1:0,status,current.truncated?1:0,Math.round(Number(current.totalCost||0)*1000),current.contextUsage?JSON.stringify(current.contextUsage):"",current.isConnected?1:0].join(":");if(detailSessionId===selectedId&&detailStructureKey===structureKey){const conversation=document.querySelector(".conversation");if(conversation){const distance=previousScroll===null?0:document.documentElement.scrollHeight-(previousScroll+window.innerHeight);conversation.innerHTML=(current.truncated?'<div class="empty-state">'+labels.older+'</div>':"")+(current.messages.length?conversationHtml(current.messages):'<div class="empty-state">'+labels.noMessage+'</div>');if(followLatest)requestAnimationFrame(()=>window.scrollTo({top:document.documentElement.scrollHeight,behavior:"auto"}));else if(previousScroll!==null)window.scrollTo(0,document.documentElement.scrollHeight-window.innerHeight-distance)}return}detailSessionId=selectedId;detailStructureKey=structureKey;root.innerHTML='<div class="detail-topbar"><div class="detail-heading"><button class="back-button" id="back" aria-label="'+labels.back+'">'+icon("back")+'</button><div class="detail-heading-copy"><h1>'+esc(current.session.title)+'</h1><p>'+engineTag(current.session)+esc(current.session.projectName||current.session.projectId||"")+' · '+esc(modelLabel(current.session.model,current.session.availableModels||[]))+'</p></div><div class="detail-actions">'+languageToggleHtml()+'<button class="detail-control-button" id="controls-toggle" type="button">'+labels.settings+'</button><button class="icon-button" id="detail-refresh" aria-label="'+labels.refresh+'">'+icon("refresh")+'</button></div></div></div><div class="detail-status '+status+'"><span class="dot"></span>'+statusText(current.session)+(current.totalCost?' · $'+Number(current.totalCost).toFixed(3):"")+'</div>'+agentActionsHtml(current)+(controlsOpen?'<div class="controls-overlay" id="controls-overlay"><div class="controls-sheet">'+sessionControlsHtml(current)+'</div></div>':"")+contextHtml(current)+(current.pendingPermission?'<div class="controls-overlay approval-overlay"><div class="controls-sheet">'+approvalHtml(current.pendingPermission)+'</div></div>':"")+'<section class="conversation">'+(current.truncated?'<div class="empty-state">'+labels.older+'</div>':"")+(current.messages.length?conversationHtml(current.messages):'<div class="empty-state">'+labels.noMessage+'</div>')+'</section><div class="composer-wrap"><form class="composer" id="send-form">'+(current.isProcessing?'<button class="send-button stop" type="button" id="stop-button" aria-label="'+labels.stop+'">'+icon("stop")+'</button>':"")+'<textarea id="message" rows="1" placeholder="'+labels.send+'" required></textarea><button class="send-button" type="submit" aria-label="'+labels.send+'">'+icon("arrow")+'</button></form></div>';bindLanguageToggle();document.getElementById("back").onclick=()=>{selectedId=null;detailSessionId=null;controlsOpen=false;view=previousView;renderList()};document.getElementById("controls-toggle").onclick=()=>{controlsOpen=!controlsOpen;renderDetail()};document.getElementById("detail-refresh").onclick=()=>loadSnapshot(selectedId);document.querySelectorAll("[data-agent-action]").forEach(button=>button.onclick=async()=>{const action=button.dataset.agentAction;button.disabled=true;try{await api("/api/sessions/"+encodeURIComponent(selectedId)+"/actions",{method:"POST",body:JSON.stringify({action})});await loadSnapshot(selectedId)}catch(error){if(error.message==="AUTH_REQUIRED")invalidateToken();else alert(error.message)}finally{button.disabled=false}});if(controlsOpen){const closeControls=()=>{controlsOpen=false;renderDetail()};document.getElementById("controls-overlay").onclick=event=>{if(event.target===event.currentTarget)closeControls()};document.getElementById("controls-close").onclick=closeControls;document.getElementById("controls-cancel").onclick=closeControls;document.getElementById("settings-form").onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector("button[type=submit]");button.disabled=true;try{const modelField=document.getElementById("settings-model"),payload={};if(modelField)payload.model=modelField.value;const acpPermissionField=document.getElementById("settings-acp-permission");if(acpPermissionField)payload.acpPermissionBehavior=acpPermissionField.value;const permissionField=document.getElementById("settings-permission");const planField=document.getElementById("settings-plan");const effortField=document.getElementById("settings-effort");if(permissionField)payload.permissionMode=permissionField.value;if(planField)payload.planMode=planField.checked;if(effortField)payload.effort=effortField.value;const configValues={};document.querySelectorAll("[data-config-id]").forEach(field=>{configValues[field.dataset.configId]=field.value});if(Object.keys(configValues).length)payload.configValues=configValues;await api("/api/sessions/"+encodeURIComponent(selectedId)+"/settings",{method:"POST",body:JSON.stringify(payload)});controlsOpen=false;await loadSnapshot(selectedId)}catch(error){if(error.message==="AUTH_REQUIRED")invalidateToken();else alert(error.message)}finally{button.disabled=false}}}bindComposer(current.session.id);if(previousDraft!==undefined){const nextField=document.getElementById("message");nextField.value=previousDraft;nextField.style.height="auto";nextField.style.height=Math.min(nextField.scrollHeight,130)+"px";if(document.activeElement===previousField){nextField.focus();if(previousSelectionStart!==null&&previousSelectionStart!==undefined)nextField.setSelectionRange(previousSelectionStart,previousSelectionEnd??previousSelectionStart)}}if(followLatest)requestAnimationFrame(()=>window.scrollTo({top:document.documentElement.scrollHeight,behavior:"auto"}));else if(previousScroll!==null)window.scrollTo(0,previousScroll);if(current.pendingPermission)bindApproval(current)}
function render(){if(!token)return authScreen();if(selectedId)renderDetail();else renderList()}
function invalidateToken(){token="";localStorage.removeItem("harnss-remote-token");if(socket){socket.close();socket=null}authScreen(labels.invalidToken)}
async function loadSessions(){if(!token)return;loading=true;render();try{const data=await api("/api/sessions");sessions.splice(0,sessions.length,...(data.sessions||[]));const liveIds=new Set(sessions.map(session=>session.id));for(const id of snapshots.keys())if(!liveIds.has(id)&&id!==selectedId)snapshots.delete(id)}catch(error){if(error.message==="AUTH_REQUIRED"){invalidateToken();return}}finally{loading=false;render()}}
const acceptSnapshot=(id,snapshot)=>{const previous=snapshots.get(id);if(previous?.revision!==undefined&&snapshot?.revision!==undefined&&snapshot.revision<previous.revision)return false;snapshots.set(id,snapshot);upsertSession(summaryFor(snapshot));return true};
async function loadSnapshot(id){if(!token)return;try{const snapshot=await api("/api/sessions/"+encodeURIComponent(id));if(id!==selectedId&&selectedId!==null)return;if(acceptSnapshot(id,snapshot)){selectedId=id;render()}}catch(error){if(error.message==="AUTH_REQUIRED")invalidateToken();else root.insertAdjacentHTML("afterbegin",'<div class="error-banner">'+esc(error.message)+'</div>')}}
async function selectSession(id){previousView=view;selectedId=id;controlsOpen=false;render();await loadSnapshot(id)}
function collectAnswers(){const answers={};document.querySelectorAll("[data-answer-input]").forEach(input=>{if(input.value.trim())answers[input.dataset.answerInput]=[input.value.trim()]});document.querySelectorAll(".choice.is-selected").forEach(button=>{const id=button.dataset.question;answers[id]=answers[id]||[];answers[id].push(button.dataset.value)});return answers}
function bindApproval(snapshot){const permission=snapshot.pendingPermission,requiresAnswers=permission.kind==="user-input"&&(permission.questions||[]).length>0;const updateApprovalState=()=>{if(!requiresAnswers)return;const answers=collectAnswers();const complete=permission.questions.every(question=>Array.isArray(answers[question.id])&&answers[question.id].some(value=>value.trim()));document.querySelectorAll(".approval-actions #allow,.approval-actions #allow-session").forEach(button=>button.disabled=!complete)};document.querySelectorAll(".choice").forEach(button=>button.onclick=()=>{const group=button.parentElement;if(button.dataset.multi!=="true")group.querySelectorAll(".choice").forEach(item=>item.classList.remove("is-selected"));button.classList.toggle("is-selected");updateApprovalState()});document.querySelectorAll("[data-answer-input]").forEach(input=>input.oninput=updateApprovalState);const approve=async behavior=>{document.querySelectorAll(".approval-actions button").forEach(button=>button.disabled=true);try{await api("/api/sessions/"+encodeURIComponent(snapshot.session.id)+"/approvals/"+encodeURIComponent(permission.requestId),{method:"POST",body:JSON.stringify({behavior,answersByQuestionId:collectAnswers()})});await loadSnapshot(snapshot.session.id)}catch(error){if(error.message==="AUTH_REQUIRED")invalidateToken();else alert(error.message)}finally{document.querySelectorAll(".approval-actions button").forEach(button=>button.disabled=false);updateApprovalState()}};document.getElementById("allow").onclick=()=>approve("allow");document.getElementById("allow-session").onclick=()=>approve("allowForSession");document.getElementById("deny").onclick=()=>approve("deny");updateApprovalState()}
const refreshAfterMutation=(id)=>loadSnapshot(id);
function bindComposer(id){const form=document.getElementById("send-form"),field=document.getElementById("message"),button=form.querySelector("button[type=submit]");const stopButton=document.getElementById("stop-button");if(stopButton)stopButton.onclick=async()=>{stopButton.disabled=true;try{await api("/api/sessions/"+encodeURIComponent(id)+"/actions",{method:"POST",body:JSON.stringify({action:"interrupt"})});await refreshAfterMutation(id)}catch(error){stopButton.disabled=false;if(error.message==="AUTH_REQUIRED")invalidateToken();else alert(error.message)}};field.oninput=()=>{field.style.height="auto";field.style.height=Math.min(field.scrollHeight,130)+"px"};form.onsubmit=async event=>{event.preventDefault();const value=field.value.trim();if(!value)return;button.disabled=true;const current=snapshots.get(id),summary=sessions.find(session=>session.id===id),optimistic={id:"local-"+Date.now(),role:"user",content:value,timestamp:Date.now()};if(current){current.messages=current.messages.concat(optimistic);current.session.isProcessing=true}if(summary)summary.isProcessing=true;field.value="";field.style.height="auto";renderDetail();try{await api("/api/sessions/"+encodeURIComponent(id)+"/messages",{method:"POST",body:JSON.stringify({text:value})});await refreshAfterMutation(id)}catch(error){if(current){current.messages=current.messages.filter(message=>message.id!==optimistic.id);current.session.isProcessing=false}if(summary)summary.isProcessing=false;field.value=value;field.style.height="auto";field.style.height=Math.min(field.scrollHeight,130)+"px";renderDetail();if(error.message==="AUTH_REQUIRED")invalidateToken();else alert(error.message)}finally{button.disabled=false}}}
function connectSocket(){if(!token||socket)return;try{socket=new WebSocket((location.protocol==="https:"?"wss:":"ws:")+"//"+location.host+"/?token="+encodeURIComponent(token));socket.onopen=()=>{connected=true;scheduleRender();void loadSessions();if(selectedId)void loadSnapshot(selectedId)};socket.onmessage=event=>{const data=JSON.parse(event.data);if(data.type==="remote.ready"){connected=true;scheduleRender()}if(data.type==="session.updated"){if(acceptSnapshot(data.sessionId,data.snapshot))scheduleRender()}if(data.type==="sessions.updated"){clearTimeout(sessionRefreshTimer);sessionRefreshTimer=setTimeout(()=>loadSessions(),180)}};socket.onerror=()=>socket.close();socket.onclose=()=>{socket=null;connected=false;scheduleRender();clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connectSocket,2500)}}catch{socket=null}}
function boot(){if(!token){render();return}connectSocket();if("serviceWorker"in navigator)navigator.serviceWorker.register("/remote-sw.js").catch(()=>{})}
let pressTimer=null;const showCopied=()=>{let toast=document.querySelector(".copy-toast");if(!toast){toast=document.createElement("div");toast.className="copy-toast";document.body.appendChild(toast)}toast.textContent=labels.copied;toast.classList.add("show");clearTimeout(toast._timer);toast._timer=setTimeout(()=>toast.classList.remove("show"),1300)};
const copyMessageText=value=>{if(!value)return;showCopied();if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(value).catch(()=>fallbackCopy(value));else fallbackCopy(value)};
const fallbackCopy=value=>{const area=document.createElement("textarea");area.value=value;area.style.position="fixed";area.style.opacity="0";document.body.appendChild(area);area.select();try{document.execCommand("copy")}catch(_){}area.remove()};
document.addEventListener("touchstart",event=>{const target=event.target&&event.target.closest?event.target.closest(".message"):null;if(!target)return;const body=target.querySelector(".message-body");if(!body)return;clearTimeout(pressTimer);pressTimer=setTimeout(()=>copyMessageText(body.innerText||""),550)},{passive:true});
document.addEventListener("touchend",()=>clearTimeout(pressTimer),{passive:true});document.addEventListener("touchcancel",()=>clearTimeout(pressTimer),{passive:true});document.addEventListener("touchmove",()=>clearTimeout(pressTimer),{passive:true});
render();if(token)boot();
})()`;

const REMOTE_MANIFEST = JSON.stringify({
  name: "Harnss Remote",
  short_name: "Harnss",
  start_url: "/",
  display: "standalone",
  background_color: "#f6f8fa",
  theme_color: "#f6f8fa",
  icons: [],
});
const AGENT_ICON_BASE_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/";
const MAX_AGENT_ICON_CACHE_ENTRIES = 32;
const agentIconCache = new Map<string, Buffer>();

const REMOTE_SW_JS = `const CACHE="harnss-remote-v4";self.addEventListener("install",()=>self.skipWaiting());self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));self.addEventListener("fetch",event=>{const url=new URL(event.request.url);if(event.request.method==="GET"&&url.origin===location.origin&&!url.pathname.startsWith("/api/")){event.respondWith(caches.open(CACHE).then(async cache=>{try{const response=await fetch(event.request);cache.put(event.request,response.clone());return response}catch(_){return (await cache.match(event.request))||new Response("Offline",{status:503})}}))}});`;
const COVE_ASSETS = new Set([
  "audio-codec.js",
  "audio-playback.js",
  "barge-in-detector.js",
  "call-runtime.js",
  "endpoint-detector.js",
  "index.html",
  "listener-cues.js",
  "media-capture.js",
  "ordered-tts-queue.js",
  "pcm-worklet.js",
  "voice-ui.js",
  "wake-loop.js",
  "ws-transport.js",
]);
const COVE_MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function getBearerToken(request: IncomingMessage, allowQueryToken = false): string | null {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length).trim();
  const protocols = request.headers["sec-websocket-protocol"];
  if (typeof protocols === "string") {
    const values = protocols.split(",").map((value) => value.trim());
    const tokenIndex = values.indexOf("harnss-voice");
    if (tokenIndex >= 0 && values[tokenIndex + 1]) return values[tokenIndex + 1];
  }
  if (!allowQueryToken) return null;
  try {
    return new URL(request.url ?? "/", "http://localhost").searchParams.get("token");
  } catch {
    return null;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("Request body must be a JSON object"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

function validId(value: string | undefined): value is string {
  return !!value && value.length > 0 && value.length <= 200 && !value.includes("/") && !value.includes("\\");
}

/**
 * Authenticated localhost transport for the mobile remote-control client.
 * It deliberately contains no engine logic; all stateful requests go through
 * RemoteControlBridge into the renderer.
 */
export class RemoteControlServer {
  private readonly server = createServer((request, response) => {
    void this.handleRequest(request, response);
  });
  private readonly webSockets = new WebSocketServer({ noServer: true });
  private readonly coveWebSockets = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => protocols.has("harnss-voice") ? "harnss-voice" : "",
  });
  private readonly clients = new Set<WebSocket>();
  private readonly coveClients = new Set<WebSocket>();
  private unsubscribeBridge: (() => void) | null = null;
  private listening = false;
  private activePort: number | null = null;
  private lifecyclePromise: Promise<void> | null = null;

  constructor(private readonly bridge: RemoteControlBridge) {
    this.server.on("upgrade", (request, socket, head) => {
      const settings = getAppSettings();
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const token = getBearerToken(request, pathname !== "/voice");
      if (!tokenMatches(token, settings.remoteToken)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      const webSocketServer = pathname === "/voice" ? this.coveWebSockets : this.webSockets;
      webSocketServer.handleUpgrade(request, socket, head, (client) => {
        webSocketServer.emit("connection", client, request);
      });
    });

    this.webSockets.on("connection", (client: WebSocket) => {
      this.clients.add(client);
      client.send(JSON.stringify({
        type: "remote.ready",
        version: 1,
      } satisfies RemoteServerEvent));
      client.on("close", () => this.clients.delete(client));
      client.on("error", () => this.clients.delete(client));
    });

    this.coveWebSockets.on("connection", (client: WebSocket) => {
      this.coveClients.add(client);
      client.once("close", () => this.coveClients.delete(client));
      client.once("error", () => this.coveClients.delete(client));
      const port = getCoveVoicePort();
      const upstream = new WebSocket(`ws://127.0.0.1:${port}`);
      const closeBoth = (code = 1011, reason = "COVE runtime unavailable") => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ event: "voice_state", mode: "error", message: reason }));
        }
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(code, reason);
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
      };
      upstream.on("open", () => {
        client.on("message", (message, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(isBinary ? message : message.toString());
          }
        });
        client.on("close", closeBoth);
        client.on("error", closeBoth);
      });
      upstream.on("message", (message, isBinary) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(isBinary ? message : message.toString());
        }
      });
      upstream.on("close", () => {
        if (client.readyState === WebSocket.OPEN) client.close();
      });
      upstream.on("error", () => closeBoth());
    });
  }

  async start(): Promise<void> {
    if (this.lifecyclePromise) return this.lifecyclePromise;
    const operation = this.startInternal();
    this.lifecyclePromise = operation;
    try {
      await operation;
    } finally {
      if (this.lifecyclePromise === operation) this.lifecyclePromise = null;
    }
  }

  private async startInternal(): Promise<void> {
    const settings = getAppSettings();
    if (!settings.remoteEnabled || this.listening) return;
    const port = Number.isInteger(settings.remotePort) && settings.remotePort >= 1024 && settings.remotePort <= 65535
      ? settings.remotePort
      : DEFAULT_PORT;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(port, "127.0.0.1");
    });

    this.listening = true;
    this.activePort = port;
    this.unsubscribeBridge = this.bridge.onEvent((event) => this.broadcast(event));
    const address = this.server.address() as AddressInfo | null;
    log("REMOTE", `Remote control listening on http://127.0.0.1:${address?.port ?? port}`);
  }

  async stop(): Promise<void> {
    if (this.lifecyclePromise) await this.lifecyclePromise;
    if (this.lifecyclePromise) return;
    const operation = this.stopInternal();
    this.lifecyclePromise = operation;
    try {
      await operation;
    } finally {
      if (this.lifecyclePromise === operation) this.lifecyclePromise = null;
    }
  }

  private async stopInternal(): Promise<void> {
    if (!this.listening) return;
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = null;
    for (const client of this.clients) client.close(1001, "Server stopping");
    this.clients.clear();
    for (const client of this.coveClients) client.close(1001, "Server stopping");
    this.coveClients.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.listening = false;
    this.activePort = null;
  }

  async reconfigure(): Promise<void> {
    const settings = getAppSettings();
    const port = Number.isInteger(settings.remotePort) && settings.remotePort >= 1024 && settings.remotePort <= 65535
      ? settings.remotePort
      : DEFAULT_PORT;
    if (!settings.remoteEnabled) {
      await this.stop();
      return;
    }
    if (this.listening && this.activePort === port) return;
    await this.stop();
    await this.start();
  }

  getPort(): number | null {
    return this.activePort;
  }

  private broadcast(event: RemoteServerEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "")
      .split(",")[0]
      .trim()
      .toLowerCase();
    const forwardedHost = request.headers.host;
    if (forwardedProto === "http" && forwardedHost) {
      response.writeHead(308, {
        location: `https://${forwardedHost}${request.url ?? "/"}`,
        "cache-control": "no-store",
      });
      response.end();
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      });
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    // These assets contain no session data and are public so the browser can
    // load them from the token-protected HTML page and install the PWA.
    if (request.method === "GET" && url.pathname === "/remote-client.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
      response.end(REMOTE_CLIENT_JS);
      return;
    }
    if (request.method === "GET" && url.pathname === "/remote-client.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
      response.end(REMOTE_CLIENT_CSS);
      return;
    }
    if (request.method === "GET" && url.pathname === "/manifest.webmanifest") {
      response.writeHead(200, { "content-type": "application/manifest+json", "cache-control": "no-store", "access-control-allow-origin": "*" });
      response.end(REMOTE_MANIFEST);
      return;
    }
    if (request.method === "GET" && url.pathname === "/remote-sw.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
      response.end(REMOTE_SW_JS);
      return;
    }
    if (request.method === "GET" && (url.pathname === "/cove/" || url.pathname.startsWith("/cove/"))) {
      const encodedFile = url.pathname === "/cove/" ? "index.html" : url.pathname.slice("/cove/".length);
      let file = "";
      try {
        file = decodeURIComponent(encodedFile);
      } catch {
        response.writeHead(404);
        response.end();
        return;
      }
      if (!COVE_ASSETS.has(file) || file.includes("/") || file.includes("\\") || file === "." || file === "..") {
        response.writeHead(404);
        response.end();
        return;
      }
      const frontendRoot = path.resolve(getCoveFrontendDir());
      const assetPath = path.resolve(frontendRoot, file);
      if (!assetPath.startsWith(`${frontendRoot}${path.sep}`)) {
        response.writeHead(404);
        response.end();
        return;
      }
      try {
        const body = await fs.promises.readFile(assetPath);
        const extension = path.extname(file).toLowerCase();
        response.writeHead(200, {
          "content-type": COVE_MIME_TYPES[extension] ?? "application/octet-stream",
          "cache-control": file === "index.html" ? "no-store" : "public, max-age=3600",
          ...(file === "index.html"
            ? {
                "content-security-policy": "default-src 'self'; connect-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';",
                "permissions-policy": "microphone=(self)",
              }
            : {}),
        });
        response.end(body);
      } catch {
        response.writeHead(404);
        response.end();
      }
      return;
    }
    // Agent icons are proxied same-origin because the page CSP only allows
    // img-src 'self'. Strictly allowlisted to the ACP registry CDN, SVG only.
    if (request.method === "GET" && url.pathname.startsWith("/agent-icons/")) {
      const file = url.pathname.slice("/agent-icons/".length);
      if (!/^[\w-]+\.svg$/.test(file)) {
        response.writeHead(404);
        response.end();
        return;
      }
      const sendIcon = (body: Buffer) => {
        response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" });
        response.end(body);
      };
      const cachedIcon = agentIconCache.get(file);
      if (cachedIcon) {
        sendIcon(cachedIcon);
        return;
      }
      fetch(AGENT_ICON_BASE_URL + file)
        .then((iconResponse) => (iconResponse.ok ? iconResponse.arrayBuffer() : Promise.reject(new Error(String(iconResponse.status)))))
        .then((data) => {
          const body = Buffer.from(data);
          if (agentIconCache.size >= MAX_AGENT_ICON_CACHE_ENTRIES) {
            const oldest = agentIconCache.keys().next().value;
            if (oldest) agentIconCache.delete(oldest);
          }
          agentIconCache.set(file, body);
          sendIcon(body);
        })
        .catch(() => {
          response.writeHead(404);
          response.end();
        });
      return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline';",
        "permissions-policy": "microphone=(self)",
        "strict-transport-security": "max-age=31536000; includeSubDomains",
      });
      response.end(REMOTE_CLIENT_HTML);
      return;
    }
    const settings = getAppSettings();
    if (!tokenMatches(getBearerToken(request), settings.remoteToken)) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { ok: true, version: 1 });
        return;
      }

      if (request.method === "GET" && parts.length === 2 && parts[0] === "api" && parts[1] === "sessions") {
        const data = await this.bridge.request("sessions.list");
        sendJson(response, 200, { sessions: data });
        return;
      }

      if (request.method === "POST" && parts.length === 2 && parts[0] === "api" && parts[1] === "sessions") {
        const body = await readJson(request);
        const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
        if (!projectId || projectId.length > 200) {
          sendJson(response, 400, { error: "projectId must be a non-empty string of at most 200 characters" });
          return;
        }
        const engine = body.engine === undefined || body.engine === null || body.engine === "" ? "claude" : body.engine;
        if (engine !== "claude" && engine !== "codex" && engine !== "acp") {
          sendJson(response, 400, { error: "engine must be one of: claude, codex, acp" });
          return;
        }
        if (body.model !== undefined && (typeof body.model !== "string" || body.model.trim().length === 0 || body.model.length > 200)) {
          sendJson(response, 400, { error: "model must be a string of at most 200 characters" });
          return;
        }
        if (body.agentId !== undefined && (typeof body.agentId !== "string" || body.agentId.trim().length === 0 || body.agentId.length > 200)) {
          sendJson(response, 400, { error: "agentId must be a string of at most 200 characters" });
          return;
        }
        const data = await this.bridge.request("sessions.create", {
          projectId,
          engine,
          ...(typeof body.model === "string" ? { model: body.model } : {}),
          ...(typeof body.agentId === "string" ? { agentId: body.agentId } : {}),
        });
        sendJson(response, 200, data);
        return;
      }

      if (request.method === "GET" && parts.length === 3 && parts[0] === "api" && parts[1] === "sessions" && validId(parts[2])) {
        const data = await this.bridge.request("sessions.get", { sessionId: parts[2] });
        sendJson(response, 200, data);
        return;
      }

      if (request.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "sessions" && validId(parts[2]) && parts[3] === "messages") {
        const body = await readJson(request);
        if (typeof body.text !== "string" || body.text.trim().length === 0 || body.text.length > 20_000) {
          sendJson(response, 400, { error: "text must be a non-empty string of at most 20000 characters" });
          return;
        }
        const data = await this.bridge.request("sessions.send", {
          sessionId: parts[2],
          text: body.text,
        });
        sendJson(response, 200, data);
        return;
      }

      if (request.method === "POST" && parts.length === 5 && parts[0] === "api" && parts[1] === "sessions" && validId(parts[2]) && parts[3] === "approvals" && validId(parts[4])) {
        const body = await readJson(request) as RemoteApprovalInput & Record<string, unknown>;
        if (body.behavior !== "allow" && body.behavior !== "deny" && body.behavior !== "allowForSession") {
          sendJson(response, 400, { error: "Invalid approval behavior" });
          return;
        }
        const data = await this.bridge.request("sessions.approve", {
          sessionId: parts[2],
          requestId: parts[4],
          behavior: body.behavior,
          answersByQuestionId: body.answersByQuestionId,
          denyMessage: body.denyMessage,
          newPermissionMode: body.newPermissionMode,
        });
        sendJson(response, 200, data);
        return;
      }

      if (request.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "sessions" && validId(parts[2]) && parts[3] === "settings") {
        const body = await readJson(request) as RemoteSessionSettingsInput;
        if (body.model !== undefined && (typeof body.model !== "string" || body.model.trim().length > 200)) {
          sendJson(response, 400, { error: "model must be a string of at most 200 characters" });
          return;
        }
        if (body.permissionMode !== undefined && (typeof body.permissionMode !== "string" || body.permissionMode.trim().length > 80)) {
          sendJson(response, 400, { error: "permissionMode must be a string of at most 80 characters" });
          return;
        }
        if (body.effort !== undefined && (typeof body.effort !== "string" || body.effort.trim().length > 40)) {
          sendJson(response, 400, { error: "effort must be a string of at most 40 characters" });
          return;
        }
        if (body.configValues !== undefined && (
          !body.configValues
          || typeof body.configValues !== "object"
          || Array.isArray(body.configValues)
          || Object.entries(body.configValues).some(([key, value]) =>
            key.length > 100 || typeof value !== "string" || value.length > 500,
          )
        )) {
          sendJson(response, 400, { error: "configValues must be a map of short string values" });
          return;
        }
        if (body.planMode !== undefined && typeof body.planMode !== "boolean") {
          sendJson(response, 400, { error: "planMode must be a boolean" });
          return;
        }
        if (body.acpPermissionBehavior !== undefined && !isAcpPermissionBehavior(body.acpPermissionBehavior)) {
          sendJson(response, 400, { error: "Invalid ACP permission behavior" });
          return;
        }
        const data = await this.bridge.request("sessions.update-settings", {
          sessionId: parts[2],
          ...(typeof body.model === "string" ? { model: body.model } : {}),
          ...(typeof body.effort === "string" ? { effort: body.effort } : {}),
          ...(typeof body.permissionMode === "string" ? { permissionMode: body.permissionMode } : {}),
          ...(typeof body.planMode === "boolean" ? { planMode: body.planMode } : {}),
          ...(typeof body.acpPermissionBehavior === "string"
            ? { acpPermissionBehavior: body.acpPermissionBehavior }
            : {}),
          ...(body.configValues && typeof body.configValues === "object" && !Array.isArray(body.configValues)
            ? { configValues: body.configValues as Record<string, string> }
            : {}),
        });
        sendJson(response, 200, data);
        return;
      }

      if (request.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "sessions" && validId(parts[2]) && parts[3] === "actions") {
        const body = await readJson(request);
        if (body.action !== "activate" && body.action !== "interrupt" && body.action !== "retry") {
          sendJson(response, 400, { error: "Invalid session action" });
          return;
        }
        const data = await this.bridge.request("sessions.action", {
          sessionId: parts[2],
          action: body.action,
        });
        sendJson(response, 200, data);
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Remote request failed";
      sendJson(response, message.includes("not found") ? 404 : 500, { error: message });
    }
  }
}
