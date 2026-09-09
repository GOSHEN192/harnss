import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { RemoteControlBridge } from "./bridge";

vi.mock("../lib/app-settings", () => ({
  getAppSettings: () => ({
    remoteEnabled: true,
    remotePort: 18987,
    remoteToken: "test-remote-token",
  }),
}));
vi.mock("../lib/logger", () => ({ log: vi.fn() }));

import { RemoteControlServer } from "./server";

describe("remote control server", () => {
  let server: RemoteControlServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it("protects the API and serves the mobile client", async () => {
    const bridge = {
      request: vi.fn(async (method: string) => method === "sessions.list" ? [] : null),
      onEvent: vi.fn(() => () => {}),
    } as unknown as RemoteControlBridge;
    server = new RemoteControlServer(bridge);
    await server.start();

    const port = server.getPort();
    expect(port).toBe(18987);

    const httpRedirect = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { "x-forwarded-proto": "http" },
      redirect: "manual",
    });
    expect(httpRedirect.status).toBe(308);
    expect(httpRedirect.headers.get("location")).toBe(`https://127.0.0.1:${port}/`);

    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(unauthorized.status).toBe(401);
    const queryTokenApi = await fetch(`http://127.0.0.1:${port}/api/health?token=test-remote-token`);
    expect(queryTokenApi.status).toBe(401);

    const landingPage = await fetch(`http://127.0.0.1:${port}/`);
    expect(landingPage.status).toBe(200);
    await expect(landingPage.text()).resolves.toContain("Harnss Remote");

    const authorized = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { authorization: "Bearer test-remote-token" },
    });
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toMatchObject({ ok: true, version: 1 });

    const client = await fetch(`http://127.0.0.1:${port}/?token=test-remote-token`);
    expect(client.status).toBe(200);
    const clientHtml = await client.text();
    expect(clientHtml).toContain("remote-client.js");
    expect(clientHtml).not.toContain("remote-voice.js");

    const script = await fetch(`http://127.0.0.1:${port}/remote-client.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("access-control-allow-origin")).toBe("*");
    const scriptText = await script.text();
    expect(scriptText).toContain("new WebSocket");
    expect(scriptText).toContain("settings-acp-permission");
    expect(scriptText).toContain("snapshot.revision<previous.revision");
    expect(scriptText).toContain("conversation.innerHTML=");
    expect(scriptText).toContain("void loadSessions();if(selectedId)void loadSnapshot(selectedId)");
    // 2026-09-09：COVE 语音页已移除（语音由 L'Agents 原生 App 承担），
    // 页面不再有入口，/cove/ 静态资源与 /voice WS 升级均应拒绝。
    expect(scriptText).not.toContain("/cove/");

    const covePage = await fetch(`http://127.0.0.1:${port}/cove/`, {
      headers: { authorization: "Bearer test-remote-token" },
    });
    expect(covePage.status).toBe(404);

    const traversal = await fetch(`http://127.0.0.1:${port}/cove/%2e%2e/package.json`, {
      headers: { authorization: "Bearer test-remote-token" },
    });
    expect(traversal.status).toBe(404);
  });

  it("authenticates websocket clients and forwards session requests", async () => {
    const bridge = {
      request: vi.fn(async (method: string) => method === "sessions.list"
        ? [{ id: "session-1", title: "Test", projectId: "project-1" }]
        : null),
      onEvent: vi.fn(() => () => {}),
    } as unknown as RemoteControlBridge;
    server = new RemoteControlServer(bridge);
    await server.start();

    const port = server.getPort();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=test-remote-token`);
    await new Promise<void>((resolve, reject) => {
      socket.once("message", (data) => {
        expect(JSON.parse(data.toString())).toMatchObject({ type: "remote.ready", version: 1 });
        resolve();
      });
      socket.once("error", reject);
    });
    socket.close();

    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { authorization: "Bearer test-remote-token" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sessions: [{ id: "session-1", title: "Test", projectId: "project-1" }],
    });
    expect(bridge.request).toHaveBeenCalledWith("sessions.list");
  });

  it("forwards session setting updates through the authenticated API", async () => {
    const bridge = {
      request: vi.fn(async (method: string) => method === "sessions.update-settings"
        ? { accepted: true }
        : [{ id: "session-1", title: "Test", projectId: "project-1" }]),
      onEvent: vi.fn(() => () => {}),
    } as unknown as RemoteControlBridge;
    server = new RemoteControlServer(bridge);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getPort()}/api/sessions/session-1/settings`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-remote-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet",
        effort: "high",
        permissionMode: "acceptEdits",
        planMode: true,
        configValues: {
          model: "gpt-5",
          mode: "auto",
        },
        acpPermissionBehavior: "auto_accept",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(bridge.request).toHaveBeenCalledWith("sessions.update-settings", {
      sessionId: "session-1",
      model: "claude-sonnet",
      effort: "high",
      permissionMode: "acceptEdits",
      planMode: true,
      acpPermissionBehavior: "auto_accept",
      configValues: {
        model: "gpt-5",
        mode: "auto",
      },
    });
  });

  it("rejects an invalid ACP permission behavior", async () => {
    const bridge = {
      request: vi.fn(),
      onEvent: vi.fn(() => () => {}),
    } as unknown as RemoteControlBridge;
    server = new RemoteControlServer(bridge);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getPort()}/api/sessions/session-1/settings`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-remote-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ acpPermissionBehavior: "unsafe" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid ACP permission behavior" });
    expect(bridge.request).not.toHaveBeenCalled();
  });

  it("rejects malformed ACP configuration values", async () => {
    const bridge = {
      request: vi.fn(),
      onEvent: vi.fn(() => () => {}),
    } as unknown as RemoteControlBridge;
    server = new RemoteControlServer(bridge);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getPort()}/api/sessions/session-1/settings`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-remote-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        configValues: {
          mode: 42,
        },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "configValues must be a map of short string values" });
    expect(bridge.request).not.toHaveBeenCalled();
  });

  it("forwards safe agent actions", async () => {
    const bridge = {
      request: vi.fn(async (method: string) => method === "sessions.action"
        ? { accepted: true }
        : null),
      onEvent: vi.fn(() => () => {}),
    } as unknown as RemoteControlBridge;
    server = new RemoteControlServer(bridge);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getPort()}/api/sessions/session-1/actions`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-remote-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "interrupt" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(bridge.request).toHaveBeenCalledWith("sessions.action", {
      sessionId: "session-1",
      action: "interrupt",
    });
  });

  it("creates sessions through the authenticated API", async () => {
    const bridge = {
      request: vi.fn(async (method: string) => method === "sessions.create"
        ? { accepted: true }
        : null),
      onEvent: vi.fn(() => () => {}),
    } as unknown as RemoteControlBridge;
    server = new RemoteControlServer(bridge);
    await server.start();
    const port = server.getPort();

    const post = async (body: unknown, authorized = true) =>
      fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: "POST",
        headers: {
          ...(authorized ? { authorization: "Bearer test-remote-token" } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const unauthorized = await post({ projectId: "project-1" }, false);
    expect(unauthorized.status).toBe(401);

    const missingProject = await post({ engine: "codex" });
    expect(missingProject.status).toBe(400);
    await expect(missingProject.json()).resolves.toEqual({
      error: "projectId must be a non-empty string of at most 200 characters",
    });

    const badEngine = await post({ projectId: "project-1", engine: "shell" });
    expect(badEngine.status).toBe(400);
    await expect(badEngine.json()).resolves.toEqual({
      error: "engine must be one of: claude, codex, acp",
    });

    const created = await post({
      projectId: "project-1",
      engine: "codex",
      model: "gpt-5.6-luna",
      agentId: "reviewer",
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toEqual({ accepted: true });
    expect(bridge.request).toHaveBeenCalledWith("sessions.create", {
      projectId: "project-1",
      engine: "codex",
      model: "gpt-5.6-luna",
      agentId: "reviewer",
    });

    const defaultEngine = await post({ projectId: "project-1" });
    expect(defaultEngine.status).toBe(200);
    expect(bridge.request).toHaveBeenLastCalledWith("sessions.create", {
      projectId: "project-1",
      engine: "claude",
    });

    const badModel = await post({ projectId: "project-1", model: 42 });
    expect(badModel.status).toBe(400);
    await expect(badModel.json()).resolves.toEqual({
      error: "model must be a string of at most 200 characters",
    });
  });
});
