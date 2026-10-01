import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "crypto";
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
<meta name="theme-color" content="#f6f7f9"><meta name="mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.webmanifest"><title>L'Agents WebUI</title>
<link rel="stylesheet" href="/remote-client.css"></head>
<body><main id="root"><div class="boot-screen"><div class="brand-mark">L</div><p>Connecting to L'Agents…</p></div></main>
<script src="/remote-client.js"></script></body></html>`;

const REMOTE_MANIFEST = JSON.stringify({
  name: "L'Agents WebUI",
  short_name: "L'Agents",
  start_url: "/",
  display: "standalone",
  background_color: "#f6f7f9",
  theme_color: "#f6f7f9",
  icons: [],
});
const REMOTE_SW_JS = `const CACHE="harnss-remote-v17";self.addEventListener("install",()=>self.skipWaiting());self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));self.addEventListener("fetch",event=>{const url=new URL(event.request.url);if(event.request.method==="GET"&&url.origin===location.origin&&!url.pathname.startsWith("/api/")){event.respondWith(caches.open(CACHE).then(async cache=>{try{const response=await fetch(event.request);cache.put(event.request,response.clone());return response}catch(_){return (await cache.match(event.request))||new Response("Offline",{status:503})}}))}});`;

const REMOTE_ASSET_DIRS = [
  path.resolve(__dirname, "../../dist/remote-client"),
  path.resolve(process.cwd(), "dist/remote-client"),
];

function readRemoteAsset(name: string): Buffer {
  for (const directory of REMOTE_ASSET_DIRS) {
    try {
      return readFileSync(path.join(directory, name));
    } catch {
      // Try the next known development/packaged location.
    }
  }
  throw new Error(`Missing Remote WebUI asset: ${name}`);
}

const AGENT_ICON_BASE_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/";
const MAX_AGENT_ICON_CACHE_ENTRIES = 32;
const agentIconCache = new Map<string, Buffer>();

function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function getBearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;
}

function getCookie(request: IncomingMessage, name: string): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;
  for (const entry of cookieHeader.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    const key = entry.slice(0, separator).trim();
    if (key === name) return decodeURIComponent(entry.slice(separator + 1).trim());
  }
  return null;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    ...headers,
  });
  response.end(payload);
}

async function readJson(
  request: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
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
  private readonly authSessions = new Map<string, number>();
  private unsubscribeBridge: (() => void) | null = null;
  private listening = false;
  private activePort: number | null = null;
  private lifecyclePromise: Promise<void> | null = null;

  private hasAuthSession(request: IncomingMessage): boolean {
    const session = getCookie(request, "harnss_remote_session");
    if (!session) return false;
    const expiresAt = this.authSessions.get(session);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.authSessions.delete(session);
      return false;
    }
    return true;
  }

  private createAuthSession(): string {
    const session = randomBytes(32).toString("base64url");
    this.authSessions.set(session, Date.now() + 8 * 60 * 60 * 1000);
    return session;
  }

  private isAuthenticated(request: IncomingMessage): boolean {
    const settings = getAppSettings();
    return this.hasAuthSession(request) || tokenMatches(getBearerToken(request), settings.remoteToken);
  }

  constructor(private readonly bridge: RemoteControlBridge) {
    this.server.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/voice") {
        // 2026-09-09：COVE 语音页已移除（语音由 L'Agents 原生 App 承担），
        // 旧语音 WS 入口直接拒绝，避免半可用状态。
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!this.isAuthenticated(request)) {
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
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      });
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    // These assets contain no session data and are public so the browser can
    // load them from the token-protected HTML page and install the PWA.
    if (request.method === "GET" && url.pathname === "/remote-client.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(readRemoteAsset("remote-client.js"));
      return;
    }
    if (request.method === "GET" && url.pathname === "/remote-client.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
      response.end(readRemoteAsset("remote-client.css"));
      return;
    }
    if (request.method === "GET" && url.pathname === "/manifest.webmanifest") {
      response.writeHead(200, { "content-type": "application/manifest+json", "cache-control": "no-store" });
      response.end(REMOTE_MANIFEST);
      return;
    }
    if (request.method === "GET" && url.pathname === "/remote-sw.js") {
      // Required so the SW at /remote-sw.js may register with root scope "/".
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "service-worker-allowed": "/" });
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
      const headers: Record<string, string> = {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline';",
        "permissions-policy": "microphone=(self)",
      };
      if (forwardedProto === "https" || request.socket.encrypted) {
        headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
      }
      response.writeHead(200, headers);
      response.end(REMOTE_CLIENT_HTML);
      return;
    }
    if (url.pathname === "/api/auth/session") {
      if (request.method === "DELETE") {
        const session = getCookie(request, "harnss_remote_session");
        if (session) this.authSessions.delete(session);
        sendJson(response, 200, { ok: true }, {
          "set-cookie": "harnss_remote_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict",
        });
        return;
      }
      if (request.method !== "POST" || !this.isAuthenticated(request)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }
      const session = this.createAuthSession();
      const secure = forwardedProto === "https" || request.socket.encrypted ? "; Secure" : "";
      sendJson(response, 200, { ok: true }, {
        "set-cookie": `harnss_remote_session=${encodeURIComponent(session)}; Max-Age=28800; Path=/; HttpOnly; SameSite=Strict${secure}`,
      });
      return;
    }
    if (!this.isAuthenticated(request)) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { ok: true, version: 1 });
        return;
      }

      if (request.method === "GET" && parts.length === 2 && parts[0] === "api" && parts[1] === "projects") {
        const data = await this.bridge.request("projects.list");
        sendJson(response, 200, { projects: data });
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

      if (request.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "sessions" && validId(parts[2]) && parts[3] === "rename") {
        const body = await readJson(request);
        if (typeof body.title !== "string" || body.title.trim().length === 0 || body.title.length > 500) {
          sendJson(response, 400, { error: "title must be a non-empty string of at most 500 characters" });
          return;
        }
        const data = await this.bridge.request("sessions.rename", {
          sessionId: parts[2],
          title: body.title.trim(),
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
