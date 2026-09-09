import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import type { AddressInfo } from "net";
import { WebSocketServer, WebSocket } from "ws";
import { getAppSettings } from "../lib/app-settings";
import { log } from "../lib/logger";
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
<meta name="theme-color" content="#0c1410"><meta name="mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.webmanifest"><title>L'Agents WebUI</title>
<link rel="stylesheet" href="/remote-client.css"></head>
<body><main id="app"><div class="boot-screen"><div class="brand-mark">L</div><p>Connecting to L'Agents…</p></div></main>
<script src="/remote-client.js"></script></body></html>`;

const REMOTE_CLIENT_CSS = `:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;--bg:#0c1410;--panel:#15201a;--panel-2:#1a2820;--line:#2b3d33;--muted:#93a598;--soft:#d9d4c2;--text:#f0ecdd;--accent:#d8b56a;--accent-strong:#c9a24f;--on-accent:#1d1608;--green:#82c99b;--amber:#e0b45c;--red:#e07a6a;--shadow:0 18px 40px rgba(0,0,0,.38);--grad:linear-gradient(135deg,#ecd9a8,#c9a24f)}
html[data-theme="light"]{color-scheme:light;--bg:#f2efe6;--panel:#ffffff;--panel-2:#f8f5ec;--line:#e3ddc9;--muted:#6f7d6e;--soft:#3f4a41;--text:#272e28;--accent:#a8823a;--accent-strong:#8a6a2c;--on-accent:#fffdf5;--green:#3e7d58;--amber:#9a7126;--red:#b3543f;--shadow:0 14px 34px rgba(64,54,24,.12);--grad:linear-gradient(135deg,#d8b56a,#96742f)}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;min-width:320px;color:var(--text);background:radial-gradient(circle at 100% 0,#20301f 0,transparent 34%),radial-gradient(circle at 0 100%,#26301c 0,transparent 30%),linear-gradient(160deg,#101a14 0,#080f0b 72%);min-height:100vh}
html[data-theme="light"] body{background:radial-gradient(circle at 100% 0,#f7f0da 0,transparent 36%),radial-gradient(circle at 0 100%,#edf0e2 0,transparent 32%),linear-gradient(160deg,#f8f5ec 0,#eae5d4 72%)}
button,input,textarea,select{font:inherit;color:inherit}button{border:0;background:none;padding:0;cursor:pointer}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
main{max-width:720px;margin:0 auto;padding:calc(env(safe-area-inset-top) + 10px) 16px calc(104px + env(safe-area-inset-bottom))}
html{scroll-padding-top:calc(env(safe-area-inset-top) + 64px)}
body[data-detail="1"] main{padding-bottom:calc(env(safe-area-inset-bottom) + 6px)}
.boot-screen,.auth-screen{min-height:100svh;display:grid;place-items:center;text-align:center;color:var(--muted)}.boot-screen{align-content:center;gap:14px}.boot-screen p{margin:0}
.brand-mark{width:52px;height:52px;border-radius:16px;background:var(--grad);color:#1d1608;display:grid;place-items:center;font-weight:700;font-size:22px;margin:0 auto;box-shadow:0 10px 24px rgba(201,162,79,.25)}
.auth-card{background:var(--panel);border:1px solid var(--line);border-radius:24px;padding:30px 26px;width:min(400px,90vw);display:grid;gap:14px;box-shadow:var(--shadow)}.auth-card h1{margin:4px 0 0;font-size:22px;color:var(--text)}.auth-card>p{margin:0;font-size:14px;line-height:1.55}.auth-actions{display:flex;justify-content:flex-end}
.auth-card form{display:grid;gap:10px;margin-top:6px}.auth-card label{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);text-align:left}
input,textarea,select{background:var(--panel-2);border:1px solid var(--line);border-radius:14px;color:var(--text);padding:12px 14px;width:100%}input::placeholder,textarea::placeholder{color:var(--muted)}
button.primary,button.secondary,button.danger{border-radius:14px;padding:12px 18px;font-weight:600}
button.primary{background:var(--grad);color:#1d1608}button.primary:disabled{opacity:.5}
button.secondary{background:var(--panel-2);border:1px solid var(--line);color:var(--soft)}
button.danger{background:rgba(224,122,106,.14);border:1px solid rgba(224,122,106,.4);color:var(--red)}
.error-banner{background:rgba(224,122,106,.12);border:1px solid rgba(224,122,106,.38);color:var(--red);border-radius:14px;padding:11px 14px;font-size:13.5px;line-height:1.5}
.loading-card,.empty-state{border:1px dashed var(--line);border-radius:20px;padding:30px 22px;text-align:center;color:var(--muted);display:grid;gap:8px;font-size:14px}.empty-state strong{color:var(--soft);font-size:15px}
.topbar{position:sticky;top:0;z-index:30;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;margin:calc(-1*env(safe-area-inset-top) - 10px) -16px 10px;padding:calc(env(safe-area-inset-top) + 8px) 16px 8px;background:rgba(12,20,16,.86);background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid var(--line)}
html[data-theme="light"] .topbar{background:rgba(242,239,230,.88);background:color-mix(in srgb,var(--bg) 88%,transparent)}
.topbar-left{justify-self:start;display:flex;align-items:center;gap:8px;min-width:0}
.topbar-center{justify-self:center;margin:0;font-size:16px;font-weight:700;color:var(--text);white-space:nowrap}
.topbar-actions{justify-self:end;display:flex;align-items:center;gap:8px;min-width:0}
.icon-button{width:36px;height:36px;border-radius:12px;background:var(--panel);border:1px solid var(--line);display:grid;place-items:center;color:var(--soft);flex:none}.icon-button svg{width:17px;height:17px}
.connection{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--green);background:rgba(130,201,155,.1);border:1px solid rgba(130,201,155,.3);padding:7px 12px;border-radius:999px;white-space:nowrap}
.connection.offline{color:var(--muted);background:var(--panel-2);border-color:var(--line)}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.language-toggle{font-size:12px;font-weight:700;color:var(--accent);background:rgba(216,181,106,.1);border:1px solid rgba(216,181,106,.34);padding:7px 11px;border-radius:999px}
.hero-card{display:grid;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:15px 16px;box-shadow:var(--shadow)}
.hero-main{display:flex;align-items:center;gap:13px}
.hero-mark{width:52px;height:52px;border-radius:16px;background:var(--grad);color:#1d1608;display:grid;place-items:center;font-weight:800;font-size:22px;flex:none}
.hero-copy{min-width:0;flex:1}.hero-copy h1{margin:0;font-size:18px}.hero-sub{margin:3px 0 0;font-size:12.5px;color:var(--muted);letter-spacing:.04em}
.hero-status{margin:6px 0 0;display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:var(--green)}
.hero-status.offline{color:var(--muted)}
.manage-button{flex:none;background:var(--grad);color:#1d1608;font-weight:700;font-size:13.5px;border-radius:999px;padding:10px 18px}
.chip-row{display:grid;grid-template-columns:repeat(5,1fr);gap:4px;padding-top:12px;border-top:1px solid var(--line)}
.chip{min-width:0;display:grid;justify-items:center;gap:2px;text-align:center}
.chip strong{font-size:12.5px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}.chip span{font-size:9.5px;color:var(--muted);white-space:nowrap}
.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding-top:10px}
.stat-card{display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:11px 12px}
.stat-icon{width:38px;height:38px;border-radius:12px;background:rgba(216,181,106,.12);border:1px solid rgba(216,181,106,.28);display:grid;place-items:center;color:var(--accent);flex:none}.stat-icon svg{width:17px;height:17px}
.stat-copy{min-width:0;display:grid}.stat-copy strong{font-size:16px}.stat-copy span{font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.home-section{padding-top:16px}
.section-header{display:flex;align-items:center;justify-content:space-between;padding:0 2px 10px}
.section-header h2{margin:0;font-size:15px}.section-header span{font-size:12.5px;color:var(--muted)}
.section-link{font-size:12.5px;color:var(--accent);font-weight:600}
.attention-summary{width:100%;display:flex;align-items:center;gap:13px;text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:15px 16px}
.attention-summary>span:last-child{display:grid;gap:2px;flex:1;min-width:0}.attention-summary strong{font-size:14.5px}.attention-summary span,.attention-summary>span:last-child>span{font-size:12px;color:var(--muted)}
.summary-icon{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;font-weight:800;flex:none;background:rgba(224,180,92,.14);color:var(--amber);border:1px solid rgba(224,180,92,.34)}
button.attention-summary .summary-icon{background:rgba(224,122,106,.14);color:var(--red);border-color:rgba(224,122,106,.4)}
.attention-summary .chevron{color:var(--muted)}
.settings-list{display:grid;gap:8px}
.setting-row{display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:11px 13px;background:var(--panel);border:1px solid var(--line);border-radius:16px}
.setting-icon{width:38px;height:38px;border-radius:12px;background:var(--panel-2);border:1px solid var(--line);display:grid;place-items:center;color:var(--accent);flex:none}.setting-icon svg{width:17px;height:17px}
.setting-copy{flex:1;min-width:0;display:grid;gap:1px}.setting-copy strong{font-size:14px}.setting-copy small{font-size:11.5px;color:var(--muted)}
.chevron-slot{color:var(--muted);display:grid}.chevron-slot svg{width:15px;height:15px}
.segmented{display:flex;background:var(--panel-2);border:1px solid var(--line);border-radius:11px;padding:3px;gap:3px;flex:none}
.segmented button{border-radius:8px;padding:6px 13px;font-size:12.5px;font-weight:600;color:var(--muted)}
.segmented button.active{background:var(--grad);color:#1d1608}
.switch{position:relative;width:46px;height:27px;flex:none;display:inline-block}
.switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.switch span{position:absolute;inset:0;border-radius:999px;background:var(--panel-2);border:1px solid var(--line);transition:.18s;pointer-events:none}
.switch span::after{content:"";position:absolute;top:2px;left:2px;width:21px;height:21px;border-radius:50%;background:var(--muted);transition:.18s}
.switch input:checked+span{background:rgba(216,181,106,.22);border-color:var(--accent)}
.switch input:checked+span::after{left:21px;background:var(--accent)}
.page-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;padding:6px 2px 14px}
.page-heading h1{margin:0;font-size:20px}.page-heading .kicker{margin:0 0 4px;font-size:10px;letter-spacing:.2em;color:var(--accent);font-weight:700}
.new-chat-button{display:flex;align-items:center;gap:7px;background:var(--grad);color:#1d1608;font-weight:700;font-size:13px;border-radius:999px;padding:10px 15px;white-space:nowrap}.new-chat-button svg{width:14px;height:14px}
.toolbar{display:grid;gap:10px;padding-bottom:14px}
.search-box{display:flex;align-items:center;gap:9px;background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:0 13px;color:var(--muted)}
.search-box svg{width:16px;height:16px;flex:none}
.search-box input{background:none;border:0;border-radius:0;padding:11px 0}
.filters{display:flex;gap:8px}
.filter{font-size:12.5px;font-weight:600;color:var(--muted);background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:7px 14px}
.filter.active{background:rgba(216,181,106,.14);border-color:var(--accent);color:var(--accent)}
.session-list{display:grid;gap:8px}
.session-card{display:flex;align-items:center;gap:11px;text-align:left;width:100%;background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:11px 13px;transition:transform .12s}
.session-card:active{transform:scale(.985)}
.session-card.attention{border-color:rgba(224,122,106,.5)}
.session-icon{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font-weight:700;font-size:15px;flex:none;background:var(--panel-2);border:1px solid var(--line);color:var(--soft);overflow:hidden}
.session-icon.working{background:rgba(130,201,155,.12);border-color:rgba(130,201,155,.4);color:var(--green)}
.session-icon.attention{background:rgba(224,122,106,.14);border-color:rgba(224,122,106,.45);color:var(--red)}
.session-icon.claude{color:var(--accent)}.session-icon.codex{color:#9fd0ea}.session-icon.acp{color:#c9a6e8}
.agent-logo{width:26px;height:26px;border-radius:7px;object-fit:contain}
.agent-logo-emoji{font-size:20px}
.session-copy{flex:1;min-width:0;display:grid;gap:3px}
.session-title{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.session-meta{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.session-status{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--muted);width:fit-content}
.session-status.working{color:var(--green)}.session-status.attention{color:var(--red)}
.session-card .chevron{color:var(--muted);flex:none}
.detail-topbar{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:10px;margin:-10px -16px 10px;margin:calc(-1*env(safe-area-inset-top) - 10px) -16px 10px;padding:10px 16px;padding:calc(env(safe-area-inset-top) + 8px) 16px 8px;background:rgba(12,20,16,.86);background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid var(--line)}
html[data-theme="light"] .detail-topbar{background:rgba(242,239,230,.88);background:color-mix(in srgb,var(--bg) 88%,transparent)}
.mini-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--muted);margin-right:5px;vertical-align:1px}
.mini-dot.working{background:var(--green)}
.mini-dot.attention{background:var(--red)}
.detail-heading{display:flex;align-items:center;gap:11px;flex:1;min-width:0}
.back-button{width:38px;height:38px;border-radius:12px;background:var(--panel);border:1px solid var(--line);display:grid;place-items:center;color:var(--soft);flex:none}.back-button svg{width:17px;height:17px}
.detail-avatar{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;font-weight:700;font-size:13px;background:var(--panel-2);border:1px solid var(--line);flex:none;overflow:hidden}
.detail-avatar .agent-logo{width:20px;height:20px}
.detail-heading-copy{flex:1;min-width:0}
.detail-heading-copy h1{margin:0;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.detail-heading-copy p{margin:1px 0 0;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.detail-heading-copy p svg{width:11px;height:11px;vertical-align:-1px}
.status-pill{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;background:var(--panel-2);color:var(--muted);border:1px solid var(--line);flex:none}
.status-pill.working{color:var(--green);border-color:rgba(130,201,155,.4);background:rgba(130,201,155,.1)}
.status-pill.attention{color:var(--red);border-color:rgba(224,122,106,.45);background:rgba(224,122,106,.12)}
.detail-actions{display:flex;gap:8px;flex:none}
.detail-control-button{font-size:12.5px;font-weight:600;color:var(--soft);background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:9px 13px;white-space:nowrap}
.token-meter{background:none;border:0;border-radius:0;padding:0 2px;margin:0}
.token-meter-head{display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-bottom:3px}.token-meter-head span:first-child{color:var(--muted);font-weight:600}
.token-meter-bar{height:3px;border-radius:99px;background:var(--panel-2);overflow:hidden}
.token-meter-bar span{display:block;height:100%;border-radius:99px;background:var(--grad)}
.agent-actions{display:flex;align-items:center;gap:8px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:7px 10px;margin-bottom:10px;flex-wrap:wrap}
.agent-actions.cost-only{justify-content:flex-end;background:none;border:0;padding:0 4px;margin-bottom:6px}
.actions-cost{margin-left:auto;font-size:11px;color:var(--muted);white-space:nowrap}
.action-grid{display:flex;gap:8px;flex-wrap:wrap}
.action-button{background:none;border:1px solid var(--line);border-radius:11px;padding:6px 12px;font-size:12px;font-weight:600;color:var(--soft)}
.action-button.danger-action{background:rgba(224,122,106,.13);border-color:rgba(224,122,106,.4);color:var(--red)}
.action-note{font-size:11.5px;color:var(--muted)}
.conversation{display:grid;gap:9px;padding:2px 0 10px}
.message{background:none;border:0;border-radius:0;padding:2px 2px}
.message.user{background:rgba(216,181,106,.12);border:1px solid rgba(216,181,106,.28);border-radius:16px 16px 5px 16px;padding:8px 13px;margin-left:auto;max-width:88%}
.message.assistant.streaming{border-left:2px solid var(--accent);padding-left:9px}
.message-foot{display:flex;align-items:center;gap:8px;margin-top:4px}
.message.user .message-foot{justify-content:flex-end}
.foot-role{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.message-time{font-size:10px;color:var(--muted)}
.copy-btn{width:22px;height:22px;border-radius:7px;display:grid;place-items:center;color:var(--muted);background:none;border:0}.copy-btn svg{width:11px;height:11px}
.message-body{font-size:13.5px;line-height:1.6;overflow-wrap:anywhere;white-space:pre-wrap}
.message.user .message-body{font-size:13.5px}
.message-body .md-h{display:block;margin:9px 0 4px;font-size:14px;color:var(--text)}
.md-inline{background:var(--panel-2);border:1px solid var(--line);border-radius:6px;padding:1px 5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.md-code{background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:9px 11px;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;margin:7px 0}
.thinking-box{margin-top:7px;border:1px dashed var(--line);border-radius:10px;padding:6px 10px}
.thinking-box summary{font-size:11px;color:var(--muted);cursor:pointer}
.thinking{margin-top:6px;font-size:12px;line-height:1.55;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
.tool-message,.tool-group{border:1px solid var(--line);border-radius:12px;background:var(--panel)}
.tool-message>summary,.tool-group>summary{display:flex;align-items:center;gap:8px;padding:8px 11px;cursor:pointer;font-size:12px;color:var(--soft);list-style:none}
.tool-message>summary::-webkit-details-marker,.tool-group>summary::-webkit-details-marker{display:none}
.tool-status{width:8px;height:8px;border-radius:50%;background:var(--green);flex:none}
.tool-status.error{background:var(--red)}.tool-status.running{background:var(--amber);animation:pulse 1.1s infinite}
@keyframes pulse{50%{opacity:.35}}
.tool-summary-line{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tool-body{border-top:1px solid var(--line);padding:9px 11px;font-size:12px;line-height:1.5;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
.tool-group-body{display:grid;gap:7px;padding:0 8px 8px}
.group-icon{color:var(--accent);font-size:13px}
.group-hint{margin-left:auto;color:var(--muted);font-size:11px}
.task-progress{border-top:1px solid var(--line);padding:10px 13px}
.task-progress-head{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:6px}
.task-progress-bar{height:4px;border-radius:99px;background:var(--panel-2);overflow:hidden;margin-bottom:8px}
.task-progress-bar span{display:block;height:100%;background:var(--grad);border-radius:99px}
.task-steps{display:flex;gap:6px;flex-wrap:wrap}
.task-step{font-size:10.5px;color:var(--muted);background:var(--panel-2);border:1px solid var(--line);border-radius:999px;padding:3px 9px}
.task-step.done{color:var(--green);border-color:rgba(130,201,155,.4)}
.task-step.error{color:var(--red);border-color:rgba(224,122,106,.4)}
.date-divider{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:11px;padding:6px 2px 0}
.date-divider::before,.date-divider::after{content:"";flex:1;height:1px;background:var(--line)}
.composer-wrap{position:sticky;bottom:0;padding:6px 0 8px;background:linear-gradient(180deg,rgba(12,20,16,0),var(--bg) 34%)}
html[data-theme="light"] .composer-wrap{background:linear-gradient(180deg,rgba(242,239,230,0),var(--bg) 34%)}
.composer{display:grid;gap:6px;background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:10px 12px;box-shadow:var(--shadow)}
.composer textarea{background:none;border:0;border-radius:0;padding:2px 2px;resize:none;min-height:32px;max-height:120px;font-size:14px;line-height:1.5}
.composer-bar{display:flex;align-items:center;justify-content:space-between;gap:10px}
.composer-bar .composer-hint{margin:0;flex:1;min-width:0;text-align:left;font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-actions{display:flex;align-items:center;gap:8px;flex:none}
.send-button{width:32px;height:32px;border-radius:50%;background:var(--grad);color:#1d1608;display:grid;place-items:center;flex:none}.send-button svg{width:14px;height:14px}
.send-button.stop{background:rgba(224,122,106,.16);border:1px solid rgba(224,122,106,.45);color:var(--red)}
.controls-overlay{position:fixed;inset:0;background:rgba(5,9,7,.62);backdrop-filter:blur(3px);display:flex;align-items:flex-end;z-index:40;animation:fade .16s}
@keyframes fade{from{opacity:0}}
.controls-sheet{width:100%;max-height:86svh;overflow-y:auto;background:var(--panel);border:1px solid var(--line);border-bottom:0;border-radius:24px 24px 0 0;padding:18px 18px calc(18px + env(safe-area-inset-bottom));animation:slide-up .2s}
@keyframes slide-up{from{transform:translateY(40px);opacity:.4}}
.controls-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}
.controls-heading h2{margin:0 0 3px;font-size:16.5px}.controls-heading p{margin:0;font-size:12px;color:var(--muted);line-height:1.5}
.control-grid{display:grid;gap:12px;margin-bottom:14px}
.control-field{display:grid;gap:6px;font-size:12.5px;color:var(--muted)}
.control-field>span{font-weight:600}
.control-value{font-size:14px;color:var(--text)}.control-value.ok{color:var(--green)}.control-value.bad{color:var(--red)}
.control-note{font-size:12.5px;color:var(--muted)}
.toggle-row{display:flex;align-items:center;gap:10px;background:var(--panel-2);border:1px solid var(--line);border-radius:13px;padding:11px 13px}
.toggle-copy{flex:1;display:grid;gap:1px}.toggle-copy strong{font-size:13.5px}.toggle-copy small{font-size:11px;color:var(--muted)}
.toggle-row input{width:22px;height:22px;accent-color:var(--accent);flex:none}
.controls-actions{display:flex;gap:9px;justify-content:flex-end}
.approval-panel{display:grid;gap:14px}
.approval-header{display:flex;gap:12px;align-items:flex-start}
.approval-icon{width:38px;height:38px;border-radius:12px;background:rgba(224,122,106,.14);border:1px solid rgba(224,122,106,.45);color:var(--red);display:grid;place-items:center;font-weight:800;flex:none}
.approval-header h2{margin:0;font-size:15.5px}.approval-header p{margin:4px 0 0;font-size:12.5px;color:var(--muted);line-height:1.5}
.approval-question label{display:block;font-size:12.5px;font-weight:600;color:var(--soft);margin-bottom:8px}
.choice-group{display:grid;gap:8px}
.choice{text-align:left;background:var(--panel-2);border:1px solid var(--line);border-radius:13px;padding:11px 13px;font-size:13.5px;color:var(--soft)}
.choice span{font-size:11.5px;color:var(--muted)}
.choice.is-selected{border-color:var(--accent);background:rgba(216,181,106,.12)}
.answer-input{margin-top:2px}
.approval-actions{display:flex;gap:9px}
.approval-actions .danger{margin-right:auto}
.copy-toast{position:fixed;left:50%;bottom:calc(96px + env(safe-area-inset-bottom));transform:translateX(-50%) translateY(8px);background:var(--panel);border:1px solid var(--accent);color:var(--accent);font-size:12.5px;font-weight:600;padding:9px 17px;border-radius:999px;opacity:0;pointer-events:none;transition:.18s;z-index:60}
.copy-toast.show{opacity:1;transform:translateX(-50%)}
.bottom-nav{position:fixed;left:0;right:0;bottom:0;z-index:30;display:flex;justify-content:center;gap:6px;padding:8px 12px calc(8px + env(safe-area-inset-bottom));background:rgba(12,20,16,.88);background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(14px);border-top:1px solid var(--line)}
html[data-theme="light"] .bottom-nav{background:rgba(242,239,230,.9);background:color-mix(in srgb,var(--bg) 90%,transparent)}
.nav-item{position:relative;flex:1;max-width:200px;display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 0 4px;color:var(--muted);font-size:10.5px;font-weight:600;border-radius:12px}
.nav-item svg{width:20px;height:20px}
.nav-item.active{color:var(--accent)}
.nav-badge{position:absolute;top:2px;right:calc(50% - 24px);min-width:16px;height:16px;border-radius:99px;background:var(--red);color:#fff;font-size:9.5px;font-weight:700;display:grid;place-items:center;padding:0 4px}
@media(min-width:720px){.stat-grid{grid-template-columns:repeat(4,1fr)}}`;

const REMOTE_CLIENT_JS = `(() => {
const root=document.getElementById("app");
const params=new URLSearchParams(location.search);
let token=params.get("token")||localStorage.getItem("harnss-remote-token")||"";
if(token){localStorage.setItem("harnss-remote-token",token);history.replaceState(null,"","/");}
let isZh=(localStorage.getItem("harnss-remote-language")||(/^(zh)/i.test(navigator.language||"")?"zh":"en"))==="zh";
let theme=localStorage.getItem("harnss-remote-theme")==="light"?"light":"dark";
let showThinking=localStorage.getItem("harnss-remote-thinking")!=="0";
const applyTheme=()=>{document.documentElement.dataset.theme=theme;const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.setAttribute("content",theme==="light"?"#f2efe6":"#0c1410")};
applyTheme();
document.documentElement.lang=isZh?"zh-CN":"en";
const text=(en,zh)=>isZh?zh:en;
const createLabels=()=>({
  app:text("L'Agents WebUI","L'Agents WebUI"),sessions:text("Sessions","会话"),refresh:text("Refresh","刷新"),connected:text("Live","已连接"),
  offline:text("Offline","离线"),all:text("All","全部"),working:text("Working","运行中"),approval:text("Needs approval","待审批"),
  active:text("active","运行中"),noSessions:text("No sessions yet","暂无会话"),
  noSessionsHint:text("Start an agent session in L'Agents to see it here.","在 L'Agents 中启动一个代理会话后，它会显示在这里。"),
  search:text("Search sessions","搜索会话"),recent:text("Your sessions","你的会话"),
  back:text("Back","返回"),idle:text("Idle","空闲"),
  you:text("You","你"),assistant:text("Assistant","助手"),system:text("System","系统"),summary:text("Summary","摘要"),tool:text("Tool activity","工具活动"),subagentProgress:text("Agent progress","代理进度"),steps:text("steps","步"),send:text("Send message","发送消息"),thoughts:text("Thinking","思考过程"),toolsRun:text("tools","个工具"),
  connectTitle:text("Connect to L'Agents","连接到 L'Agents"),connectBody:text("Enter the pairing token from L'Agents → Settings → General → Remote Control. It stays on this device.","输入 L'Agents → 设置 → 常规 → 远程控制中的配对 Token。Token 只保存在此设备。"),
  token:text("Pairing token","配对 Token"),connect:text("Connect","连接"),invalidToken:text("That token was rejected. Check the token in L'Agents and try again.","Token 无效，请检查 L'Agents 中的配对 Token 后重试。"),
  permission:text("Permission required","需要权限"),allow:text("Allow","允许"),allowSession:text("Allow session","本会话允许"),deny:text("Deny","拒绝"),
  answer:text("Answer","回答"),older:text("Older messages omitted","较早消息已省略"),noMessage:text("No messages yet","暂无消息"),loading:text("Loading…","加载中…"),
  controls:text("Controls","控制"),model:text("Model","模型"),permissionMode:text("Permission mode","权限模式"),acpPermission:text("ACP permissions","ACP 权限"),acpAsk:text("Ask before tools","工具调用前询问"),acpAutoAccept:text("Auto accept","自动接受"),acpAllowAll:text("Allow all","全部允许"),
  agentActions:text("Agent actions","代理操作"),openSession:text("Open session","打开会话"),retry:text("Retry last message","重试上一条"),stop:text("Stop agent","停止代理"),settings:text("Model & permissions","模型与权限"),configHint:text("Send or retry a turn to load this agent's live controls.","发送或重试一次对话后，加载此 agent 的实时配置。"),
  planMode:text("Plan mode","计划模式"),planHint:text("Review the plan before changes","先审阅计划再修改"),apply:text("Apply changes","应用更改"),cancel:text("Cancel","取消"),
  context:text("Context","上下文"),cost:text("Cost","费用"),noModelOptions:text("Model list unavailable","模型列表暂不可用"),
  settingsHint:text("Changes apply to this session","更改仅应用于此会话"),defaultModel:text("Default model","默认模型"),needsAction:text("Needs your attention","需要你的处理"),allClear:text("All clear","一切正常"),allClearHint:text("No approvals are waiting right now.","当前没有等待处理的审批。"),recentActivity:text("Recent activity","最近活动"),seeAll:text("See all","查看全部"),
  askFirst:text("Ask before edits","编辑前询问"),acceptEdits:text("Accept edits","自动接受编辑"),allowAll:text("Allow all","全部允许"),effort:text("Reasoning effort","推理强度"),
  effortLow:text("Low","低"),effortMedium:text("Medium","中"),effortHigh:text("High","高"),effortMax:text("Max","最高"),configUnavailable:text("No live configuration options are available for this agent.","此代理当前没有可用的实时配置选项。"),copied:text("Copied","已复制"),
  consoleTab:text("Console","控制台"),device:text("Device","设备"),gateway:text("L'Agents Gateway","L'Agents 网关"),linkRelay:"Link · Relay",
  online:text("Online","在线"),link:text("Link","链路"),manage:text("Manage","管理"),
  connection:text("Connection","连接"),connectionHint:text("Server & pairing status","服务器与配对状态"),
  serverField:text("Server","服务器"),statusField:text("Status","状态"),tokenNote:text("The pairing token is stored only on this device.","配对 Token 只保存在此设备。"),
  reconnect:text("Reconnect","重新连接"),signOut:text("Forget token & sign out","清除 Token 并退出"),close:text("Close","关闭"),
  appearance:text("Appearance","显示设置"),appearanceHint:text("Switch light & dark theme","切换明暗主题"),lightMode:text("Light","明"),darkMode:text("Dark","暗"),
  languageRow:text("Language","语言"),thinkingRow:text("Thinking","思考过程"),thinkingHint:text("Show reasoning inside messages","在消息中显示推理过程"),
  newChat:text("New chat","新建对话"),engineLabel:text("Engine","引擎"),projectLabel:text("Project","项目"),
  customProject:text("Custom path…","手动输入路径…"),create:text("Create","创建"),creating:text("Creating…","创建中…"),
  createHint:text("Start a new agent session in a project directory.","在指定项目目录启动一个新的代理会话。"),
  createNeedProject:text("Enter a project path first.","请先填写项目路径。"),
  latest:text("Latest activity","最近活动"),left:text("left","剩余"),copy:text("Copy","复制"),
  sendHint:text("Enter to send · Shift+Enter for a new line","Enter 发送 · Shift+Enter 换行"),
  inputPlaceholder:text("Type a message…","输入消息…")
});
let labels=createLabels();
const languageToggleHtml=()=>'<button type="button" class="language-toggle" data-language-toggle aria-label="'+(isZh?"Switch to English":"切换到中文")+'">'+(isZh?"EN":"中文")+'</button>';
const setLanguage=(language)=>{isZh=language==="zh";labels=createLabels();localStorage.setItem("harnss-remote-language",isZh?"zh":"en");document.documentElement.lang=isZh?"zh-CN":"en";render()};
const bindLanguageToggle=()=>{const button=document.querySelector("[data-language-toggle]");if(button)button.onclick=()=>setLanguage(isZh?"en":"zh")};
const esc=(v)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ICONS={
search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>',
arrow:'<svg class="chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13"></path><path d="m13 6 6 6-6 6"></path></svg>',
stop:'<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"></rect></svg>',
back:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>',
refresh:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-14.9-4L3 10"></path><path d="M3 4v6h6"></path><path d="M4 13a8.1 8.1 0 0 0 14.9 4L21 14"></path><path d="M21 20v-6h-6"></path></svg>',
home:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 10 9-7 9 7"></path><path d="M5 9v11h14V9"></path><path d="M9 20v-6h6v6"></path></svg>',
list:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 6h13"></path><path d="M8 12h13"></path><path d="M8 18h13"></path><path d="M3 6h.01"></path><path d="M3 12h.01"></path><path d="M3 18h.01"></path></svg>',
bell:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M10 21h4"></path></svg>',
plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>',
gear:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.1"></circle><path d="M19.2 14.4a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z"></path></svg>',
moon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path></svg>',
globe:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"></path></svg>',
spark:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"></path><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"></path></svg>',
plug:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 2v10"></path><path d="M18.4 6.6a9 9 0 1 1-12.8 0"></path></svg>',
copy:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2.5"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>',
clock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>',
bolt:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h6l-1 8 9-12h-6z"></path></svg>',
send:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"></path><path d="M22 2 15 22l-4-9-9-4z"></path></svg>'};
const icon=(name)=>ICONS[name]||ICONS.plus;
const engineMeta=(engine)=>engine==="acp"?{label:"ACP",cls:"acp"}:engine==="codex"?{label:"Codex",cls:"codex"}:{label:"Claude",cls:"claude"};
const localAgentIcon=url=>{const marker="cdn.agentclientprotocol.com/registry/";const at=url.indexOf(marker);if(at<0)return url;const file=url.slice(at+marker.length).split("/").pop();return /^[\\w-]+\\.svg$/.test(file)?"/agent-icons/"+file:url};
const agentMark=(session,fallback)=>{const icon=session.engineIcon;if(!icon)return fallback;if(/^https?:/.test(icon))return'<img class="agent-logo" src="'+esc(localAgentIcon(icon))+'" alt="" draggable="false">';if(icon.codePointAt(0)>255)return'<span class="agent-logo-emoji">'+esc(icon)+'</span>';return fallback};
const engineTag=(session)=>{const meta=engineMeta(session.engine);const mark=agentMark(session,"");return mark?mark+'<span class="engine-name">'+meta.label+'</span>':'<span class="engine-badge '+meta.cls+'">'+meta.label+'</span>'};
const sessions=[]; const snapshots=new Map(); let selectedId=null; let previousView="console"; let view="console"; let search=""; let filter="all"; let loading=false; let connected=false; let socket=null; let reconnectTimer=null; let sessionRefreshTimer=null; let renderFrame=0; let controlsOpen=false; let detailSessionId=null; let detailStructureKey=""; let connectionOpen=false; let createOpen=false; let createBusy=false; let createError=""; const createDraft={engine:"claude",project:"",custom:""};
const scheduleRender=()=>{if(renderFrame)return;renderFrame=requestAnimationFrame(()=>{renderFrame=0;render()})};
const summaryFor=(snapshot)=>snapshot.session;
const statusFor=(session)=>session.hasPendingPermission?"attention":session.isProcessing?"working":"idle";
const statusText=(session)=>statusFor(session)==="attention"?labels.approval:statusFor(session)==="working"?labels.working:labels.idle;
const sessionRank=(session)=>session.hasPendingPermission?0:session.isProcessing?1:2;
const relativeTime=(timestamp)=>{if(!timestamp)return"";const delta=Math.max(0,Date.now()-timestamp);if(delta<60e3)return text("just now","刚刚");if(delta<3600e3)return Math.floor(delta/60e3)+text("m ago","分钟前");if(delta<86400e3)return Math.floor(delta/3600e3)+text("h ago","小时前");return new Date(timestamp).toLocaleDateString(isZh?"zh-CN":"en-US",{month:"short",day:"numeric"})};
const fmtTokens=(value)=>{const n=Number(value)||0;if(n>=1000){const k=n/1000;return (k>=100?Math.round(k):Math.round(k*10)/10)+"k"}return String(n)};
const api=async(path,options={})=>{const headers=Object.assign({"content-type":"application/json"},options.headers||{});if(token)headers.authorization="Bearer "+token;const response=await fetch(path,Object.assign({},options,{headers}));const raw=await response.text();let body={};try{body=raw?JSON.parse(raw):{}}catch{}if(response.status===401){throw Error("AUTH_REQUIRED")}if(!response.ok)throw Error(body.error||text("Request failed","请求失败"));return body};
const upsertSession=(session)=>{const index=sessions.findIndex(item=>item.id===session.id);if(index===-1)sessions.push(session);else sessions[index]=session};
const selectedSnapshot=()=>selectedId?snapshots.get(selectedId):null;
const modelLabel=(value,models=[])=>{const option=models.find(item=>item.value===value);return option?.displayName||(!value||value==="default"?labels.defaultModel:value)};
const permissionLabel=(value)=>value==="acceptEdits"?labels.acceptEdits:value==="bypassPermissions"?labels.allowAll:labels.askFirst;
function sessionControlsHtml(snapshot){const session=snapshot.session,models=session.availableModels||[],configOptions=session.availableConfigOptions||[],selectedModel=session.model||"default",mode=session.permissionMode||"default",acpBehavior=session.acpPermissionBehavior||"ask",selectedOption=models.find(item=>item.value===selectedModel),effortOptions=selectedOption?.supportedEffortLevels?.length?selectedOption.supportedEffortLevels:(selectedOption?.supportsEffort?["low","medium","high","max"]:[]),selectedEffort=session.effort||selectedOption?.defaultReasoningEffort||effortOptions[1]||effortOptions[0]||"",isAcp=session.engine==="acp",canApply=!isAcp||configOptions.length>0||!!session.acpPermissionBehavior;const modelOptions=models.length?models.map(model=>'<option value="'+esc(model.value)+'" '+(model.value===selectedModel?'selected':'')+'>'+esc(model.displayName)+(model.description?' · '+esc(model.description):'')+'</option>').join(""):('<option value="'+esc(selectedModel)+'" selected>'+esc(modelLabel(selectedModel))+'</option>');const modelField=isAcp?"":'<label class="control-field"><span>'+labels.model+'</span><select id="settings-model">'+modelOptions+'</select></label>';const effortField=effortOptions.length&&!isAcp?'<label class="control-field"><span>'+labels.effort+'</span><select id="settings-effort">'+effortOptions.map(value=>'<option value="'+esc(value)+'" '+(value===selectedEffort?'selected':'')+'>'+esc(value==="low"?labels.effortLow:value==="medium"?labels.effortMedium:value==="high"?labels.effortHigh:value==="max"?labels.effortMax:value)+'</option>').join("")+'</select></label>':"";const acpFields=configOptions.length?configOptions.map(option=>{const values=(option.options||[]).flatMap(item=>Array.isArray(item.options)?item.options:[item]);return'<label class="control-field"><span>'+esc(option.name)+'</span><select data-config-id="'+esc(option.id)+'">'+values.map(value=>'<option value="'+esc(value.value)+'" '+(value.value===option.currentValue?'selected':'')+'>'+esc(value.name)+(value.description?' · '+esc(value.description):'')+'</option>').join("")+'</select></label>'}).join(""):('<div class="control-note">'+labels.configUnavailable+'</div>');const acpPermissionField=isAcp?'<label class="control-field"><span>'+labels.acpPermission+'</span><select id="settings-acp-permission"><option value="ask" '+(acpBehavior==="ask"?'selected':'')+'>'+labels.acpAsk+'</option><option value="auto_accept" '+(acpBehavior==="auto_accept"?'selected':'')+'>'+labels.acpAutoAccept+'</option><option value="allow_all" '+(acpBehavior==="allow_all"?'selected':'')+'>'+labels.acpAllowAll+'</option></select></label>':"";return'<section class="approval-panel"><div class="controls-heading"><div><h2>'+labels.controls+'</h2><p>'+labels.settingsHint+'</p></div><button type="button" class="detail-control-button" id="controls-close">'+labels.cancel+'</button></div><form id="settings-form"><div class="control-grid">'+(isAcp?acpPermissionField+acpFields:modelField+effortField+'<label class="control-field"><span>'+labels.permissionMode+'</span><select id="settings-permission"><option value="default" '+(mode==="default"?'selected':'')+'>'+labels.askFirst+'</option><option value="acceptEdits" '+(mode==="acceptEdits"?'selected':'')+'>'+labels.acceptEdits+'</option><option value="bypassPermissions" '+(mode==="bypassPermissions"?'selected':'')+'>'+labels.allowAll+'</option></select></label><label class="toggle-row"><span class="toggle-copy"><strong>'+labels.planMode+'</strong><small>'+labels.planHint+'</small></span><input id="settings-plan" type="checkbox" '+(session.planMode?'checked':'')+'></label>')+'</div><div class="controls-actions"><button type="button" class="secondary" id="controls-cancel">'+labels.cancel+'</button><button type="submit" class="primary" '+(canApply?"":"disabled")+'>'+labels.apply+'</button></div></form></section>'}
function authScreen(message=""){root.innerHTML='<div class="auth-screen"><section class="auth-card"><div class="auth-actions">'+languageToggleHtml()+'</div><div class="brand-mark">L</div><p class="eyebrow">L&#39;AGENTS WEBUI</p><h1>'+labels.connectTitle+'</h1><p>'+labels.connectBody+'</p>'+(message?'<div class="error-banner">'+esc(message)+'</div>':'')+'<form id="token-form"><label for="token">'+labels.token+'</label><input id="token" type="password" autocomplete="current-password" placeholder="'+labels.token+'" required><button class="primary" type="submit">'+labels.connect+'</button></form></section></div>';bindLanguageToggle();const form=document.getElementById("token-form");form.onsubmit=(event)=>{event.preventDefault();const value=document.getElementById("token").value.trim();if(!value)return;token=value;localStorage.setItem("harnss-remote-token",token);history.replaceState(null,"","/");boot()}}
function connectionHtml(){return'<div class="connection '+(connected?"":"offline")+'"><span class="dot"></span>'+ (connected?labels.connected:labels.offline)+'</div>'}
function sessionCard(session){const status=statusFor(session), title=session.title||text("Untitled session","未命名会话");return'<button class="session-card '+(status==="attention"?"attention":"")+(session.hasUnreadCompletion?" unread":"")+'" data-session-id="'+esc(session.id)+'"><span class="session-icon '+status+' '+engineMeta(session.engine).cls+'">'+(status==="attention"?"!":agentMark(session,engineMeta(session.engine).label.charAt(0)))+'</span><span class="session-copy"><span class="session-title">'+esc(title)+'</span><span class="session-meta">'+esc(session.projectName||session.projectId||"")+' · '+esc(modelLabel(session.model||session.engine||"agent"))+(session.lastMessageAt?" · "+relativeTime(session.lastMessageAt):"")+'</span><span class="session-status '+status+'"><span class="dot"></span>'+statusText(session)+'</span></span>'+icon("arrow")+'</button>'}
function navHtml(active,attention){return'<nav class="bottom-nav" aria-label="'+labels.app+'"><button class="nav-item '+(active==="console"?"active":"")+'" data-view="console">'+icon("home")+'<span>'+labels.consoleTab+'</span></button><button class="nav-item '+(active==="sessions"?"active":"")+'" data-view="sessions">'+icon("list")+(attention?'<span class="nav-badge">'+attention+'</span>':"")+'<span>'+labels.sessions+'</span></button></nav>'}
function matchesSession(session,query){return!query||[session.title,session.projectName,session.projectId,session.engine,session.model].some(value=>String(value||"").toLowerCase().includes(query))}
function orderedSessions(items){return items.slice().sort((a,b)=>(sessionRank(a)-sessionRank(b))||((b.lastMessageAt||b.createdAt||0)-(a.lastMessageAt||a.createdAt||0)))}
function listMarkup(items){return items.length?'<section class="session-list">'+orderedSessions(items).map(sessionCard).join("")+'</section>':'<div class="empty-state"><strong>'+labels.noSessions+'</strong>'+labels.noSessionsHint+'</div>'}
function emptyListHtml(){return'<div class="empty-state"><strong>'+labels.noSessions+'</strong>'+labels.noSessionsHint+'</div>'}
function chipRowHtml(processing,attention){const chip=(value,label)=>'<div class="chip"><strong>'+value+'</strong><span>'+label+'</span></div>';return'<div class="chip-row">'+chip(connected?labels.online:labels.offline,labels.link)+chip(String(sessions.length),labels.sessions)+chip(String(processing),labels.active)+chip(String(attention),labels.approval)+chip("1",labels.device)+'</div>'}
function statGridHtml(processing,attention){const latest=sessions.reduce((acc,session)=>Math.max(acc,session.lastMessageAt||session.createdAt||0),0);const card=(iconName,value,label)=>'<div class="stat-card"><span class="stat-icon">'+icon(iconName)+'</span><div class="stat-copy"><strong>'+value+'</strong><span>'+label+'</span></div></div>';return'<div class="stat-grid">'+card("list",String(sessions.length),labels.sessions)+card("bolt",String(processing),labels.active)+card("bell",String(attention),labels.approval)+card("clock",latest?relativeTime(latest):"—",labels.latest)+'</div>'}
function settingsListHtml(){return'<section class="home-section"><div class="section-header"><h2>'+text("Settings","设置")+'</h2></div><div class="settings-list"><div class="setting-row"><span class="setting-icon">'+icon("moon")+'</span><div class="setting-copy"><strong>'+labels.appearance+'</strong><small>'+labels.appearanceHint+'</small></div><div class="segmented" role="group"><button type="button" class="'+(theme==="light"?"active":"")+'" data-set-theme="light">'+labels.lightMode+'</button><button type="button" class="'+(theme==="dark"?"active":"")+'" data-set-theme="dark">'+labels.darkMode+'</button></div></div><div class="setting-row"><span class="setting-icon">'+icon("globe")+'</span><div class="setting-copy"><strong>'+labels.languageRow+'</strong><small>'+(isZh?"跟随系统 · 中文":"Follow system · English")+'</small></div><div class="segmented" role="group"><button type="button" class="'+(isZh?"active":"")+'" data-set-language="zh">中</button><button type="button" class="'+(!isZh?"active":"")+'" data-set-language="en">En</button></div></div><div class="setting-row"><span class="setting-icon">'+icon("spark")+'</span><div class="setting-copy"><strong>'+labels.thinkingRow+'</strong><small>'+labels.thinkingHint+'</small></div><label class="switch"><input type="checkbox" id="thinking-toggle" '+(showThinking?"checked":"")+' aria-label="'+labels.thinkingRow+'"><span></span></label></div><button type="button" class="setting-row" id="open-connection"><span class="setting-icon">'+icon("plug")+'</span><div class="setting-copy"><strong>'+labels.connection+'</strong><small>'+labels.connectionHint+'</small></div><span class="chevron-slot">'+icon("arrow")+'</span></button></div></section>'}
function consoleHtml(processing,attention){const attentionBody=attention?'<button type="button" class="attention-summary" data-attention-tap><span class="summary-icon">!</span><span><strong>'+attention+" "+labels.approval+'</strong><span>'+labels.needsAction+'</span></span>'+icon("arrow")+'</button>':'<div class="attention-summary"><span class="summary-icon">✓</span><span><strong>'+labels.allClear+'</strong><span>'+labels.allClearHint+'</span></span></div>';const recent=orderedSessions(sessions).slice(0,3);return'<section class="hero-card"><div class="hero-main"><div class="hero-mark">L</div><div class="hero-copy"><h1>'+esc(labels.gateway)+'</h1><p class="hero-sub">'+labels.linkRelay+'</p><p class="hero-status '+(connected?"":"offline")+'"><span class="dot"></span>'+(connected?labels.connected+" · "+text("Realtime","实时"):labels.offline)+'</p></div><button type="button" class="manage-button" id="manage">'+labels.manage+'</button></div>'+chipRowHtml(processing,attention)+'</section>'+statGridHtml(processing,attention)+'<section class="home-section"><div class="section-header"><h2>'+labels.needsAction+'</h2><span>'+attention+'</span></div>'+attentionBody+'</section><section class="home-section"><div class="section-header"><h2>'+labels.recentActivity+'</h2><button type="button" class="section-link" data-view="sessions">'+labels.seeAll+'</button></div>'+(recent.length?listMarkup(recent):emptyListHtml())+'</section>'+settingsListHtml()}
function sessionsHtml(){const query=search.trim().toLowerCase();const matching=sessions.filter(session=>matchesSession(session,query));const list=orderedSessions(matching).filter(session=>filter==="all"||(filter==="working"&&session.isProcessing)||(filter==="approval"&&session.hasPendingPermission));return'<section class="page-heading"><div><p class="kicker">'+labels.app+'</p><h1>'+labels.sessions+'</h1></div><button type="button" class="new-chat-button" id="new-chat">'+icon("plus")+labels.newChat+'</button></section><div class="toolbar"><label class="search-box">'+icon("search")+'<input id="search" type="search" value="'+esc(search)+'" placeholder="'+labels.search+'" autocomplete="off"></label><div class="filters"><button type="button" class="filter '+(filter==="all"?"active":"")+'" data-filter="all">'+labels.all+'</button><button type="button" class="filter '+(filter==="working"?"active":"")+'" data-filter="working">'+labels.working+'</button><button type="button" class="filter '+(filter==="approval"?"active":"")+'" data-filter="approval">'+labels.approval+'</button></div></div>'+(loading&&!sessions.length?'<div class="loading-card">'+labels.loading+'</div>':listMarkup(list))}
function connectionSheetHtml(){return'<div class="controls-heading"><div><h2>'+labels.connection+'</h2><p>'+labels.tokenNote+'</p></div><button type="button" class="detail-control-button" id="sheet-close">'+labels.close+'</button></div><div class="control-grid"><div class="control-field"><span>'+labels.serverField+'</span><strong class="control-value">'+esc(location.host)+'</strong></div><div class="control-field"><span>'+labels.statusField+'</span><strong class="control-value '+(connected?"ok":"bad")+'">'+(connected?labels.connected:labels.offline)+'</strong></div></div><div class="controls-actions"><button type="button" class="secondary" id="reconnect">'+labels.reconnect+'</button><button type="button" class="danger" id="signout">'+labels.signOut+'</button></div>'}
function createSheetHtml(){const known=[];sessions.forEach(session=>{const name=session.projectName||session.projectId;if(name&&known.indexOf(name)<0)known.push(name)});const selected=createDraft.project||(known[0]||"__custom__");const options=known.map(name=>'<option value="'+esc(name)+'" '+(name===selected?'selected':'')+'>'+esc(name)+'</option>').join("")+'<option value="__custom__" '+(selected==="__custom__"?'selected':'')+'>'+esc(labels.customProject)+'</option>';const engineButton=(value,label)=>'<button type="button" class="'+(createDraft.engine===value?"active":"")+'" data-create-engine="'+value+'">'+label+'</button>';return'<div class="controls-heading"><div><h2>'+labels.newChat+'</h2><p>'+labels.createHint+'</p></div><button type="button" class="detail-control-button" id="sheet-close">'+labels.close+'</button></div><form id="create-form"><div class="control-grid"><div class="control-field"><span>'+labels.engineLabel+'</span><div class="segmented" role="group">'+engineButton("claude","Claude")+engineButton("codex","Codex")+engineButton("acp","ACP")+'</div></div><label class="control-field"><span>'+labels.projectLabel+'</span><select id="create-project">'+options+'</select></label><label class="control-field" id="create-custom-field" style="display:'+(selected==="__custom__"?"block":"none")+'"><span>'+labels.projectLabel+'</span><input id="create-custom" type="text" value="'+esc(createDraft.custom)+'" placeholder="/Users/me/project" autocomplete="off"></label></div>'+(createError?'<div class="error-banner">'+esc(createError)+'</div>':"")+'<div class="controls-actions"><button type="submit" class="primary" '+(createBusy?"disabled":"")+'>'+(createBusy?labels.creating:labels.create)+'</button></div></form>'}
function sheetHtml(){if(connectionOpen)return'<div class="controls-overlay" id="sheet-overlay"><div class="controls-sheet">'+connectionSheetHtml()+'</div></div>';if(createOpen)return'<div class="controls-overlay" id="sheet-overlay"><div class="controls-sheet">'+createSheetHtml()+'</div></div>';return""}
function topbarHtml(){return'<div class="topbar"><div class="topbar-left">'+languageToggleHtml()+'</div><p class="topbar-center">'+(view==="console"?labels.consoleTab:labels.sessions)+'</p><div class="topbar-actions">'+connectionHtml()+'<button class="icon-button" id="refresh" aria-label="'+labels.refresh+'" title="'+labels.refresh+'">'+icon("refresh")+'</button></div></div>'}
function renderList(){const processing=sessions.filter(session=>session.isProcessing).length,attention=sessions.filter(session=>session.hasPendingPermission).length;root.innerHTML=topbarHtml()+(view==="console"?consoleHtml(processing,attention):sessionsHtml())+sheetHtml()+navHtml(view,attention);bindLanguageToggle();document.getElementById("refresh").onclick=()=>loadSessions();document.querySelectorAll("[data-view]").forEach(button=>button.onclick=()=>{view=button.dataset.view;renderList()});const attentionTap=document.querySelector("[data-attention-tap]");if(attentionTap)attentionTap.onclick=()=>{view="sessions";filter="approval";renderList()};const manageButton=document.getElementById("manage");if(manageButton)manageButton.onclick=()=>{connectionOpen=true;renderList()};document.querySelectorAll("[data-set-theme]").forEach(button=>button.onclick=()=>{theme=button.dataset.setTheme;localStorage.setItem("harnss-remote-theme",theme);applyTheme();renderList()});document.querySelectorAll("[data-set-language]").forEach(button=>button.onclick=()=>setLanguage(button.dataset.setLanguage));const thinkingToggle=document.getElementById("thinking-toggle");if(thinkingToggle)thinkingToggle.onchange=()=>{showThinking=thinkingToggle.checked;localStorage.setItem("harnss-remote-thinking",showThinking?"1":"0")};if(view==="sessions"){const searchInput=document.getElementById("search");if(searchInput)searchInput.oninput=event=>{search=event.target.value;renderList();const next=document.getElementById("search");next.focus();next.setSelectionRange(search.length,search.length)};document.querySelectorAll("[data-filter]").forEach(button=>button.onclick=()=>{filter=button.dataset.filter;renderList()});const newChat=document.getElementById("new-chat");if(newChat)newChat.onclick=()=>{createOpen=true;createError="";renderList()}}document.querySelectorAll("[data-session-id]").forEach(button=>button.onclick=()=>selectSession(button.dataset.sessionId));if(connectionOpen){const overlay=document.getElementById("sheet-overlay");overlay.onclick=event=>{if(event.target===overlay){connectionOpen=false;renderList()}};document.getElementById("sheet-close").onclick=()=>{connectionOpen=false;renderList()};document.getElementById("reconnect").onclick=()=>{if(socket){socket.close();socket=null}connectSocket();connectionOpen=false;renderList()};document.getElementById("signout").onclick=()=>invalidateToken()}if(createOpen){const overlay=document.getElementById("sheet-overlay");overlay.onclick=event=>{if(event.target===overlay){createOpen=false;renderList()}};document.getElementById("sheet-close").onclick=()=>{createOpen=false;renderList()};document.querySelectorAll("[data-create-engine]").forEach(button=>button.onclick=()=>{createDraft.engine=button.dataset.createEngine;renderList()});const select=document.getElementById("create-project");const customField=document.getElementById("create-custom-field");const customInput=document.getElementById("create-custom");select.onchange=()=>{createDraft.project=select.value;customField.style.display=select.value==="__custom__"?"block":"none";if(select.value==="__custom__")customInput.focus()};customInput.oninput=()=>{createDraft.custom=customInput.value};document.getElementById("create-form").onsubmit=async event=>{event.preventDefault();const projectId=select.value==="__custom__"?customInput.value.trim():select.value;if(!projectId){createError=labels.createNeedProject;renderList();return}createBusy=true;createError="";renderList();try{await api("/api/sessions",{method:"POST",body:JSON.stringify({projectId:projectId,engine:createDraft.engine||"claude"})});createOpen=false;createBusy=false;createDraft.project="";createDraft.custom="";await loadSessions();const created=orderedSessions(sessions.filter(session=>(session.projectName||session.projectId)===projectId))[0];if(created)void selectSession(created.id);else render()}catch(error){createBusy=false;if(error.message==="AUTH_REQUIRED"){invalidateToken();return}createError=error.message;render()}}}}

function taskProgressHtml(message){const steps=message.subagentSteps||[];if(!steps.length)return"";const completed=steps.filter(step=>step.status==="completed").length,percent=message.subagentStatus==="completed"?100:Math.round(completed/steps.length*100);return'<div class="task-progress"><div class="task-progress-head"><span>'+labels.subagentProgress+'</span><span>'+completed+'/'+steps.length+" "+labels.steps+'</span></div><div class="task-progress-bar"><span style="width:'+percent+'%"></span></div><div class="task-steps">'+steps.map(step=>'<div class="task-step '+(step.status==="completed"?"done":step.status==="error"?"error":"")+'">'+esc(step.toolName)+'</div>').join("")+'</div></div>'}
function mdLite(src){let s=esc(src);const tick=String.fromCharCode(96);s=s.replace(new RegExp(tick+tick+tick+"[\\\\w-]*\\\\n?([\\\\s\\\\S]*?)"+tick+tick+tick,"g"),function(_,code){return'<pre class="md-code">'+code.replace(/\\n+$/,"")+'</pre>'});s=s.replace(new RegExp(tick+"([^"+tick+"\\\\n]+)"+tick,"g"),'<code class="md-inline">$1</code>');s=s.replace(/\\*\\*([^*\\n]+)\\*\\*/g,'<strong>$1</strong>');s=s.replace(/^#{1,3} +(.+)$/gm,'<strong class="md-h">$1</strong>');return s}
function messageHtml(message){const content=message.displayContent||message.content||message.toolSummary||"";const roleTag=message.role==="system"||message.role==="summary"?'<span class="foot-role">'+esc(message.role==="system"?labels.system:labels.summary)+'</span>':"";if(message.role==="tool_call"||message.role==="tool_result")return toolMessageHtml(message);const rich=message.role!=="user";const body='<div class="message-body">'+(rich?mdLite(content):esc(content))+'</div>'+(message.thinking&&showThinking?'<details class="thinking-box"><summary>'+labels.thoughts+'</summary><div class="thinking">'+esc(message.thinking)+'</div></details>':'')+'<div class="message-foot">'+roleTag+'<button type="button" class="copy-btn" aria-label="'+labels.copy+'" title="'+labels.copy+'">'+icon("copy")+'</button><span class="message-time">'+relativeTime(message.timestamp)+'</span></div>';return'<article class="message '+esc(message.role)+(message.isStreaming?" streaming":"")+'">'+body+'</article>'}
function toolMessageHtml(message){const status=message.toolError?"error":message.subagentStatus==="running"?"running":"done";return'<details class="tool-message"><summary><span class="tool-status '+status+'"></span><span class="tool-summary-line">'+esc(message.toolName||labels.tool)+(message.toolSummary?" · "+esc(message.toolSummary):"")+'</span></summary>'+taskProgressHtml(message)+'<div class="tool-body">'+esc(message.content||message.toolSummary||text("No details available","暂无详细信息"))+'</div></details>'}
function conversationHtml(messages){const parts=[];let i=0,lastDay="";const dayOf=ts=>{const d=new Date(ts||0);return d.getFullYear()+"-"+d.getMonth()+"-"+d.getDate()};const dayLabel=ts=>new Date(ts||Date.now()).toLocaleDateString(isZh?"zh-CN":"en-US",{month:"short",day:"numeric"});const pushDivider=ts=>{const key=dayOf(ts);if(key!==lastDay){lastDay=key;parts.push('<div class="date-divider"><span>'+dayLabel(ts)+'</span></div>')}};while(i<messages.length){const message=messages[i];if(message.role==="tool_call"||message.role==="tool_result"){const run=[];while(i<messages.length&&(messages[i].role==="tool_call"||messages[i].role==="tool_result")){run.push(messages[i]);i++}pushDivider(run[0].timestamp);parts.push(run.length===1?toolMessageHtml(run[0]):'<details class="tool-group"><summary><span class="group-icon">⚙</span>'+run.length+" "+labels.toolsRun+'<span class="group-hint">'+esc(run[run.length-1].toolName||"")+'</span></summary><div class="tool-group-body">'+run.map(toolMessageHtml).join("")+'</div></details>');continue}pushDivider(message.timestamp);parts.push(messageHtml(message));i++}return parts.join("")}
function questionHtml(question){const options=question.options||[];return'<div class="approval-question"><label>'+esc(question.header||question.question)+'</label>'+(options.length?'<div class="choice-group">'+options.map(option=>'<button type="button" class="choice" data-question="'+esc(question.id)+'" data-value="'+esc(option.label)+'" data-multi="'+(question.multiSelect?"true":"false")+'">'+esc(option.label)+(option.description?'<br><span>'+esc(option.description)+'</span>':'')+'</button>').join("")+'</div>':'<input class="answer-input" data-answer-input="'+esc(question.id)+'" placeholder="'+labels.answer+'">')+'</div>'}
function approvalHtml(permission){const title=permission.kind==="user-input"?labels.answer:labels.permission;return'<section class="approval-panel"><div class="approval-header"><div class="approval-icon">!</div><div><h2>'+title+(permission.toolName?": "+esc(permission.toolName):"")+'</h2>'+(permission.summary?'<p>'+esc(permission.summary)+'</p>':'')+'</div></div>'+(permission.questions||[]).map(questionHtml).join("")+'<div class="approval-actions"><button type="button" class="danger" id="deny">'+labels.deny+'</button><button type="button" class="secondary" id="allow-session">'+labels.allowSession+'</button><button type="button" class="primary" id="allow">'+labels.allow+'</button></div></section>'}
function agentActionsHtml(snapshot){const hasLastUser=snapshot.messages.some(message=>message.role==="user"),buttons=[];if(snapshot.isProcessing)buttons.push('<button type="button" class="action-button danger-action" data-agent-action="interrupt">'+labels.stop+'</button>');if(!snapshot.isConnected)buttons.push('<button type="button" class="action-button" data-agent-action="activate">'+labels.openSession+'</button>');if(hasLastUser&&!snapshot.isProcessing)buttons.push('<button type="button" class="action-button" data-agent-action="retry">'+labels.retry+'</button>');const cost=Number(snapshot.totalCost)>0?'<span class="actions-cost">$'+Number(snapshot.totalCost).toFixed(3)+'</span>':"";if(!buttons.length)return cost?'<section class="agent-actions cost-only">'+cost+'</section>':"";return'<section class="agent-actions"><div class="action-grid">'+buttons.join("")+'</div>'+cost+'</section>'}
function tokenMeterHtml(snapshot){const usage=snapshot.contextUsage;if(!usage||!usage.contextWindow)return"";const used=Math.min(usage.contextWindow,(usage.inputTokens||0)+(usage.cacheReadTokens||0)+(usage.cacheCreationTokens||0));const percent=Math.min(100,Math.round(used/usage.contextWindow*100));const remain=Math.max(0,usage.contextWindow-used);return'<section class="token-meter"><div class="token-meter-head"><span>'+fmtTokens(used)+" / "+fmtTokens(usage.contextWindow)+'</span><span>'+text(remain+" left","剩余 "+fmtTokens(remain))+'</span></div><div class="token-meter-bar"><span style="width:'+percent+'%"></span></div></section>'}
function renderDetail(){const previousField=document.getElementById("message"),previousDraft=previousField?.value,previousSelectionStart=previousField?.selectionStart,previousSelectionEnd=previousField?.selectionEnd,previousScroll=previousField?window.scrollY:null;const followLatest=previousScroll===null||document.documentElement.scrollHeight-(previousScroll+window.innerHeight)<160;const current=selectedSnapshot(),summary=sessions.find(session=>session.id===selectedId)||current?.session;if(!summary){selectedId=null;detailSessionId=null;detailStructureKey="";renderList();return}if(!current){detailSessionId=selectedId;detailStructureKey="loading";root.innerHTML='<div class="detail-topbar"><div class="detail-heading"><button class="back-button" id="back" aria-label="'+labels.back+'">'+icon("back")+'</button><div class="detail-heading-copy"><h1>'+esc(summary.title)+'</h1><p>'+esc(summary.projectName||summary.projectId||"")+'</p></div></div></div><div class="loading-card">'+labels.loading+'</div>';document.getElementById("back").onclick=()=>{selectedId=null;detailSessionId=null;view=previousView;renderList()};return}const status=statusFor(current.session);const structureKey=[controlsOpen?1:0,current.pendingPermission?1:0,current.isProcessing?1:0,status,current.truncated?1:0,Math.round(Number(current.totalCost||0)*1000),current.contextUsage?JSON.stringify(current.contextUsage):"",current.isConnected?1:0].join(":");if(detailSessionId===selectedId&&detailStructureKey===structureKey){const conversation=document.querySelector(".conversation");if(conversation){const distance=previousScroll===null?0:document.documentElement.scrollHeight-(previousScroll+window.innerHeight);conversation.innerHTML=(current.truncated?'<div class="empty-state">'+labels.older+'</div>':"")+(current.messages.length?conversationHtml(current.messages):'<div class="empty-state">'+labels.noMessage+'</div>');if(followLatest)requestAnimationFrame(()=>window.scrollTo({top:document.documentElement.scrollHeight,behavior:"auto"}));else if(previousScroll!==null)window.scrollTo(0,document.documentElement.scrollHeight-window.innerHeight-distance)}return}detailSessionId=selectedId;detailStructureKey=structureKey;const session=current.session;const meta=engineMeta(session.engine);root.innerHTML='<div class="detail-topbar"><div class="detail-heading"><button class="back-button" id="back" aria-label="'+labels.back+'">'+icon("back")+'</button><span class="detail-avatar '+meta.cls+'">'+(agentMark(session,meta.label.charAt(0)))+'</span><div class="detail-heading-copy"><h1>'+esc(current.session.title)+'</h1><p><span class="mini-dot '+status+'"></span>'+statusText(session)+' · '+esc(modelLabel(session.model,session.availableModels||[]))+'</p></div></div><div class="detail-actions"><button class="icon-button" id="controls-toggle" type="button" aria-label="'+labels.settings+'">'+icon("gear")+'</button><button class="icon-button" id="detail-refresh" aria-label="'+labels.refresh+'">'+icon("refresh")+'</button></div></div>'+agentActionsHtml(current)+'<section class="conversation">'+(current.truncated?'<div class="empty-state">'+labels.older+'</div>':"")+(current.messages.length?conversationHtml(current.messages):'<div class="empty-state">'+labels.noMessage+'</div>')+'</section><div class="composer-wrap">'+'<form class="composer" id="send-form">'+tokenMeterHtml(current)+'<textarea id="message" rows="1" placeholder="'+labels.inputPlaceholder+'" required></textarea><div class="composer-bar"><span class="composer-hint">'+labels.sendHint+'</span><div class="bar-actions">'+(current.isProcessing?'<button class="send-button stop" type="button" id="stop-button" aria-label="'+labels.stop+'">'+icon("stop")+'</button>':"")+'<button class="send-button" type="submit" aria-label="'+labels.send+'">'+icon("send")+'</button></div></div></form></div>'+(controlsOpen?'<div class="controls-overlay" id="controls-overlay"><div class="controls-sheet">'+sessionControlsHtml(current)+'</div></div>':"")+(current.pendingPermission?'<div class="controls-overlay approval-overlay"><div class="controls-sheet">'+approvalHtml(current.pendingPermission)+'</div></div>':"");bindLanguageToggle();document.getElementById("back").onclick=()=>{selectedId=null;detailSessionId=null;controlsOpen=false;view=previousView;renderList()};document.getElementById("controls-toggle").onclick=()=>{controlsOpen=!controlsOpen;renderDetail()};document.getElementById("detail-refresh").onclick=()=>loadSnapshot(selectedId);document.querySelectorAll("[data-agent-action]").forEach(button=>button.onclick=async()=>{const action=button.dataset.agentAction;button.disabled=true;try{await api("/api/sessions/"+encodeURIComponent(selectedId)+"/actions",{method:"POST",body:JSON.stringify({action})});await loadSnapshot(selectedId)}catch(error){if(error.message==="AUTH_REQUIRED")invalidateToken();else alert(error.message)}finally{button.disabled=false}});if(controlsOpen){const closeControls=()=>{controlsOpen=false;renderDetail()};document.getElementById("controls-overlay").onclick=event=>{if(event.target===event.currentTarget)closeControls()};document.getElementById("controls-close").onclick=closeControls;document.getElementById("controls-cancel").onclick=closeControls;document.getElementById("settings-form").onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector("button[type=submit]");button.disabled=true;try{const modelField=document.getElementById("settings-model"),payload={};if(modelField)payload.model=modelField.value;const acpPermissionField=document.getElementById("settings-acp-permission");if(acpPermissionField)payload.acpPermissionBehavior=acpPermissionField.value;const permissionField=document.getElementById("settings-permission");const planField=document.getElementById("settings-plan");const effortField=document.getElementById("settings-effort");if(permissionField)payload.permissionMode=permissionField.value;if(planField)payload.planMode=planField.checked;if(effortField)payload.effort=effortField.value;const configValues={};document.querySelectorAll("[data-config-id]").forEach(field=>{configValues[field.dataset.configId]=field.value});if(Object.keys(configValues).length)payload.configValues=configValues;await api("/api/sessions/"+encodeURIComponent(selectedId)+"/settings",{method:"POST",body:JSON.stringify(payload)});controlsOpen=false;await loadSnapshot(selectedId)}catch(error){if(error.message==="AUTH_REQUIRED")invalidateToken();else alert(error.message)}finally{button.disabled=false}}}bindComposer(current.session.id);if(previousDraft!==undefined){const nextField=document.getElementById("message");nextField.value=previousDraft;nextField.style.height="auto";nextField.style.height=Math.min(nextField.scrollHeight,120)+"px";if(document.activeElement===previousField){nextField.focus();if(previousSelectionStart!==null&&previousSelectionStart!==undefined)nextField.setSelectionRange(previousSelectionStart,previousSelectionEnd??previousSelectionStart)}}if(followLatest)requestAnimationFrame(()=>window.scrollTo({top:document.documentElement.scrollHeight,behavior:"auto"}));else if(previousScroll!==null)window.scrollTo(0,previousScroll);if(current.pendingPermission)bindApproval(current)}
function render(){document.body.dataset.detail=selectedId?"1":"";if(!token)return authScreen();if(selectedId)renderDetail();else renderList()}
function invalidateToken(){token="";localStorage.removeItem("harnss-remote-token");connectionOpen=false;createOpen=false;if(socket){socket.close();socket=null}authScreen(labels.invalidToken)}
async function loadSessions(){if(!token)return;loading=true;render();try{const data=await api("/api/sessions");sessions.splice(0,sessions.length,...(data.sessions||[]));const liveIds=new Set(sessions.map(session=>session.id));for(const id of snapshots.keys())if(!liveIds.has(id)&&id!==selectedId)snapshots.delete(id)}catch(error){if(error.message==="AUTH_REQUIRED"){invalidateToken();return}}finally{loading=false;render()}}
const acceptSnapshot=(id,snapshot)=>{const previous=snapshots.get(id);if(previous?.revision!==undefined&&snapshot?.revision!==undefined&&snapshot.revision<previous.revision)return false;snapshots.set(id,snapshot);upsertSession(summaryFor(snapshot));return true};
async function loadSnapshot(id){if(!token)return;try{const snapshot=await api("/api/sessions/"+encodeURIComponent(id));if(id!==selectedId&&selectedId!==null)return;if(acceptSnapshot(id,snapshot)){selectedId=id;render()}}catch(error){if(error.message==="AUTH_REQUIRED")invalidateToken();else root.insertAdjacentHTML("afterbegin",'<div class="error-banner">'+esc(error.message)+'</div>')}}
async function selectSession(id){previousView=view;selectedId=id;controlsOpen=false;render();await loadSnapshot(id)}
function collectAnswers(){const answers={};document.querySelectorAll("[data-answer-input]").forEach(input=>{if(input.value.trim())answers[input.dataset.answerInput]=[input.value.trim()]});document.querySelectorAll(".choice.is-selected").forEach(button=>{const id=button.dataset.question;answers[id]=answers[id]||[];answers[id].push(button.dataset.value)});return answers}
function bindApproval(snapshot){const permission=snapshot.pendingPermission,requiresAnswers=permission.kind==="user-input"&&(permission.questions||[]).length>0;const updateApprovalState=()=>{if(!requiresAnswers)return;const answers=collectAnswers();const complete=permission.questions.every(question=>Array.isArray(answers[question.id])&&answers[question.id].some(value=>value.trim()));document.querySelectorAll(".approval-actions #allow,.approval-actions #allow-session").forEach(button=>button.disabled=!complete)};document.querySelectorAll(".choice").forEach(button=>button.onclick=()=>{const group=button.parentElement;if(button.dataset.multi!=="true")group.querySelectorAll(".choice").forEach(item=>item.classList.remove("is-selected"));button.classList.toggle("is-selected");updateApprovalState()});document.querySelectorAll("[data-answer-input]").forEach(input=>input.oninput=updateApprovalState);const approve=async behavior=>{document.querySelectorAll(".approval-actions button").forEach(button=>button.disabled=true);try{await api("/api/sessions/"+encodeURIComponent(snapshot.session.id)+"/approvals/"+encodeURIComponent(permission.requestId),{method:"POST",body:JSON.stringify({behavior,answersByQuestionId:collectAnswers()})});await loadSnapshot(snapshot.session.id)}catch(error){if(error.message==="AUTH_REQUIRED")invalidateToken();else alert(error.message)}finally{document.querySelectorAll(".approval-actions button").forEach(button=>button.disabled=false);updateApprovalState()}};document.getElementById("allow").onclick=()=>approve("allow");document.getElementById("allow-session").onclick=()=>approve("allowForSession");document.getElementById("deny").onclick=()=>approve("deny");updateApprovalState()}
const refreshAfterMutation=(id)=>loadSnapshot(id);
function bindComposer(id){const form=document.getElementById("send-form"),field=document.getElementById("message"),button=form.querySelector("button[type=submit]");const stopButton=document.getElementById("stop-button");if(stopButton)stopButton.onclick=async()=>{stopButton.disabled=true;try{await api("/api/sessions/"+encodeURIComponent(id)+"/actions",{method:"POST",body:JSON.stringify({action:"interrupt"})});await refreshAfterMutation(id)}catch(error){stopButton.disabled=false;if(error.message==="AUTH_REQUIRED")invalidateToken();else alert(error.message)}};field.oninput=()=>{field.style.height="auto";field.style.height=Math.min(field.scrollHeight,120)+"px"};field.onkeydown=event=>{if(event.isComposing||event.keyCode===229)return;if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();if(typeof form.requestSubmit==="function")form.requestSubmit();else form.dispatchEvent(new Event("submit",{cancelable:true}))}};form.onsubmit=async event=>{event.preventDefault();const value=field.value.trim();if(!value)return;button.disabled=true;const current=snapshots.get(id),summary=sessions.find(session=>session.id===id),optimistic={id:"local-"+Date.now(),role:"user",content:value,timestamp:Date.now()};if(current){current.messages=current.messages.concat(optimistic);current.session.isProcessing=true}if(summary)summary.isProcessing=true;field.value="";field.style.height="auto";renderDetail();try{await api("/api/sessions/"+encodeURIComponent(id)+"/messages",{method:"POST",body:JSON.stringify({text:value})});await refreshAfterMutation(id)}catch(error){if(current){current.messages=current.messages.filter(message=>message.id!==optimistic.id);current.session.isProcessing=false}if(summary)summary.isProcessing=false;field.value=value;field.style.height="auto";field.style.height=Math.min(field.scrollHeight,120)+"px";renderDetail();if(error.message==="AUTH_REQUIRED")invalidateToken();else alert(error.message)}finally{button.disabled=false}}}
function connectSocket(){if(!token||socket)return;try{socket=new WebSocket((location.protocol==="https:"?"wss:":"ws:")+"//"+location.host+"/?token="+encodeURIComponent(token));socket.onopen=()=>{connected=true;scheduleRender();void loadSessions();if(selectedId)void loadSnapshot(selectedId)};socket.onmessage=event=>{const data=JSON.parse(event.data);if(data.type==="remote.ready"){connected=true;scheduleRender()}if(data.type==="session.updated"){if(acceptSnapshot(data.sessionId,data.snapshot))scheduleRender()}if(data.type==="sessions.updated"){clearTimeout(sessionRefreshTimer);sessionRefreshTimer=setTimeout(()=>loadSessions(),180)}};socket.onerror=()=>socket.close();socket.onclose=()=>{socket=null;connected=false;scheduleRender();clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connectSocket,2500)}}catch{socket=null}}
function boot(){if(!token){render();return}connectSocket();if("serviceWorker"in navigator)navigator.serviceWorker.register("/remote-sw.js").catch(()=>{})}
let pressTimer=null;const showCopied=()=>{let toast=document.querySelector(".copy-toast");if(!toast){toast=document.createElement("div");toast.className="copy-toast";document.body.appendChild(toast)}toast.textContent=labels.copied;toast.classList.add("show");clearTimeout(toast._timer);toast._timer=setTimeout(()=>toast.classList.remove("show"),1300)};
const copyMessageText=value=>{if(!value)return;showCopied();if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(value).catch(()=>fallbackCopy(value));else fallbackCopy(value)};
const fallbackCopy=value=>{const area=document.createElement("textarea");area.value=value;area.style.position="fixed";area.style.opacity="0";document.body.appendChild(area);area.select();try{document.execCommand("copy")}catch(_){}area.remove()};
document.addEventListener("click",event=>{const target=event.target&&event.target.closest?event.target.closest(".copy-btn"):null;if(!target)return;const card=target.closest(".message");if(!card)return;const body=card.querySelector(".message-body");if(body)copyMessageText(body.innerText||"")});
document.addEventListener("touchstart",event=>{const target=event.target&&event.target.closest?event.target.closest(".message"):null;if(!target)return;if(event.target.closest(".copy-btn"))return;const body=target.querySelector(".message-body");if(!body)return;clearTimeout(pressTimer);pressTimer=setTimeout(()=>copyMessageText(body.innerText||""),550)},{passive:true});
document.addEventListener("touchend",()=>clearTimeout(pressTimer),{passive:true});document.addEventListener("touchcancel",()=>clearTimeout(pressTimer),{passive:true});document.addEventListener("touchmove",()=>clearTimeout(pressTimer),{passive:true});
render();if(token)boot();
})()`;

const REMOTE_MANIFEST = JSON.stringify({
  name: "L'Agents WebUI",
  short_name: "L'Agents",
  start_url: "/",
  display: "standalone",
  background_color: "#0c1410",
  theme_color: "#0c1410",
  icons: [],
});
const AGENT_ICON_BASE_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/";
const MAX_AGENT_ICON_CACHE_ENTRIES = 32;
const agentIconCache = new Map<string, Buffer>();

const REMOTE_SW_JS = `const CACHE="harnss-remote-v8";self.addEventListener("install",()=>self.skipWaiting());self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));self.addEventListener("fetch",event=>{const url=new URL(event.request.url);if(event.request.method==="GET"&&url.origin===location.origin&&!url.pathname.startsWith("/api/")){event.respondWith(caches.open(CACHE).then(async cache=>{try{const response=await fetch(event.request);cache.put(event.request,response.clone());return response}catch(_){return (await cache.match(event.request))||new Response("Offline",{status:503})}}))}});`;

function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function getBearerToken(request: IncomingMessage, allowQueryToken = false): string | null {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length).trim();
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
  private readonly clients = new Set<WebSocket>();
  private unsubscribeBridge: (() => void) | null = null;
  private listening = false;
  private activePort: number | null = null;
  private lifecyclePromise: Promise<void> | null = null;

  constructor(private readonly bridge: RemoteControlBridge) {
    this.server.on("upgrade", (request, socket, head) => {
      const settings = getAppSettings();
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/voice") {
        // 2026-09-09：COVE 语音页已移除（语音由 L'Agents 原生 App 承担），
        // 旧语音 WS 入口直接拒绝，避免半可用状态。
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const token = getBearerToken(request, true);
      if (!tokenMatches(token, settings.remoteToken)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      this.webSockets.handleUpgrade(request, socket, head, (client) => {
        this.webSockets.emit("connection", client, request);
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
      // Required so the SW at /remote-sw.js may register with root scope "/".
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "service-worker-allowed": "/" });
      response.end(REMOTE_SW_JS);
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
