import type { ACPConfigOption } from "./acp";
import type { AcpPermissionBehavior } from "./engine";

export type RemoteRequestMethod =
  | "projects.list"
  | "sessions.list"
  | "sessions.get"
  | "sessions.send"
  | "sessions.approve"
  | "sessions.update-settings"
  | "sessions.action"
  | "sessions.create"
  | "sessions.rename";

export interface RemoteProjectSummary {
  id: string;
  name: string;
}

export interface RemoteAcceptedResult {
  accepted: true;
}

export interface RemoteSessionCreateResult {
  accepted: true;
  sessionId: string;
  session: RemoteSessionSummary;
  status: "ready" | "starting";
}

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

export type RemoteCapabilityStatus =
  | "implemented"
  | "partial"
  | "intentional-divergence"
  | "desktop-only"
  | "security-limited";

export interface RemoteCapability {
  id: string;
  label: string;
  status: RemoteCapabilityStatus;
  method?: RemoteRequestMethod;
  note: string;
}

/**
 * Auditable boundary between the desktop surface and the authenticated Remote WebUI.
 * Keep unsafe or intentionally removed capabilities explicit instead of presenting
 * disabled controls as if they were parity-complete.
 */
export const REMOTE_CAPABILITY_MANIFEST: readonly RemoteCapability[] = [
  { id: "projects.read", label: "Project list", status: "implemented", method: "projects.list", note: "Names only; local paths stay in the desktop app." },
  { id: "projects.mutation", label: "Project CRUD, icons, folders, and spaces", status: "security-limited", note: "Not exposed until mutation scope and confirmation policy are defined." },
  { id: "sessions.control", label: "Session list, history, messages, approvals, settings, and actions", status: "implemented", method: "sessions.get", note: "Authenticated same-origin HTTP plus revision-guarded WebSocket updates." },
  { id: "sessions.create", label: "Create Claude, Codex, or ACP sessions", status: "implemented", method: "sessions.create", note: "Credentials and authentication remain desktop-only." },
  { id: "sessions.rename", label: "Rename sessions", status: "implemented", method: "sessions.rename", note: "Bounded title mutation through the existing desktop manager." },
  { id: "sessions.delete", label: "Delete sessions", status: "security-limited", note: "Irreversible deletion is withheld pending explicit target, scope, and recovery policy." },
  { id: "attachments", label: "Image attachments", status: "partial", note: "Desktop and renderer plumbing exist; Remote HTTP/UI transport remains bounded and unopened." },
  { id: "files", label: "Files and project files", status: "desktop-only", note: "File reads, writes, rename, trash, and revert are not exposed to the browser." },
  { id: "browser", label: "Browser panel and browser grab", status: "desktop-only", note: "No remote browser or fake artifact behavior." },
  { id: "mcp", label: "MCP status, auth, and configuration", status: "security-limited", note: "Credentials and configuration mutation remain desktop-only." },
  { id: "todo", label: "Todo/task panel", status: "desktop-only", note: "Remote snapshots carry generic tool activity only." },
  { id: "background-agents", label: "Background agents", status: "partial", note: "Subagent activity can appear in messages; stop, dismiss, and transcript controls are not exposed." },
  { id: "jira", label: "Jira board", status: "desktop-only", note: "External account and issue mutation remain in the desktop app." },
  { id: "tools", label: "Terminal, Git, and tool panels", status: "desktop-only", note: "No remote shell or repository mutation route." },
  { id: "revert", label: "File and full-session revert", status: "security-limited", note: "Destructive filesystem mutation requires a separate step-up authorization policy." },
  { id: "compaction", label: "Context compaction", status: "desktop-only", note: "Remote displays context usage but does not trigger compaction." },
  { id: "slash-commands", label: "Slash command catalog", status: "desktop-only", note: "Remote composer intentionally remains plain text." },
  { id: "voice", label: "Web voice, Web Speech, and floating ball", status: "intentional-divergence", note: "Removed from Remote WebUI; native iOS/App voice remains unchanged." },
  { id: "credentials", label: "API keys, Codex/ACP auth, and MCP credentials", status: "security-limited", note: "Never sent to or stored in the browser." },
] as const;
