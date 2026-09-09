import { useEffect, useRef } from "react";
import type { ACPConfigOption, AcpPermissionBehavior, Project } from "@/types";
import { isAcpPermissionBehavior } from "@shared/types/engine";
import { isRecord } from "@/lib/utils";
import { isClaudeEffort } from "@/lib/session/records";
import type {
  RemoteImageAttachment,
  RemoteRendererRequest,
  RemoteServerEvent,
  RemoteSessionSnapshot,
  RemoteSessionSummary,
} from "@shared/types/remote";

type RemoteSessionManager = {
  sessions: RemoteSessionSummary[];
  activeSessionId: string | null;
  messages: unknown[];
  pendingPermission: unknown;
  isProcessing: boolean;
  getRemoteSnapshot: (sessionId: string) => Promise<RemoteSessionSnapshot | null>;
  sendToSession: (sessionId: string, text: string, images?: RemoteImageAttachment[]) => Promise<void>;
  ensureSessionLive: (sessionId: string) => Promise<void>;
  respondToSessionPermission: (
    sessionId: string,
    requestId: string,
    behavior: "allow" | "deny" | "allowForSession",
    input?: Record<string, unknown>,
    newPermissionMode?: string,
  ) => Promise<void>;
  updateSessionSettings: (sessionId: string, settings: {
    model?: string;
    effort?: string;
    permissionMode?: string;
    planMode?: boolean;
    configValues?: Record<string, string>;
  }) => Promise<void>;
  activateSession: (sessionId: string) => Promise<void>;
  interruptSession: (sessionId: string) => Promise<void>;
  retrySession: (sessionId: string) => Promise<void>;
  createSession: (
    projectId: string,
    options?: { engine?: "claude" | "codex" | "acp"; model?: string; agentId?: string },
  ) => Promise<void>;
  acpConfigOptions: ACPConfigOption[];
  resolveEngineIcon: (engine: string | undefined, agentId: string | undefined) => string | undefined;
};

type RemoteControlSettings = {
  acpPermissionBehavior: AcpPermissionBehavior;
  setAcpPermissionBehavior: (behavior: AcpPermissionBehavior) => void;
};

/**
 * Handles only the renderer side of the remote bridge. The manager remains
 * the source of truth, including for background sessions and approvals.
 */
export function useRemoteControlBridge(
  manager: RemoteSessionManager,
  projects: Project[],
  settings: RemoteControlSettings,
): void {
  const managerRef = useRef(manager);
  managerRef.current = manager;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSessionIdsRef = useRef<Set<string>>(new Set());
  const snapshotVersionRef = useRef<Map<string, number>>(new Map());
  const snapshotRevisionRef = useRef<Map<string, number>>(new Map());
  const sessionListSignatureRef = useRef("");

  useEffect(() => {
    if (!window.claude?.remote) return;

    const addSnapshotMetadata = (
      snapshot: RemoteSessionSnapshot,
      revision: number,
    ): RemoteSessionSnapshot => ({
      ...snapshot,
      revision,
      session: {
        ...snapshot.session,
        ...(snapshot.session.engine === "acp"
          ? { acpPermissionBehavior: settingsRef.current.acpPermissionBehavior }
          : {}),
      },
    });

    const emitSnapshot = (sessionId: string) => {
      const version = (snapshotVersionRef.current.get(sessionId) ?? 0) + 1;
      snapshotVersionRef.current.set(sessionId, version);
      const revision = (snapshotRevisionRef.current.get(sessionId) ?? 0) + 1;
      snapshotRevisionRef.current.set(sessionId, revision);
      void managerRef.current.getRemoteSnapshot(sessionId)
        .then((snapshot) => {
          if (!snapshot) return;
          if (snapshotVersionRef.current.get(sessionId) !== version) return;
          window.claude.remote.emit({
            type: "session.updated",
            sessionId,
            snapshot: addSnapshotMetadata(snapshot, revision),
          } as RemoteServerEvent);
        })
        .catch(() => {
          // A session can disappear while its background update is queued.
        });
    };

    const scheduleSnapshot = (sessionId: string) => {
      pendingSessionIdsRef.current.add(sessionId);
      if (timerRef.current !== null) return;
      timerRef.current = setTimeout(() => {
        const pending = [...pendingSessionIdsRef.current];
        pendingSessionIdsRef.current.clear();
        timerRef.current = null;
        for (const id of pending) emitSnapshot(id);
      }, 75);
    };

    const handleRequest = (request: RemoteRendererRequest) => {
      const respond = (response: { ok: boolean; data?: unknown; error?: string }) => {
        window.claude.remote.respond({
          requestId: request.requestId,
          ...response,
        });
      };

      void (async () => {
        try {
          const currentManager = managerRef.current;
          const payload = isRecord(request.payload) ? request.payload : {};
          if (request.method === "sessions.list") {
            const projectNames = new Map(projectsRef.current.map((project) => [project.id, project.name]));
            respond({
              ok: true,
              data: currentManager.sessions.map((session) => ({
                id: session.id,
                projectId: session.projectId,
                ...(projectNames.get(session.projectId) ? { projectName: projectNames.get(session.projectId) } : {}),
                title: session.title,
                createdAt: session.createdAt,
                ...(session.lastMessageAt !== undefined ? { lastMessageAt: session.lastMessageAt } : {}),
                ...(session.engine ? { engine: session.engine } : {}),
                ...(session.agentId ? { agentId: session.agentId } : {}),
                ...(currentManager.resolveEngineIcon(session.engine, session.agentId)
                  ? { engineIcon: currentManager.resolveEngineIcon(session.engine, session.agentId) }
                  : {}),
                ...(session.model ? { model: session.model } : {}),
                ...(session.effort ? { effort: session.effort } : {}),
                ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
                ...(session.planMode !== undefined ? { planMode: session.planMode } : {}),
                ...(session.isProcessing !== undefined ? { isProcessing: session.isProcessing } : {}),
                ...(session.hasPendingPermission !== undefined ? { hasPendingPermission: session.hasPendingPermission } : {}),
                ...(session.hasUnreadCompletion !== undefined ? { hasUnreadCompletion: session.hasUnreadCompletion } : {}),
                ...(session.engine === "acp"
                  ? { acpPermissionBehavior: settingsRef.current.acpPermissionBehavior }
                  : {}),
              })),
            });
            return;
          }

          if (request.method === "sessions.create") {
            const projectId = typeof payload.projectId === "string" ? payload.projectId : "";
            if (!projectId || !projectsRef.current.some((project) => project.id === projectId)) {
              throw new Error("Project not found");
            }
            const engine = payload.engine === "acp" || payload.engine === "codex" ? payload.engine : "claude";
            await currentManager.createSession(projectId, {
              engine,
              ...(typeof payload.model === "string" ? { model: payload.model } : {}),
              ...(typeof payload.agentId === "string" ? { agentId: payload.agentId } : {}),
            });
            respond({ ok: true, data: { accepted: true } });
            return;
          }

          const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
          if (!sessionId || !currentManager.sessions.some((session) => session.id === sessionId)) {
            throw new Error("Session not found");
          }

          if (request.method === "sessions.get") {
            const revision = (snapshotRevisionRef.current.get(sessionId) ?? 0) + 1;
            snapshotRevisionRef.current.set(sessionId, revision);
            const snapshot = await currentManager.getRemoteSnapshot(sessionId);
            if (!snapshot) throw new Error("Session not found");
            respond({ ok: true, data: addSnapshotMetadata(snapshot, revision) });
            return;
          }

          if (request.method === "sessions.send") {
            if (typeof payload.text !== "string") throw new Error("Message text is required");
            const images = Array.isArray(payload.images)
              ? payload.images.filter((image): image is RemoteImageAttachment =>
                isRecord(image)
                && typeof image.id === "string"
                && typeof image.data === "string"
                && (image.mediaType === "image/png"
                  || image.mediaType === "image/jpeg"
                  || image.mediaType === "image/gif"
                  || image.mediaType === "image/webp"),
              )
              : undefined;
            await currentManager.sendToSession(sessionId, payload.text, images);
            scheduleSnapshot(sessionId);
            respond({ ok: true, data: { accepted: true } });
            return;
          }

          if (request.method === "sessions.approve") {
            const behavior = payload.behavior;
            if (behavior !== "allow" && behavior !== "deny" && behavior !== "allowForSession") {
              throw new Error("Invalid approval behavior");
            }
            const input: Record<string, unknown> = {};
            if (isRecord(payload.answersByQuestionId)) input.answersByQuestionId = payload.answersByQuestionId;
            if (typeof payload.denyMessage === "string") input.denyMessage = payload.denyMessage;
            const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
            if (!requestId) throw new Error("Permission request is required");
            await currentManager.respondToSessionPermission(
              sessionId,
              requestId,
              behavior,
              input,
              typeof payload.newPermissionMode === "string" ? payload.newPermissionMode : undefined,
            );
            scheduleSnapshot(sessionId);
            respond({ ok: true, data: { accepted: true } });
            return;
          }

          if (request.method === "sessions.update-settings") {
            const model = typeof payload.model === "string" ? payload.model.trim() : "";
            const permissionMode = typeof payload.permissionMode === "string"
              ? payload.permissionMode.trim()
              : "";
            const effort = typeof payload.effort === "string" ? payload.effort.trim() : "";
            const acpPermissionBehavior = payload.acpPermissionBehavior;
            const configValues = isRecord(payload.configValues)
              ? Object.fromEntries(Object.entries(payload.configValues).filter((entry): entry is [string, string] =>
                typeof entry[0] === "string" && typeof entry[1] === "string",
              ))
              : {};
            const selectedSession = currentManager.sessions.find((session) => session.id === sessionId);
            const snapshot = model || effort ? await currentManager.getRemoteSnapshot(sessionId) : null;
            const availableModels = snapshot?.session.availableModels ?? [];
            if (model && availableModels.length > 0 && !availableModels.some((option) => option.value === model)) {
              throw new Error("Selected model is not available for this session");
            }
            const selectedModel = snapshot?.session.availableModels?.find((option) =>
              option.value === (model || snapshot.session.model),
            );
            const supportedEfforts = selectedModel?.supportedEffortLevels
              ?? (selectedModel?.supportsEffort ? ["low", "medium", "high", "max"] : []);
            if (effort && (selectedSession?.engine ?? "claude") === "claude" && !isClaudeEffort(effort)) {
              throw new Error("Invalid reasoning effort");
            }
            if (effort && supportedEfforts.length > 0 && !supportedEfforts.includes(effort)) {
              throw new Error("Selected reasoning effort is not supported by this model");
            }
            if ((selectedSession?.engine ?? "claude") === "acp"
              && (!Object.keys(configValues).length
                || model || effort || permissionMode || typeof payload.planMode === "boolean"
                || acpPermissionBehavior !== undefined)) {
              if (model || effort || permissionMode || typeof payload.planMode === "boolean") {
                throw new Error("ACP settings use the agent configuration options");
              }
            }
            if (acpPermissionBehavior !== undefined) {
              if (selectedSession?.engine !== "acp" || !isAcpPermissionBehavior(acpPermissionBehavior)) {
                throw new Error("Invalid ACP permission behavior");
              }
              settingsRef.current.setAcpPermissionBehavior(acpPermissionBehavior);
            }
            // ACP config changes need a live agent process — revive dead sessions first.
            // Re-read the manager after the await: activating switches the desktop's
            // active session, so the previously captured hooks are stale.
            if ((selectedSession?.engine ?? "claude") === "acp" && Object.keys(configValues).length) {
              await managerRef.current.ensureSessionLive(sessionId);
            }
            await managerRef.current.updateSessionSettings(sessionId, {
              ...(model ? { model } : {}),
              ...(effort ? { effort } : {}),
              ...(permissionMode ? { permissionMode } : {}),
              ...(typeof payload.planMode === "boolean" ? { planMode: payload.planMode } : {}),
              ...(Object.keys(configValues).length ? { configValues } : {}),
            });
            scheduleSnapshot(sessionId);
            respond({ ok: true, data: { accepted: true } });
            return;
          }

          if (request.method === "sessions.action") {
            const action = payload.action;
            if (action !== "activate" && action !== "interrupt" && action !== "retry") {
              throw new Error("Invalid session action");
            }
            if (action === "activate") await currentManager.activateSession(sessionId);
            if (action === "interrupt") await currentManager.interruptSession(sessionId);
            if (action === "retry") await currentManager.retrySession(sessionId);
            scheduleSnapshot(sessionId);
            respond({ ok: true, data: { accepted: true } });
            return;
          }

          throw new Error("Unsupported remote request");
        } catch (error) {
          respond({
            ok: false,
            error: error instanceof Error ? error.message : "Remote request failed",
          });
        }
      })();
    };

    const unsubscribeRequest = window.claude.remote.onRequest(handleRequest);
    const handleBackgroundEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (detail?.sessionId) scheduleSnapshot(detail.sessionId);
    };
    window.addEventListener("harnss:remote-session-updated", handleBackgroundEvent);

    return () => {
      unsubscribeRequest();
      window.removeEventListener("harnss:remote-session-updated", handleBackgroundEvent);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      pendingSessionIdsRef.current.clear();
      snapshotVersionRef.current.clear();
      snapshotRevisionRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!window.claude?.remote) return;
    const signature = manager.sessions.map((session) => [
      session.id,
      session.title,
      session.lastMessageAt ?? "",
      session.model ?? "",
      session.permissionMode ?? "",
      session.planMode ?? "",
      session.isProcessing ?? "",
      session.hasPendingPermission ?? "",
      session.hasUnreadCompletion ?? "",
      session.engine === "acp" ? settingsRef.current.acpPermissionBehavior : "",
    ].join(":")).join("|");
    if (signature !== sessionListSignatureRef.current) {
      sessionListSignatureRef.current = signature;
      window.claude.remote.emit({ type: "sessions.updated" });
    }
  }, [manager.sessions]);

  useEffect(() => {
    if (!window.claude?.remote) return;
    window.claude.remote.emit({ type: "sessions.updated" });
  }, [settings.acpPermissionBehavior]);

  useEffect(() => {
    if (!window.claude?.remote) return;
    if (manager.activeSessionId) {
      window.dispatchEvent(new CustomEvent("harnss:remote-session-updated", {
        detail: { sessionId: manager.activeSessionId, notifyList: false },
      }));
    }
  }, [
    manager.activeSessionId,
    manager.messages,
    manager.pendingPermission,
    manager.isProcessing,
    manager.acpConfigOptions,
  ]);
}
