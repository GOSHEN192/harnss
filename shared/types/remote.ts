import type { ACPConfigOption } from "./acp";
import type { AcpPermissionBehavior } from "./engine";

export type RemoteRequestMethod =
  | "sessions.list"
  | "sessions.get"
  | "sessions.send"
  | "sessions.approve"
  | "sessions.update-settings"
  | "sessions.action"
  | "sessions.create";

export interface RemoteModelOption {
  value: string;
  displayName: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  isDefault?: boolean;
}

export interface RemoteSessionSummary {
  id: string;
  projectId: string;
  projectName?: string;
  title: string;
  createdAt: number;
  lastMessageAt?: number;
  engine?: string;
  agentId?: string;
  engineIcon?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  planMode?: boolean;
  availableModels?: RemoteModelOption[];
  availableConfigOptions?: ACPConfigOption[];
  acpPermissionBehavior?: AcpPermissionBehavior;
  isProcessing?: boolean;
  hasPendingPermission?: boolean;
  hasUnreadCompletion?: boolean;
}

export interface RemoteMessage {
  id: string;
  role: "user" | "assistant" | "tool_call" | "tool_result" | "system" | "summary";
  content: string;
  displayContent?: string;
  toolSummary?: string;
  toolName?: string;
  thinking?: string;
  subagentStatus?: "running" | "completed";
  subagentSteps?: Array<{
    toolName: string;
    status: "running" | "completed" | "error";
  }>;
  isStreaming?: boolean;
  timestamp: number;
  isError?: boolean;
  toolError?: boolean;
}

export interface RemoteImageAttachment {
  id: string;
  data: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  fileName?: string;
}

export interface RemotePermission {
  requestId: string;
  toolName: string;
  toolUseId: string;
  decisionReason?: string;
  /** Redacted, display-only input summary. It is not used to execute a response. */
  summary?: string;
  kind: "approval" | "user-input";
  questions?: Array<{
    id: string;
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
}

export interface RemoteSessionSnapshot {
  session: RemoteSessionSummary;
  messages: RemoteMessage[];
  isProcessing: boolean;
  isConnected: boolean;
  totalCost: number;
  contextUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    contextWindow: number;
  } | null;
  pendingPermission: RemotePermission | null;
  truncated: boolean;
  /** Monotonic per-session revision used to reject stale HTTP/WebSocket updates. */
  revision?: number;
}

export interface RemoteRendererRequest {
  requestId: string;
  method: RemoteRequestMethod;
  payload: Record<string, unknown>;
}

export interface RemoteRendererResponse {
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface RemoteSessionUpdatedEvent {
  type: "session.updated";
  sessionId: string;
  snapshot: RemoteSessionSnapshot;
}

export interface RemoteServerEvent {
  type: "remote.ready" | "sessions.updated" | "session.updated";
  [key: string]: unknown;
}

export interface RemoteApprovalInput {
  behavior: "allow" | "deny" | "allowForSession";
  answersByQuestionId?: Record<string, string[]>;
  denyMessage?: string;
  newPermissionMode?: string;
}

export interface RemoteSessionSettingsInput {
  model?: string;
  effort?: string;
  permissionMode?: string;
  planMode?: boolean;
  configValues?: Record<string, string>;
  acpPermissionBehavior?: AcpPermissionBehavior;
}

export type RemoteSessionAction = "activate" | "interrupt" | "retry";
