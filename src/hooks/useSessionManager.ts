import { useState, useCallback, useEffect, useRef } from "react";
import type { ChatSession, UIMessage, PermissionRequest, McpServerStatus, McpServerConfig, ModelInfo, AcpPermissionBehavior, EngineId, Project, ACPAuthenticateResult, ACPConfigOption, ACPPermissionEvent, AppPermissionBehavior, InstalledAgent, ImageAttachment } from "@/types";
import type {
  RemoteMessage,
  RemoteModelOption,
  RemotePermission,
  RemoteSessionSnapshot,
  RemoteSessionSummary,
} from "@shared/types/remote";
import { toMcpStatusState } from "../lib/mcp-utils";
import { getSessionEngineIcon } from "../lib/engine-icons";
import { buildPersistedSession, toChatSession } from "../lib/session/records";
import { BackgroundSessionStore } from "../lib/background/session-store";
import { createSystemMessage, createUserMessage } from "../lib/message-factory";
import { buildSdkContent } from "../lib/engine/protocol";
import { imageAttachmentsToCodexInputs } from "../lib/engine/codex-adapter";
import { suppressNextSessionCompletion } from "../lib/notification-utils";
import { getAskUserQuestionKey } from "../lib/ask-user-question";
import { formatCompactSummary } from "../components/lib/tool-formatting";
import {
  DRAFT_ID,
  type StartOptions,
  type CodexModelSummary,
  type InitialMeta,
  type PendingAcpDraftPrompt,
  type QueuedMessage,
  type SessionPaneBootstrap,
  type SharedSessionRefs,
  type SharedSessionSetters,
  type EngineHooks,
  buildCodexCollabMode,
  normalizeCodexModels,
  getCodexApprovalPolicy,
  getCodexSandboxMode,
  getEffectiveClaudePermissionMode,
} from "./session/types";
import { useSessionPane } from "./session/useSessionPane";
import { useMessageQueue } from "./session/useMessageQueue";
import { useSessionPersistence } from "./session/useSessionPersistence";
import { useDraftMaterialization } from "./session/useDraftMaterialization";
import { useSessionRevival } from "./session/useSessionRevival";
import { useSessionLifecycle } from "./session/useSessionLifecycle";

const REMOTE_MESSAGE_LIMIT = 200;

function toRemoteMessages(messages: UIMessage[], isProcessing = false): { messages: RemoteMessage[]; truncated: boolean } {
  const tail: UIMessage[] = [];
  for (let index = messages.length - 1; index >= 0 && tail.length <= REMOTE_MESSAGE_LIMIT; index -= 1) {
    const message = messages[index];
    if (!message.isQueued) tail.push(message);
  }
  const truncated = tail.length > REMOTE_MESSAGE_LIMIT;
  const visible = tail.slice(0, REMOTE_MESSAGE_LIMIT).reverse();
  return {
    messages: visible.map((message) => {
      const toolSummary = message.role === "tool_call" || message.role === "tool_result"
        ? formatCompactSummary(message)
        : "";
      return {
        id: message.id,
        role: message.role,
        content: message.role === "user" ? (message.displayContent ?? message.content) : message.content,
        ...(message.displayContent ? { displayContent: message.displayContent } : {}),
        ...(toolSummary ? { toolSummary } : {}),
        ...(message.toolName ? { toolName: message.toolName } : {}),
        ...(message.thinking ? { thinking: message.thinking } : {}),
        ...(message.subagentStatus ? { subagentStatus: message.subagentStatus } : {}),
        ...(message.subagentSteps?.length ? {
          subagentSteps: message.subagentSteps.slice(-30).map((step) => ({
            toolName: step.toolName,
            status: step.toolError ? "error" as const : step.toolResult ? "completed" as const : "running" as const,
          })),
        } : {}),
        ...(isProcessing && message.isStreaming ? { isStreaming: true } : {}),
        timestamp: message.timestamp,
        ...(message.isError !== undefined ? { isError: message.isError } : {}),
        ...(message.toolError !== undefined ? { toolError: message.toolError } : {}),
      };
    }),
    truncated,
  };
}

function toRemotePermission(permission: PermissionRequest | null): RemotePermission | null {
  if (!permission) return null;
  const input = permission.toolInput;
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const questions = rawQuestions.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const question = raw as Record<string, unknown>;
    if (typeof question.question !== "string") return [];
    const questionId = getAskUserQuestionKey({
      id: typeof question.id === "string" ? question.id : undefined,
      question: question.question,
    }, index);
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    const options = rawOptions.flatMap((option) => {
      if (!option || typeof option !== "object") return [];
      const item = option as Record<string, unknown>;
      if (typeof item.label !== "string") return [];
      return [{
        label: item.label,
        ...(typeof item.description === "string" ? { description: item.description } : {}),
      }];
    });
    return [{
      id: questionId,
      question: question.question,
      ...(typeof question.header === "string" ? { header: question.header } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
    }];
  });

  return {
    requestId: permission.requestId,
    toolName: permission.toolName,
    toolUseId: permission.toolUseId,
    ...(permission.decisionReason ? { decisionReason: permission.decisionReason } : {}),
    ...(permission.decisionReason ? { summary: permission.decisionReason } : {}),
    kind: permission.toolName === "AskUserQuestion" ? "user-input" : "approval",
    ...(questions.length > 0 ? { questions } : {}),
  };
}

function toRemoteModelOptions(
  models: Array<ModelInfo | CodexModelSummary>,
): RemoteModelOption[] {
  return models.map((model) => {
    if ("supportedReasoningEfforts" in model) {
      return {
        value: model.id,
        displayName: model.displayName,
        ...(model.description ? { description: model.description } : {}),
        ...(model.supportedReasoningEfforts.length > 0
          ? { supportsEffort: true, supportedEffortLevels: model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort) }
          : {}),
        ...(model.isDefault ? { isDefault: true } : {}),
      };
    }
    return {
      value: model.value,
      displayName: model.displayName,
      ...(model.description ? { description: model.description } : {}),
      ...(model.supportsEffort !== undefined ? { supportsEffort: model.supportsEffort } : {}),
      ...(model.supportedEffortLevels ? { supportedEffortLevels: model.supportedEffortLevels } : {}),
    };
  });
}

export function useSessionManager(
  projects: Project[],
  acpPermissionBehavior: AcpPermissionBehavior = "ask",
  onSpaceChange?: (spaceId: string) => void,
  /** Session IDs currently visible in extra split panes. */
  visibleSplitSessionIds: readonly string[] = [],
) {
  // ── Core state ──
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [startOptions, setStartOptions] = useState<StartOptions>({});
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [initialMeta, setInitialMeta] = useState<InitialMeta | null>(null);
  const [initialConfigOptions, setInitialConfigOptions] = useState<ACPConfigOption[]>([]);
  const [initialSlashCommands, setInitialSlashCommands] = useState<import("@/types").SlashCommand[]>([]);
  const [initialPermission, setInitialPermission] = useState<PermissionRequest | null>(null);
  const [initialRawAcpPermission, setInitialRawAcpPermission] = useState<ACPPermissionEvent | null>(null);
  const [acpMcpStatuses, setAcpMcpStatuses] = useState<McpServerStatus[]>([]);
  const [acpConfigOptionsLoading, setAcpConfigOptionsLoading] = useState(false);
  const [preStartedSessionId, setPreStartedSessionId] = useState<string | null>(null);
  const [draftAcpSessionId, setDraftAcpSessionId] = useState<string | null>(null);
  const [draftMcpStatuses, setDraftMcpStatuses] = useState<McpServerStatus[]>([]);
  const [cachedModels, setCachedModels] = useState<ModelInfo[]>([]);
  const [codexRawModels, setCodexRawModels] = useState<CodexModelSummary[]>([]);
  const [codexModelsLoadingMessage, setCodexModelsLoadingMessage] = useState<string | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);

  // ── Refs needed by extra pane loaders (declared early) ──
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const backgroundStoreRef = useRef(new BackgroundSessionStore());
  const installedAgentsRef = useRef<InstalledAgent[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    window.claude.agents.list()
      .then((agents) => { if (!cancelled) installedAgentsRef.current = agents; })
      .catch(() => { /* agent registry is optional */ });
    return () => { cancelled = true; };
  }, []);

  const resolveEngineIcon = useCallback(
    (engine: string | undefined, agentId: string | undefined): string | undefined =>
      getSessionEngineIcon(engine as EngineId | undefined, agentId, installedAgentsRef.current),
    [],
  );

  useEffect(() => {
    if (visibleSplitSessionIds.length === 0) return;
    const visibleIds = new Set(visibleSplitSessionIds);
    setSessions((prev) => {
      let changed = false;
      const next = prev.map((session) => {
        if (!visibleIds.has(session.id) || !session.hasUnreadCompletion) return session;
        changed = true;
        return { ...session, hasUnreadCompletion: false };
      });
      return changed ? next : prev;
    });
  }, [visibleSplitSessionIds]);

  // ── Determine active engine ──
  const activeEngine: EngineId = activeSessionId === DRAFT_ID
    ? (startOptions.engine ?? "claude")
    : (sessions.find(s => s.id === activeSessionId)?.engine ?? "claude");
  const isACP = activeEngine === "acp";
  const isCodex = activeEngine === "codex";

  const claudeSessionId = (activeEngine === "claude" && activeSessionId !== DRAFT_ID) ? activeSessionId : null;
  const acpSessionId = activeEngine === "acp"
    ? (activeSessionId !== DRAFT_ID ? activeSessionId : draftAcpSessionId)
    : null;
  const codexSessionId = (activeEngine === "codex" && activeSessionId !== DRAFT_ID) ? activeSessionId : null;
  const codexSessionModel = (activeEngine === "codex" && activeSessionId !== DRAFT_ID)
    ? (sessions.find((s) => s.id === activeSessionId)?.model ?? startOptions.model)
    : undefined;
  const codexPlanModeEnabled = activeEngine === "codex"
    ? (activeSessionId === DRAFT_ID
      ? !!startOptions.planMode
      : !!sessions.find((s) => s.id === activeSessionId)?.planMode)
    : false;

  // ── Primary session pane (wraps all three engine hooks) ──
  const primaryPane = useSessionPane({
    activeSessionId,
    activeEngine,
    claudeSessionId,
    acpSessionId,
    codexSessionId,
    codexSessionModel,
    codexPlanModeEnabled,
    initialMessages,
    initialMeta,
    initialPermission,
    initialConfigOptions,
    initialSlashCommands,
    initialRawAcpPermission,
    acpPermissionBehavior,
  });

  const { claude, acp, codex, engine } = primaryPane;
  const { messages, totalCost, contextUsage } = primaryPane;

  // ── All refs (21+) — kept for stale-closure avoidance ──
  const liveSessionIdsRef = useRef<Set<string>>(new Set());
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const totalCostRef = useRef(totalCost);
  totalCostRef.current = totalCost;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  // sessionsRef declared above (near extra pane loaders)
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const draftProjectIdRef = useRef(draftProjectId);
  draftProjectIdRef.current = draftProjectId;
  const startOptionsRef = useRef(startOptions);
  startOptionsRef.current = startOptions;
  const isProcessingRef = useRef(engine.isProcessing);
  isProcessingRef.current = engine.isProcessing;
  const isCompactingRef = useRef("isCompacting" in engine ? !!engine.isCompacting : false);
  isCompactingRef.current = "isCompacting" in engine ? !!engine.isCompacting : false;
  const isConnectedRef = useRef(engine.isConnected);
  isConnectedRef.current = engine.isConnected;
  const sessionInfoRef = useRef(engine.sessionInfo);
  sessionInfoRef.current = engine.sessionInfo;
  const pendingPermissionRef = useRef(engine.pendingPermission);
  pendingPermissionRef.current = engine.pendingPermission;
  // Split view: track visible split-pane session IDs for IPC routing gate
  const visibleSplitSessionIdsRef = useRef<readonly string[]>(visibleSplitSessionIds);
  visibleSplitSessionIdsRef.current = visibleSplitSessionIds;
  // Prevent cross-session bleed: skip the first lastMessageAt sync after switching chats.
  const lastMessageSyncSessionRef = useRef<string | null>(null);
  const preStartedSessionIdRef = useRef<string | null>(null);
  preStartedSessionIdRef.current = preStartedSessionId;  // kept in sync with state for event routing
  const draftAcpSessionIdRef = useRef<string | null>(null);
  draftAcpSessionIdRef.current = draftAcpSessionId;
  const draftMcpStatusesRef = useRef<McpServerStatus[]>([]);
  draftMcpStatusesRef.current = draftMcpStatuses;
  const materializingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageQueueRef = useRef<Map<string, QueuedMessage[]>>(new Map());
  const pendingAcpDraftPromptRef = useRef<PendingAcpDraftPrompt | null>(null);
  const acpAgentIdRef = useRef<string | null>(null);
  const acpAgentSessionIdRef = useRef<string | null>(null);
  const codexRawModelsRef = useRef(codexRawModels);
  codexRawModelsRef.current = codexRawModels;
  const cachedModelsRef = useRef(cachedModels);
  cachedModelsRef.current = cachedModels;
  const remoteSupportedModelsRef = useRef<ModelInfo[]>([]);
  remoteSupportedModelsRef.current = isCodex
    ? []
    : isACP
      ? []
      : claude.supportedModels.length > 0 ? claude.supportedModels : cachedModels;
  const codexEffortRef = useRef(codex.codexEffort);
  codexEffortRef.current = codex.codexEffort;
  // Tracks whether current Codex effort was explicitly chosen by the user.
  const codexEffortManualOverrideRef = useRef(false);
  const acpPermissionBehaviorRef = useRef<AcpPermissionBehavior>(acpPermissionBehavior);
  acpPermissionBehaviorRef.current = acpPermissionBehavior;
  const currentBranchRef = useRef<string | undefined>(undefined);
  // Stable ref to switchSession so toast callbacks don't capture stale closures
  const switchSessionRef = useRef<((id: string) => Promise<void>) | undefined>(undefined);
  // Stable ref for space switching — avoids adding onSpaceChange as a useCallback dependency
  const onSpaceChangeRef = useRef(onSpaceChange);
  onSpaceChangeRef.current = onSpaceChange;
  // backgroundStoreRef declared above (near extra pane loaders)

  // ── Codex effort helpers (kept in orchestrator — too small to extract) ──
  const setCodexEffortFromUser = useCallback((effort: string) => {
    codexEffortManualOverrideRef.current = true;
    codex.setCodexEffort(effort);
  }, [codex.setCodexEffort]);
  const applyCodexModelDefaultEffort = useCallback((effort: string | undefined) => {
    if (!effort || codexEffortManualOverrideRef.current) return;
    codex.setCodexEffort(effort);
  }, [codex.setCodexEffort]);
  const resetCodexEffortToModelDefault = useCallback((effort: string | undefined) => {
    if (!effort) return;
    codexEffortManualOverrideRef.current = false;
    codex.setCodexEffort(effort);
  }, [codex.setCodexEffort]);

  // ── Utility callbacks ──
  const findProject = useCallback((projectId: string) => {
    return projectsRef.current.find((p) => p.id === projectId) ?? null;
  }, []);

  const getProjectCwd = useCallback((project: Project) => {
    const selected = localStorage.getItem(`harnss-${project.id}-git-cwd`)?.trim();
    return selected || project.path;
  }, []);

  // ── Build shared refs/setters/engines objects for sub-hooks ──
  const refs: SharedSessionRefs = {
    activeSessionIdRef,
    sessionsRef,
    projectsRef,
    draftProjectIdRef,
    startOptionsRef,
    messagesRef,
    totalCostRef,
    contextUsageRef,
    isProcessingRef,
    isCompactingRef,
    isConnectedRef,
    sessionInfoRef,
    pendingPermissionRef,
    liveSessionIdsRef,
    backgroundStoreRef,
    preStartedSessionIdRef,
    draftAcpSessionIdRef,
    draftMcpStatusesRef,
    materializingRef,
    saveTimerRef,
    messageQueueRef,
    pendingAcpDraftPromptRef,
    acpAgentIdRef,
    acpAgentSessionIdRef,
    codexRawModelsRef,
    codexEffortRef,
    codexEffortManualOverrideRef,
    lastMessageSyncSessionRef,
    switchSessionRef,
    onSpaceChangeRef,
    acpPermissionBehaviorRef,
    currentBranchRef,
    visibleSplitSessionIdsRef,
  };

  const setters: SharedSessionSetters = {
    setSessions,
    setActiveSessionId,
    setInitialMessages,
    setInitialMeta,
    setInitialConfigOptions,
    setInitialSlashCommands,
    setInitialPermission,
    setInitialRawAcpPermission,
    setStartOptions,
    setDraftProjectId,
    setPreStartedSessionId,
    setDraftAcpSessionId,
    setAcpConfigOptionsLoading,
    setDraftMcpStatuses,
    setAcpMcpStatuses,
    setQueuedCount,
    setCachedModels,
    setCodexRawModels,
    setCodexModelsLoadingMessage,
  };

  const engines: EngineHooks = {
    claude,
    acp,
    codex,
    engine,
  };

  // ── Compose sub-hooks ──
  const {
    enqueueMessage,
    clearQueue,
    unqueueMessage,
    sendQueuedMessageNext,
    continueQueuedBackgroundSession,
    sendNextId,
  } = useMessageQueue({ refs, setters, engines, activeSessionId });

  const { saveCurrentSession, seedBackgroundStore, generateSessionTitle } = useSessionPersistence({
    refs,
    setters,
    engines,
    activeSessionId,
    continueQueuedBackgroundSession,
  });

  const {
    eagerStartSession,
    eagerStartAcpSession,
    prefetchCodexModels,
    probeMcpServers,
    abandonEagerSession,
    abandonDraftAcpSession,
    materializeDraft,
  } =
    useDraftMaterialization({
      refs,
      setters,
      engines,
      findProject,
      getProjectCwd,
      generateSessionTitle,
      applyCodexModelDefaultEffort,
    });

  const { reviveSession, reviveAcpSession, reviveAcpSessionById, reviveCodexSession } = useSessionRevival({
    refs,
    setters,
    engines,
    findProject,
    getProjectCwd,
  });

  const {
    createSession,
    switchSession,
    deleteSession,
    renameSession,
    deselectSession,
    importCCSession,
    setDraftAgent,
    setActiveModel,
    setSessionModel,
    setActivePermissionMode,
    setSessionPermissionMode,
    setActivePlanMode,
    setSessionPlanMode,
    setActiveThinking,
    setActiveClaudeEffort,
    setActiveClaudeModelAndEffort,
    setSessionClaudeModelAndEffort,
    setSessionEffort,
    updateSessionSettings,
    restartAcpSession,
    restartActiveSessionInCurrentWorktree,
    fullRevertSession,
    send,
  } = useSessionLifecycle({
    refs,
    setters,
    engines,
    projects,
    activeSessionId,
    activeEngine,
    findProject,
    getProjectCwd,
    saveCurrentSession,
    seedBackgroundStore,
    eagerStartSession,
    eagerStartAcpSession,
    prefetchCodexModels,
    probeMcpServers,
    abandonEagerSession,
    abandonDraftAcpSession,
    materializeDraft,
    reviveSession,
    reviveAcpSession,
    reviveCodexSession,
    enqueueMessage,
    clearQueue,
    resetCodexEffortToModelDefault,
  });

  const seedDevExampleConversation = useCallback(async () => {
    if (!import.meta.env.DEV) return;
    const { buildDevExampleConversation } = await import("../lib/dev-seeding/chat-seed");
    const base = Date.now();
    const seeded = buildDevExampleConversation(base);
    engine.setMessages((prev) => [...prev, ...seeded.messages]);
    const activeId = activeSessionIdRef.current;
    if (activeId && activeId !== DRAFT_ID) {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeId
            ? { ...s, lastMessageAt: seeded.lastMessageAt }
            : s,
        ),
      );
    }
  }, [engine, setSessions]);

  const refreshSessions = useCallback(async (projectIds?: string[]) => {
    const ids = (projectIds && projectIds.length > 0)
      ? projectIds
      : projectsRef.current.map((p) => p.id);
    if (ids.length === 0) return;
    const uniqueIds = [...new Set(ids)];
    const lists = await Promise.all(uniqueIds.map((projectId) => window.claude.sessions.list(projectId)));
    const refreshed = lists.flat().map((session) =>
      toChatSession(session, session.id === activeSessionIdRef.current),
    );
    setSessions((prev) => {
      const keep = prev.filter((s) => !uniqueIds.includes(s.projectId));
      const existingById = new Map(prev.map((session) => [session.id, session]));
      const map = new Map<string, ChatSession>();
      [...keep, ...refreshed].forEach((session) => {
        const existing = existingById.get(session.id);
        map.set(session.id, existing
          ? {
              ...session,
              isProcessing: existing.isProcessing,
              hasPendingPermission: existing.hasPendingPermission,
              hasUnreadCompletion: existing.hasUnreadCompletion,
              titleGenerating: existing.titleGenerating,
            }
          : session);
      });
      return Array.from(map.values()).sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt));
    });
  }, [setSessions]);

  // ── Derived state ──
  const isDraft = activeSessionId === DRAFT_ID;
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  const setCurrentBranch = useCallback((branch: string | undefined) => {
    currentBranchRef.current = branch;
  }, []);

  const completeAcpAuth = useCallback(async (result: ACPAuthenticateResult) => {
    if (!acpSessionId) return;
    const pendingPrompt = pendingAcpDraftPromptRef.current;
    acpAgentSessionIdRef.current = result.agentSessionId ?? acpAgentSessionIdRef.current;
    if (result.configOptions) {
      setInitialConfigOptions(result.configOptions);
      acp.setConfigOptions(result.configOptions);
    }
    if (result.mcpStatuses?.length) {
      const normalizedStatuses = result.mcpStatuses.map((status) => ({
        name: status.name,
        status: toMcpStatusState(status.status),
      }));
      setDraftMcpStatuses(normalizedStatuses);
      setAcpMcpStatuses(normalizedStatuses);
    }

    if (activeSessionIdRef.current === DRAFT_ID && draftProjectIdRef.current) {
      const project = findProject(draftProjectIdRef.current);
      if (project) {
        liveSessionIdsRef.current.add(acpSessionId);
        const now = Date.now();
        const currentBranch = currentBranchRef.current;
        setSessions((prev) => [
          {
            id: acpSessionId,
            projectId: project.id,
            title: "New Chat",
            createdAt: now,
            lastMessageAt: now,
            totalCost: 0,
            planMode: !!startOptionsRef.current.planMode,
            isActive: true,
            titleGenerating: true,
            engine: "acp" as const,
            agentId: startOptionsRef.current.agentId,
            agentSessionId: acpAgentSessionIdRef.current ?? undefined,
            ...(currentBranch ? { branch: currentBranch } : {}),
          },
          ...prev.filter((s) => s.id !== DRAFT_ID).map((s) => ({ ...s, isActive: false })),
        ]);
        setActiveSessionId(acpSessionId);
        setDraftProjectId(null);
        setDraftAcpSessionId(null);
        setAcpMcpStatuses(draftMcpStatusesRef.current.length > 0 ? draftMcpStatusesRef.current : []);
        if (pendingPrompt) {
          generateSessionTitle(acpSessionId, pendingPrompt.text, getProjectCwd(project), "acp");
        }
      }
    }

    acp.clearAuthRequired();

    if (!pendingPrompt) return;
    pendingAcpDraftPromptRef.current = null;
    acp.setIsProcessing(true);
    const promptResult = await window.claude.acp.prompt(acpSessionId, pendingPrompt.text, pendingPrompt.images);
    if (promptResult?.error) {
      acp.setMessages((prev) => [
        ...prev,
        createSystemMessage(`ACP prompt error: ${promptResult.error}`, true),
      ]);
      acp.setIsProcessing(false);
    }
  }, [acp, acpSessionId, findProject, generateSessionTitle, getProjectCwd, setAcpMcpStatuses, setDraftAcpSessionId, setDraftMcpStatuses, setDraftProjectId, setInitialConfigOptions, setSessions]);

  const cancelAcpAuth = useCallback(async () => {
    pendingAcpDraftPromptRef.current = null;
    acp.clearAuthRequired();
    acp.setIsProcessing(false);
    if (activeSessionIdRef.current === DRAFT_ID) {
      acp.setMessages([]);
      abandonDraftAcpSession("auth_cancel");
      setSessions((prev) => prev.filter((s) => s.id !== DRAFT_ID).map((s) => ({ ...s, isActive: false })));
      setInitialMessages([]);
      setInitialMeta(null);
      setActiveSessionId(null);
      setDraftProjectId(null);
      return;
    }
    if (acpSessionId) {
      suppressNextSessionCompletion(acpSessionId);
      await window.claude.acp.stop(acpSessionId);
    }
  }, [abandonDraftAcpSession, acp, acpSessionId, setActiveSessionId, setDraftProjectId, setInitialMessages, setInitialMeta, setSessions]);

  const loadSplitPaneBootstrap = useCallback(async (sessionId: string): Promise<SessionPaneBootstrap | null> => {
    const session = sessionsRef.current.find((entry) => entry.id === sessionId);
    if (!session) {
      return null;
    }

    const backgroundState = backgroundStoreRef.current.get(sessionId);
    if (backgroundState) {
      return {
        session,
        initialMessages: backgroundState.messages,
        initialMeta: {
          isProcessing: backgroundState.isProcessing,
          isConnected: backgroundState.isConnected,
          sessionInfo: backgroundState.sessionInfo,
          totalCost: backgroundState.totalCost,
          contextUsage: backgroundState.contextUsage,
          isCompacting: backgroundState.isCompacting,
        },
        initialPermission: backgroundState.pendingPermission,
        initialConfigOptions: backgroundState.configOptions ?? [],
        initialSlashCommands: backgroundState.slashCommands ?? [],
        initialRawAcpPermission: backgroundState.rawAcpPermission,
      };
    }

    const persistedSession = await window.claude.sessions.load(session.projectId, sessionId);
    if (!persistedSession) {
      return null;
    }

    return {
      session,
      initialMessages: persistedSession.messages ?? [],
      initialMeta: {
        isProcessing: false,
        isConnected: false,
        sessionInfo: null,
        totalCost: persistedSession.totalCost ?? 0,
        contextUsage: persistedSession.contextUsage ?? null,
      },
      initialPermission: null,
      initialConfigOptions: [],
      initialSlashCommands: [],
      initialRawAcpPermission: null,
    };
  }, []);

  const getRemoteSnapshot = useCallback(async (sessionId: string): Promise<RemoteSessionSnapshot | null> => {
    const session = sessionsRef.current.find((entry) => entry.id === sessionId);
    if (!session) return null;

    const project = projectsRef.current.find((entry) => entry.id === session.projectId);
    const engineId = session.engine ?? "claude";
    const active = activeSessionIdRef.current === sessionId;
    const background = active ? undefined : backgroundStoreRef.current.get(sessionId);
    // Only trust pane-level options when they were loaded for this exact session,
    // otherwise a stale set from a previously viewed session (different agent) leaks in.
    let acpConfigOptions = active && acp.configOptionsSessionId === sessionId
      ? acp.configOptions
      : (active ? [] : (background?.configOptions ?? []));
    let codexModels = codexRawModelsRef.current;
    if (engineId === "codex" && codexModels.length === 0) {
      try {
        const result = await window.claude.codex.listModels();
        const loaded = normalizeCodexModels(result.models ?? []);
        if (loaded.length > 0) {
          codexModels = loaded;
          codexRawModelsRef.current = loaded;
          setCodexRawModels((previous) => previous.length > 0 ? previous : loaded);
        }
      } catch {
        // A disconnected Codex app-server may not expose its catalog.
      }
    }
    if (engineId === "acp" && installedAgentsRef.current === undefined) {
      try {
        installedAgentsRef.current = await window.claude.agents.list();
      } catch {
        installedAgentsRef.current = [];
      }
    }
    if (engineId === "acp" && acpConfigOptions.length === 0) {
      try {
        const result = await window.claude.acp.getConfigOptions(sessionId);
        acpConfigOptions = (result?.configOptions ?? []) as typeof acpConfigOptions;
      } catch {
        // The session may no longer have a live ACP process.
      }
      // Per-session last-known options (persisted on the session record) beat the
      // agent-level cache: values differ between sessions of the same agent.
      if (acpConfigOptions.length === 0) {
        if (session.cachedConfigOptions?.length) {
          acpConfigOptions = session.cachedConfigOptions;
        } else {
          try {
            const full = await window.claude.sessions.load(session.projectId, sessionId);
            if (full?.cachedConfigOptions?.length) acpConfigOptions = full.cachedConfigOptions;
          } catch {
            // Session file may be unavailable.
          }
        }
      }
      if (acpConfigOptions.length === 0 && session.agentId) {
        acpConfigOptions = (installedAgentsRef.current ?? []).find((agent) => agent.id === session.agentId)?.cachedConfigOptions ?? [];
      }
    }
    const engineIcon = resolveEngineIcon(engineId, session.agentId);
    // ACP sessions carry no model field — surface the current model config option instead.
    const acpModelOption = engineId === "acp" ? acpConfigOptions.find((o) => o.id === "model") : undefined;
    const acpModelChoices = (acpModelOption?.options ?? []).flatMap((o) => ("value" in o ? [o] : (o.options ?? [])));
    const acpModelValue = acpModelOption?.currentValue ?? "";
    const availableModels = engineId === "codex"
      ? toRemoteModelOptions(codexModels)
      : engineId === "acp"
        ? acpModelChoices.map((option) => ({
            value: option.value,
            displayName: option.name,
            ...(option.description ? { description: option.description } : {}),
            ...(option.value === acpModelValue ? { isDefault: true } : {}),
          }))
        : toRemoteModelOptions(active ? remoteSupportedModelsRef.current : cachedModelsRef.current);
    const summary: RemoteSessionSummary = {
      id: session.id,
      projectId: session.projectId,
      ...(project?.name ? { projectName: project.name } : {}),
      title: session.title,
      createdAt: session.createdAt,
      ...(session.lastMessageAt !== undefined ? { lastMessageAt: session.lastMessageAt } : {}),
      ...(session.engine ? { engine: session.engine } : {}),
      ...(session.agentId ? { agentId: session.agentId } : {}),
      ...(engineIcon ? { engineIcon } : {}),
      ...((session.model || (active ? sessionInfoRef.current?.model : undefined) || acpModelValue)
        ? { model: session.model || (active ? sessionInfoRef.current?.model : undefined) || acpModelValue }
        : {}),
      ...(session.effort ? { effort: session.effort } : {}),
      ...((session.permissionMode || (active ? sessionInfoRef.current?.permissionMode : undefined))
        ? { permissionMode: session.permissionMode || sessionInfoRef.current?.permissionMode }
        : {}),
      ...(session.planMode !== undefined ? { planMode: session.planMode } : {}),
      ...(availableModels.length > 0 ? { availableModels } : {}),
      ...(engineId === "acp" && acpConfigOptions.length > 0
        ? { availableConfigOptions: acpConfigOptions }
        : {}),
      ...(session.isProcessing !== undefined ? { isProcessing: session.isProcessing } : {}),
      ...(session.hasPendingPermission !== undefined ? { hasPendingPermission: session.hasPendingPermission } : {}),
      ...(session.hasUnreadCompletion !== undefined ? { hasUnreadCompletion: session.hasUnreadCompletion } : {}),
    };

    if (active) {
      const serialized = toRemoteMessages(messagesRef.current, isProcessingRef.current);
      return {
        session: summary,
        messages: serialized.messages,
        isProcessing: isProcessingRef.current,
        isConnected: isConnectedRef.current,
        totalCost: totalCostRef.current,
        contextUsage: contextUsageRef.current,
        pendingPermission: toRemotePermission(pendingPermissionRef.current),
        truncated: serialized.truncated,
      };
    }

    if (background) {
      const backgroundTail = backgroundStoreRef.current.getMessageTail(sessionId, REMOTE_MESSAGE_LIMIT);
      const serialized = backgroundTail
        ? {
            messages: toRemoteMessages(backgroundTail.messages, background.isProcessing).messages,
            truncated: backgroundTail.truncated,
          }
        : toRemoteMessages(background.messages, background.isProcessing);
      const backgroundSummary: RemoteSessionSummary = {
        ...summary,
        ...(background.sessionInfo?.model ? { model: background.sessionInfo.model } : {}),
        ...(background.sessionInfo?.permissionMode ? { permissionMode: background.sessionInfo.permissionMode } : {}),
        ...(background.configOptions?.length ? { availableConfigOptions: background.configOptions } : {}),
      };
      return {
        session: backgroundSummary,
        messages: serialized.messages,
        isProcessing: background.isProcessing,
        isConnected: background.isConnected,
        totalCost: background.totalCost,
        contextUsage: background.contextUsage,
        pendingPermission: toRemotePermission(background.pendingPermission),
        truncated: serialized.truncated,
      };
    }

    const persisted = await window.claude.sessions.load(session.projectId, sessionId);
    if (!persisted) return null;
    const serialized = toRemoteMessages(persisted.messages ?? []);
    return {
      session: summary,
      messages: serialized.messages,
      isProcessing: false,
      isConnected: false,
      totalCost: persisted.totalCost ?? 0,
      contextUsage: persisted.contextUsage ?? null,
      pendingPermission: null,
      truncated: serialized.truncated,
    };
  }, []);

  const createRemoteSession = useCallback(async (
    projectId: string,
    options: { engine?: "claude" | "codex" | "acp"; model?: string; agentId?: string } = {},
  ): Promise<RemoteSessionSummary> => {
    const project = findProject(projectId);
    if (!project) throw new Error("Project not found");

    const engineId = options.engine ?? "claude";
    const mcpServers = await window.claude.mcp.list(project.id);
    let sessionId: string | undefined;
    let sessionModel = options.model;
    let agentSessionId: string | undefined;
    let codexThreadId: string | undefined;
    let cachedConfigOptions: ACPConfigOption[] | undefined;

    if (engineId === "claude") {
      const result = await window.claude.start({
        cwd: getProjectCwd(project),
        ...(options.model ? { model: options.model } : {}),
        permissionMode: getEffectiveClaudePermissionMode({ model: options.model }),
        mcpServers,
      });
      if (result.error || !result.sessionId) {
        throw new Error(result.error || "Failed to start Claude session");
      }
      sessionId = result.sessionId;
    } else if (engineId === "codex") {
      const result = await window.claude.codex.start({
        cwd: getProjectCwd(project),
        ...(options.model ? { model: options.model } : {}),
        ...(getCodexApprovalPolicy({}) ? { approvalPolicy: getCodexApprovalPolicy({}) } : {}),
        ...(getCodexSandboxMode({}) ? { sandbox: getCodexSandboxMode({}) } : {}),
      });
      if (result.needsAuth) {
        if (result.sessionId) await window.claude.codex.stop(result.sessionId);
        throw new Error("Codex authentication is required in L'Agents before creating a remote session");
      }
      if (result.error || !result.sessionId) {
        throw new Error(result.error || "Failed to start Codex session");
      }
      sessionId = result.sessionId;
      codexThreadId = result.threadId;
      sessionModel = result.selectedModel ?? sessionModel;
    } else {
      if (!options.agentId) throw new Error("ACP agentId is required");
      if (options.model) throw new Error("ACP model selection uses agent configuration and is not supported during creation");
      const result = await window.claude.acp.start({
        agentId: options.agentId,
        cwd: getProjectCwd(project),
        mcpServers,
      });
      if ("authRequired" in result && result.authRequired) {
        if (result.sessionId) await window.claude.acp.stop(result.sessionId);
        throw new Error("ACP authentication is required in L'Agents before creating a remote session");
      }
      if (("error" in result && result.error) || !("sessionId" in result) || !result.sessionId) {
        throw new Error(("error" in result ? result.error : undefined) || "Failed to start ACP session");
      }
      sessionId = result.sessionId;
      agentSessionId = "agentSessionId" in result ? result.agentSessionId : undefined;
      cachedConfigOptions = "configOptions" in result ? result.configOptions : undefined;
    }

    const id = sessionId;
    if (!id) throw new Error("Session did not return an id");
    if (sessionsRef.current.some((entry) => entry.id === id)) {
      try {
        if (engineId === "acp") await window.claude.acp.stop(id);
        else if (engineId === "codex") await window.claude.codex.stop(id);
        else await window.claude.stop(id, "remote_create_duplicate_id");
      } catch {
        // The duplicate ID is still rejected even if process cleanup fails.
      }
      throw new Error("Session ID already exists");
    }
    const now = Date.now();
    const session: ChatSession = {
      id,
      projectId: project.id,
      title: "New Chat",
      createdAt: now,
      lastMessageAt: now,
      ...(sessionModel ? { model: sessionModel } : {}),
      totalCost: 0,
      isActive: false,
      engine: engineId,
      ...(options.agentId ? { agentId: options.agentId } : {}),
      ...(engineId === "acp" ? { workingDirectory: getProjectCwd(project) } : {}),
      ...(agentSessionId ? { agentSessionId } : {}),
      ...(codexThreadId ? { codexThreadId } : {}),
      ...(cachedConfigOptions?.length ? { cachedConfigOptions } : {}),
    };

    liveSessionIdsRef.current.add(id);
    backgroundStoreRef.current.initFromState(id, {
      messages: [],
      isProcessing: false,
      isConnected: true,
      isCompacting: false,
      sessionInfo: null,
      totalCost: 0,
      contextUsage: null,
      pendingPermission: null,
      rawAcpPermission: null,
      slashCommands: [],
      configOptions: cachedConfigOptions ?? [],
    });
    try {
      const saveResult = await window.claude.sessions.save(buildPersistedSession(session, [], 0, null));
      if (saveResult?.error) throw new Error(saveResult.error);
    } catch (error) {
      suppressNextSessionCompletion(id);
      liveSessionIdsRef.current.delete(id);
      backgroundStoreRef.current.delete(id);
      try {
        if (engineId === "acp") await window.claude.acp.stop(id);
        else if (engineId === "codex") await window.claude.codex.stop(id);
        else await window.claude.stop(id, "remote_create_persist_failed");
      } catch {
        // Preserve the persistence error; the exit handler will finish cleanup.
      }
      throw error;
    }

    const nextSessions = [
      session,
      ...sessionsRef.current.filter((entry) => entry.id !== session.id),
    ];
    sessionsRef.current = nextSessions;
    setSessions(nextSessions);

    const acpModel = cachedConfigOptions?.find((option) => option.id === "model")?.currentValue;
    return {
      id: session.id,
      projectId: session.projectId,
      projectName: project.name,
      title: session.title,
      createdAt: session.createdAt,
      lastMessageAt: session.lastMessageAt,
      engine: session.engine,
      ...(session.agentId ? { agentId: session.agentId } : {}),
      ...(resolveEngineIcon(session.engine, session.agentId)
        ? { engineIcon: resolveEngineIcon(session.engine, session.agentId) }
        : {}),
      ...(session.model || acpModel ? { model: session.model || acpModel } : {}),
      ...(cachedConfigOptions?.length ? { availableConfigOptions: cachedConfigOptions } : {}),
      ...(session.isProcessing !== undefined ? { isProcessing: session.isProcessing } : {}),
    };
  }, [findProject, getProjectCwd, resolveEngineIcon, setSessions]);

  const sendToSession = useCallback(async (
    sessionId: string,
    text: string,
    images?: ImageAttachment[],
  ): Promise<void> => {
    const session = sessionsRef.current.find((entry) => entry.id === sessionId);
    if (!session || !text.trim()) throw new Error("Session not found");

    if (activeSessionIdRef.current === sessionId) {
      await send(text, images);
      return;
    }

    // Live background sessions can receive a message without changing the
    // desktop's active tab. Do not revive a dead session through switchSession:
    // that steals the desktop focus and makes the remote request non-local.
    // A dedicated background revive operation must be used once available.
    if (!liveSessionIdsRef.current.has(sessionId)) {
      throw new Error("Session is offline. Open it in L'Agents before sending a message.");
    }

    const background = backgroundStoreRef.current.get(sessionId);
    if (!background) throw new Error("Live session state is unavailable");
    if (background.isProcessing) {
      throw new Error("Session is still working. Wait for it to finish before sending another message.");
    }
    const sentAt = Date.now();
    setSessions((prev) => prev.map((entry) => (
      entry.id === sessionId
        ? { ...entry, lastMessageAt: sentAt, isProcessing: true }
        : entry
    )));
    backgroundStoreRef.current.updateMessages(sessionId, (messages) => [
      ...messages,
      createUserMessage(text, images),
    ]);
    backgroundStoreRef.current.setProcessing(sessionId, true);

    try {
      const engineId = session.engine ?? "claude";
      if (engineId === "acp") {
        const result = await window.claude.acp.prompt(sessionId, text, images);
        if (result?.error) throw new Error(result.error);
        return;
      }
      if (engineId === "codex") {
        const result = await window.claude.codex.send(
          sessionId,
          text,
          imageAttachmentsToCodexInputs(images),
          session.effort,
          session.planMode
            ? buildCodexCollabMode(session.planMode, session.model)
            : undefined,
        );
        if (result?.error) throw new Error(result.error);
        return;
      }

      const result = await window.claude.send(sessionId, {
        type: "user",
        message: { role: "user", content: buildSdkContent(text) },
      });
      if (result?.error) throw new Error(result.error);
    } catch (error) {
      backgroundStoreRef.current.setProcessing(sessionId, false);
      setSessions((prev) => prev.map((entry) => (
        entry.id === sessionId ? { ...entry, isProcessing: false } : entry
      )));
      throw error;
    }
  }, [send]);

  const activateSession = useCallback(async (sessionId: string): Promise<void> => {
    const session = sessionsRef.current.find((entry) => entry.id === sessionId);
    if (!session) throw new Error("Session not found");
    if (activeSessionIdRef.current !== sessionId) {
      await switchSession(sessionId);
      const deadline = Date.now() + 10_000;
      while (activeSessionIdRef.current !== sessionId && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (activeSessionIdRef.current !== sessionId) {
      throw new Error("Could not activate session");
    }
  }, [switchSession]);

  /** Revive the session's process only when it is neither active nor already live —
   *  used by remote settings changes that need a running ACP agent. */
  const ensureSessionLive = useCallback(async (sessionId: string): Promise<void> => {
    if (!sessionsRef.current.some((entry) => entry.id === sessionId)) throw new Error("Session not found");
    if (liveSessionIdsRef.current.has(sessionId)) return;

    const session = sessionsRef.current.find((s) => s.id === sessionId);
    const isAcpSession = session?.engine === "acp";

    // For ACP sessions, switch active first so the revival hook fires (it only
    // revives the active session) and the useACP pane state is primed for the
    // setConfig that follows.
    if (isAcpSession && activeSessionIdRef.current !== sessionId) {
      await activateSession(sessionId);
    }

    // If still not live (active-but-dead, or non-ACP), drive the revival directly.
    if (!liveSessionIdsRef.current.has(sessionId) && isAcpSession) {
      const result = await reviveAcpSessionById(sessionId);
      if (!result.ok) throw new Error(result.error || "Failed to revive ACP session");
    }

    // Wait for the live ref to commit so a subsequent setConfig reaches main.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (liveSessionIdsRef.current.has(sessionId)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Session did not come back online within 15s");
  }, [activateSession, reviveAcpSessionById]);

  const interruptSession = useCallback(async (sessionId: string): Promise<void> => {
    const session = sessionsRef.current.find((entry) => entry.id === sessionId);
    if (!session) throw new Error("Session not found");
    if (!liveSessionIdsRef.current.has(sessionId)) {
      throw new Error("Session is not currently running");
    }
    const engineId = session.engine ?? "claude";
    const result = engineId === "acp"
      ? await window.claude.acp.cancel(sessionId)
      : engineId === "codex"
        ? await window.claude.codex.interrupt(sessionId)
        : await window.claude.interrupt(sessionId);
    if (result?.error) throw new Error(result.error);
  }, []);

  const retrySession = useCallback(async (sessionId: string): Promise<void> => {
    const snapshot = await getRemoteSnapshot(sessionId);
    const lastUserMessage = snapshot?.messages.slice().reverse().find((message) => message.role === "user");
    if (!lastUserMessage?.content.trim()) throw new Error("No previous user message to retry");
    await sendToSession(sessionId, lastUserMessage.content);
  }, [getRemoteSnapshot, sendToSession]);

  const respondToSessionPermission = useCallback(async (
    sessionId: string,
    requestId: string,
    behavior: AppPermissionBehavior,
    input?: Record<string, unknown>,
    newPermissionMode?: string,
  ): Promise<void> => {
    const session = sessionsRef.current.find((entry) => entry.id === sessionId);
    if (!session) throw new Error("Session not found");
    if (activeSessionIdRef.current === sessionId) {
      const current = pendingPermissionRef.current;
      if (!current || current.requestId !== requestId) throw new Error("Permission request is stale");
      await engine.respondPermission(behavior, input, newPermissionMode);
      return;
    }

    const background = backgroundStoreRef.current.get(sessionId);
    const permission = background?.pendingPermission;
    if (!background || !permission || permission.requestId !== requestId) {
      throw new Error("Permission request is stale");
    }

    if (session.engine === "acp") {
      const raw = background.rawAcpPermission;
      if (!raw) throw new Error("ACP permission details are unavailable");
      const optionId = behavior === "deny"
        ? raw.options.find((option) => option.kind.startsWith("reject"))?.optionId
        : raw.options.find((option) => option.kind.startsWith("allow"))?.optionId;
      if (!optionId) throw new Error("No matching ACP permission option is available");
      const result = await window.claude.acp.respondPermission(sessionId, requestId, optionId);
      if (result?.error) throw new Error(result.error);
    } else if (session.engine === "codex") {
      const rpcId = permission.codexRpcId ?? permission.requestId;
      if (permission.toolName === "AskUserQuestion") {
        if (behavior === "deny") {
          const result = await window.claude.codex.respondServerRequestError(
            sessionId,
            rpcId,
            -32001,
            "User declined requestUserInput",
          );
          if (result?.error) throw new Error(result.error);
        } else {
          const rawAnswers = (input?.answersByQuestionId ?? {}) as Record<string, string[]>;
          const answers = Object.fromEntries(
            Object.entries(rawAnswers).map(([id, values]) => [id, {
              answers: values.map((value) => value.trim()).filter(Boolean),
            }]),
          );
          const result = await window.claude.codex.respondUserInput(sessionId, rpcId, answers);
          if (result?.error) throw new Error(result.error);
        }
      } else {
        const result = await window.claude.codex.respondApproval(
          sessionId,
          rpcId,
          behavior === "deny" ? "decline" : "accept",
          behavior === "allowForSession" ? { forSession: true } : undefined,
        );
        if (result?.error) throw new Error(result.error);
      }
    } else {
      const result = await window.claude.respondPermission(
        sessionId,
        requestId,
        behavior,
        permission.toolUseId,
        permission.toolInput,
        newPermissionMode,
      );
      if (result?.error) throw new Error(result.error);
    }

    backgroundStoreRef.current.clearPermission(sessionId);
    setSessions((prev) => prev.map((entry) => (
      entry.id === sessionId ? { ...entry, hasPendingPermission: false } : entry
    )));
  }, [engine, setSessions]);

  // ── Return ──
  return {
    primaryPane,
    sessions,
    setSessions,
    activeSessionId,
    setCurrentBranch,
    activeSession,
    isDraft,
    draftProjectId,
    createSession,
    createRemoteSession,
    switchSession,
    deselectSession,
    deleteSession,
    renameSession,
    importCCSession,
    setActiveModel,
    setSessionModel,
    setActivePermissionMode,
    setSessionPermissionMode,
    setActivePlanMode,
    setSessionPlanMode,
    setActiveThinking,
    setActiveClaudeEffort,
    setActiveClaudeModelAndEffort,
    setSessionClaudeModelAndEffort,
    setSessionEffort,
    updateSessionSettings,
    restartActiveSessionInCurrentWorktree,
    setDraftAgent,
    messages: engine.messages,
    isProcessing: engine.isProcessing,
    isConnected: engine.isConnected || isDraft,
    sessionInfo: engine.sessionInfo,
    totalCost: engine.totalCost,
    send,
    unqueueMessage,
    sendQueuedMessageNext,
    sendNextId,
    seedDevExampleConversation,
    refreshSessions,
    loadSplitPaneBootstrap,
    getRemoteSnapshot,
    resolveEngineIcon,
    sendToSession,
    activateSession,
    ensureSessionLive,
    interruptSession,
    retrySession,
    respondToSessionPermission,
    queuedCount,
    stop: engine.stop,
    interrupt: async () => {
      // Clear queued messages before interrupting
      clearQueue();
      // During ACP startup (DRAFT + processing), abort the pending start process
      if (activeSessionIdRef.current === DRAFT_ID
          && startOptionsRef.current.engine === "acp"
          && isProcessingRef.current) {
        if (draftAcpSessionIdRef.current && liveSessionIdsRef.current.has(draftAcpSessionIdRef.current)) {
          await window.claude.acp.cancel(draftAcpSessionIdRef.current);
        } else {
          await window.claude.acp.abortPendingStart();
        }
        acp.setIsProcessing(false);
        return;
      }
      await engine.interrupt();
    },
    pendingPermission: engine.pendingPermission,
    respondPermission: engine.respondPermission,
    contextUsage: engine.contextUsage,
    isCompacting: "isCompacting" in engine ? !!engine.isCompacting : false,
    compact: engine.compact,
    slashCommands: isCodex
      ? codex.slashCommands
      : isACP
        ? acp.slashCommands
        : claude.slashCommands,
    acpConfigOptions: acp.configOptions,
    acpConfigSessionId: acp.configOptionsSessionId,
    acpConfigOptionsLoading,
    setACPConfig: acp.setConfig,
    mcpServerStatuses: isACP || isCodex
      ? (acpMcpStatuses.length > 0 ? acpMcpStatuses : draftMcpStatuses)
      : (claude.mcpServerStatuses.length > 0 ? claude.mcpServerStatuses : draftMcpStatuses),
    mcpStatusPreliminary: isDraft && draftMcpStatuses.length > 0 && (
      isACP || isCodex ? acpMcpStatuses.length === 0 : claude.mcpServerStatuses.length === 0
    ),
    refreshMcpStatus: isACP || isCodex
      ? (() => Promise.resolve())
      : (preStartedSessionId && isDraft)
        ? (async () => {
            const result = await window.claude.mcpStatus(preStartedSessionId);
            if (result.servers?.length) {
              setDraftMcpStatuses(result.servers.map(s => ({
                name: s.name,
                status: toMcpStatusState(s.status),
              })));
            }
          })
        : claude.refreshMcpStatus,
    reconnectMcpServer: isACP
      ? isDraft
        ? async (_name: string) => {
            // ACP draft: restart the hidden draft session so fresh auth is applied
            if (draftProjectIdRef.current) {
              abandonDraftAcpSession("mcp_reconnect");
              await probeMcpServers(draftProjectIdRef.current);
              await eagerStartAcpSession(draftProjectIdRef.current, startOptionsRef.current);
            }
          }
        : async (_name: string) => {
            // ACP live: restart session so fresh auth tokens are applied
            const currentId = activeSessionIdRef.current;
            const session = sessionsRef.current.find(s => s.id === currentId);
            if (!session) return;
            const servers = await window.claude.mcp.list(session.projectId);
            await restartAcpSession(servers);
          }
      : isCodex
        ? async (_name: string) => { /* Codex MCP reconnect: not yet implemented */ }
      : (preStartedSessionId && isDraft)
        ? (async (name: string) => {
            const result = await window.claude.mcpReconnect(preStartedSessionId, name);
            if (result?.restarted) {
              await new Promise(r => setTimeout(r, 3000));
            }
            const statusResult = await window.claude.mcpStatus(preStartedSessionId);
            if (statusResult.servers?.length) {
              setDraftMcpStatuses(statusResult.servers.map(s => ({
                name: s.name,
                status: toMcpStatusState(s.status),
              })));
            }
          })
        : claude.reconnectMcpServer,
    supportedModels: isCodex
      ? codex.codexModels
      : isACP
        ? []
        : claude.supportedModels.length > 0 ? claude.supportedModels : cachedModels,
    cachedClaudeModels: cachedModels,
    restartWithMcpServers: isACP
      ? isDraft
        ? async (servers: McpServerConfig[]) => {
            // ACP draft: restart the hidden session with the updated MCP server list
            if (draftProjectIdRef.current) {
              await probeMcpServers(draftProjectIdRef.current, servers);
              abandonDraftAcpSession("mcp_restart");
              await eagerStartAcpSession(draftProjectIdRef.current, startOptionsRef.current, servers);
            }
          }
        : async (servers: McpServerConfig[]) => {
            // ACP live: stop + restart session with updated MCP servers
            await restartAcpSession(servers);
          }
      : isCodex
        ? async (_servers: McpServerConfig[]) => { /* Codex MCP restart: not yet implemented */ }
      : (preStartedSessionId && isDraft)
        ? async (_servers: McpServerConfig[]) => {
            // Claude eager draft: stop old eager session and start fresh
            abandonEagerSession("mcp_restart");
            setDraftMcpStatuses(_servers.map(s => ({
              name: s.name,
              status: "pending" as const,
            })));
            if (draftProjectIdRef.current) {
              eagerStartSession(draftProjectIdRef.current, startOptionsRef.current);
            }
          }
        : claude.restartWithMcpServers,
    // File revert: only supported by Claude SDK engine
    revertFiles: activeEngine === "claude" ? claude.revertFiles : undefined,
    fullRevert: activeEngine === "claude" ? fullRevertSession : undefined,
    // Codex reasoning effort
    codexEffort: codex.codexEffort,
    setCodexEffort: setCodexEffortFromUser,
    codexAuthRequired: isCodex ? codex.authRequired : false,
    clearCodexAuthRequired: () => codex.setAuthRequired(false),
    acpAuthRequired: isACP ? acp.authRequired : false,
    acpAuthMethods: isACP ? acp.authMethods : [],
    acpAuthSessionId: acpSessionId,
    acpAuthAgentId: isACP
      ? (activeSessionId === DRAFT_ID ? startOptions.agentId ?? null : activeSession?.agentId ?? null)
      : null,
    completeAcpAuth,
    cancelAcpAuth,
    codexRawModels,
    codexModelsLoadingMessage,
    // Codex plan steps (from turn/plan/updated events — separate from Claude's TodoWrite tool)
    codexTodoItems: codex.todoItems,
  };
}
