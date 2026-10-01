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
    await expect(landingPage.text()).resolves.toContain("L'Agents WebUI");

    const authorized = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { authorization: "Bearer test-remote-token" },
    });
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toMatchObject({ ok: true, version: 1 });

    const authSession = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      method: "POST",
      headers: { authorization: "Bearer test-remote-token" },
    });
    expect(authSession.status).toBe(200);
    const sessionCookie = authSession.headers.get("set-cookie");
    expect(sessionCookie).toContain("harnss_remote_session=");
    const cookieHeader = sessionCookie!.split(";")[0];
    const cookieAuthorized = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { cookie: cookieHeader },
    });
    expect(cookieAuthorized.status).toBe(200);
    const signedOut = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      method: "DELETE",
      headers: { cookie: cookieHeader },
    });
    expect(signedOut.status).toBe(200);
    const cookieRejected = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { cookie: cookieHeader },
    });
    expect(cookieRejected.status).toBe(401);

    const client = await fetch(`http://127.0.0.1:${port}/`);
    expect(client.status).toBe(200);
    const clientHtml = await client.text();
    expect(clientHtml).toContain("remote-client.js");
    expect(clientHtml).not.toContain("remote-voice.js");

    const script = await fetch(`http://127.0.0.1:${port}/remote-client.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("access-control-allow-origin")).toBeNull();
    const scriptText = await script.text();
    expect(scriptText).toContain("new WebSocket");
    expect(scriptText).toContain("settings-acp-permission");
    expect(scriptText).toContain("snapshot.revision<previous.revision");
    expect(scriptText).toContain("/api/auth/session");
    expect(scriptText).toContain("/api/projects");
    expect(scriptText).toContain("/api/sessions");
    expect(scriptText).toContain("/messages");
    expect(scriptText).toContain("/approvals/");
    expect(scriptText).toContain("/settings");
    expect(scriptText).toContain("/actions");
    expect(scriptText).toContain("workspace-page");
    expect(scriptText).toContain("composer-control-button");
    expect(scriptText).toContain("composer-popover");
    expect(scriptText).toContain("workspace-status-strip");
    expect(scriptText).toContain("message-list");
    expect(scriptText).toContain("input-capsule");
    expect(scriptText).toContain("left-sidebar-drawer");
    expect(scriptText).toContain("drawer-project-chip");
    expect(scriptText).toContain("permission-card");
    expect(scriptText).toContain("Allow for session");
    expect(scriptText).toContain("Activate session");
    expect(scriptText).toContain("drawer-create-card");
    expect(scriptText).toContain("session-details-card");
    expect(scriptText).toContain("/rename");
    expect(scriptText).not.toContain("voice-shell");
    expect(scriptText).not.toContain("dataset.voiceShell");
    expect(scriptText).not.toContain("/api/chat");
    expect(scriptText).not.toContain("INITIAL_SESSIONS");
    expect(scriptText).not.toContain("speechSynthesis");
    expect(scriptText).not.toContain("/api/chat");
    expect(scriptText).not.toContain("INITIAL_SESSIONS");
    expect(scriptText).not.toContain("speechSynthesis");
    expect(scriptText).not.toContain("getUserMedia");
    expect(scriptText).not.toContain("voice-shell");
    expect(scriptText).not.toContain("floatingSwitcher");

    const css = await fetch(`http://127.0.0.1:${port}/remote-client.css`);
    expect(css.status).toBe(200);
    const cssText = await css.text();
    expect(cssText).toContain("#f6f7f9");
    expect(cssText).not.toContain("floating-switcher");
    expect(cssText).not.toContain("floating-ball");

    const serviceWorker = await fetch(`http://127.0.0.1:${port}/remote-sw.js`);
    expect(serviceWorker.status).toBe(200);
    await expect(serviceWorker.text()).resolves.toContain("harnss-remote-v17");
    // 2026-09-09：COVE 语音页已移除（语音由 L'Agents 原生 App 承担），
    // 页面不再有入口，/cove/ 静态资源与 /voice WS 升级均应拒绝。
    // 客户端 JS 必须可解析：此前按钮字符串引号被误删，整页停在 boot 屏，
    // 子串断言抓不到语法错误，这里强制编译一次（不执行，无需 DOM）。
    expect(() => new Function(scriptText)).not.toThrow();
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

  it("rejects every protected route without authentication before bridge dispatch", async () => {
    const bridge = {
      request: vi.fn(),
      onEvent: vi.fn(() => () => {}),
    } as unknown as RemoteControlBridge;
    server = new RemoteControlServer(bridge);
    await server.start();
    const port = server.getPort();
    const cases: Array<{ name: string; path: string; init?: RequestInit }> = [
      { name: "health", path: "/api/health" },
      { name: "projects", path: "/api/projects" },
      { name: "sessions", path: "/api/sessions" },
      { name: "snapshot", path: "/api/sessions/session-1" },
      {
        name: "create",
        path: "/api/sessions",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: "project-1", engine: "claude" }),
        },
      },
      {
        name: "rename",
        path: "/api/sessions/session-1/rename",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Renamed" }),
        },
      },
      {
        name: "message",
        path: "/api/sessions/session-1/messages",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "Hello" }),
        },
      },
      {
        name: "approval",
        path: "/api/sessions/session-1/approvals/request-1",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ behavior: "deny" }),
        },
      },
      {
        name: "settings",
        path: "/api/sessions/session-1/settings",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      },
      {
        name: "action",
        path: "/api/sessions/session-1/actions",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "interrupt" }),
        },
      },
      {
        name: "bootstrap",
        path: "/api/auth/session",
        init: { method: "POST" },
      },
    ];

    for (const testCase of cases) {
      const response = await fetch(`http://127.0.0.1:${port}${testCase.path}`, testCase.init);
      expect(response.status, testCase.name).toBe(401);
      await expect(response.json(), testCase.name).resolves.toEqual({ error: "Unauthorized" });
    }
    expect(bridge.request).not.toHaveBeenCalled();
  });

  it("invalidates the complete protected route matrix after cookie sign-out", async () => {
    const bridge = {
      request: vi.fn(async (method: string) => {
        if (method === "projects.list") return [{ id: "project-1", name: "Demo" }];
        if (method === "sessions.list") return [{ id: "session-1", title: "Test", projectId: "project-1" }];
        return { accepted: true };
      }),
      onEvent: vi.fn(() => () => {}),
    } as unknown as RemoteControlBridge;
    server = new RemoteControlServer(bridge);
    await server.start();
    const port = server.getPort();
    const authSession = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      method: "POST",
      headers: { authorization: "Bearer test-remote-token" },
    });
    expect(authSession.status).toBe(200);
    const sessionCookie = authSession.headers.get("set-cookie");
    expect(sessionCookie).toContain("harnss_remote_session=");
    const cookieHeader = sessionCookie!.split(";")[0];

    const authorized = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      headers: { cookie: cookieHeader },
    });
    expect(authorized.status).toBe(200);

    const signedOut = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      method: "DELETE",
      headers: { cookie: cookieHeader },
    });
    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.get("set-cookie")).toMatch(/harnss_remote_session=.*Max-Age=0/i);

    const cases: Array<{ path: string; init?: RequestInit }> = [
      { path: "/api/health" },
      { path: "/api/projects" },
      { path: "/api/sessions" },
      { path: "/api/sessions/session-1" },
      {
        path: "/api/sessions",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: "project-1", engine: "claude" }),
        },
      },
      {
        path: "/api/sessions/session-1/rename",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Renamed" }),
        },
      },
      {
        path: "/api/sessions/session-1/messages",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "Hello" }),
        },
      },
      {
        path: "/api/sessions/session-1/approvals/request-1",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ behavior: "deny" }),
        },
      },
      {
        path: "/api/sessions/session-1/settings",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      },
      {
        path: "/api/sessions/session-1/actions",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "interrupt" }),
        },
      },
    ];

    for (const testCase of cases) {
      const headers = new Headers(testCase.init?.headers);
      headers.set("cookie", cookieHeader);
      const response = await fetch(`http://127.0.0.1:${port}${testCase.path}`, {
        ...testCase.init,
        headers,
      });
      expect(response.status, testCase.path).toBe(401);
      await expect(response.json(), testCase.path).resolves.toEqual({ error: "Unauthorized" });
    }
    expect(bridge.request).toHaveBeenCalledTimes(1);
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
    const authSession = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      method: "POST",
      headers: { authorization: "Bearer test-remote-token" },
    });
    const sessionCookie = authSession.headers.get("set-cookie");
    expect(sessionCookie).toContain("harnss_remote_session=");
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { cookie: sessionCookie!.split(";")[0] },
    });
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

  it("lists projects through the authenticated API without exposing paths", async () => {
    const bridge = {
      request: vi.fn(async (method: string) => method === "projects.list"
        ? [{ id: "project-1", name: "Demo" }]
        : null),
      onEvent: vi.fn(() => () => {}),
    } as unknown as RemoteControlBridge;
    server = new RemoteControlServer(bridge);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getPort()}/api/projects`, {
      headers: { authorization: "Bearer test-remote-token" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      projects: [{ id: "project-1", name: "Demo" }],
    });
    expect(bridge.request).toHaveBeenCalledWith("projects.list");
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
        ? {
            accepted: true,
            sessionId: "session-new",
            session: {
              id: "session-new",
              projectId: "project-1",
              projectName: "Demo",
              title: "New Chat",
              createdAt: 1,
              engine: "codex",
            },
            status: "ready",
          }
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
    await expect(created.json()).resolves.toEqual({
      accepted: true,
      sessionId: "session-new",
      session: {
        id: "session-new",
        projectId: "project-1",
        projectName: "Demo",
        title: "New Chat",
        createdAt: 1,
        engine: "codex",
      },
      status: "ready",
    });
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

  it("renames sessions through the authenticated API", async () => {
    const bridge = {
      request: vi.fn(async (method: string) => method === "sessions.rename" ? { accepted: true } : null),
      onEvent: vi.fn(() => () => {}),
    } as unknown as RemoteControlBridge;
    server = new RemoteControlServer(bridge);
    await server.start();
    const response = await fetch(`http://127.0.0.1:${server.getPort()}/api/sessions/session-1/rename`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-remote-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Renamed session" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(bridge.request).toHaveBeenCalledWith("sessions.rename", {
      sessionId: "session-1",
      title: "Renamed session",
    });
  });
});
