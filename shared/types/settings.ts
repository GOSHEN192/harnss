/**
 * Settings types shared between electron and renderer processes.
 *
 * Canonical definitions — import from here, never redefine.
 */

// ── Simple scalar types ──

export type PreferredEditor = "auto" | "cursor" | "code" | "zed";
export type VoiceDictationMode = "native" | "whisper";
export type ThemeOption = "light" | "dark" | "system";
export type MacBackgroundEffect = "liquid-glass" | "vibrancy" | "off";
export type CodexBinarySource = "auto" | "managed" | "custom";
export type ClaudeBinarySource = "auto" | "managed" | "custom";
export type RealtimeVoiceStatus = "stopped" | "starting" | "connected" | "error";

export interface RealtimeVoiceSettings {
  /** Enables the additive realtime voice controls and local mobile gateway. */
  enabled: boolean;
  /** Upstream speech-to-speech Realtime WebSocket endpoint. */
  endpoint: string;
  /** Optional absolute path to the isolated harnss-voice-bridge project. */
  bridgeDir: string;
  /** Port for the localhost browser voice gateway. */
  gatewayPort: number;
  /** PortAudio input device index or exact name. */
  inputDevice: string;
  /** PortAudio output device index or exact name. */
  outputDevice: string;
  /** Allow the bridge's guarded send tool to be available after spoken confirmation. */
  allowSend: boolean;
}

// ── Notification settings ──

export type NotificationTrigger = "always" | "unfocused" | "never";

export interface NotificationEventSettings {
  osNotification: NotificationTrigger;
  sound: NotificationTrigger;
}

export interface NotificationSettings {
  exitPlanMode: NotificationEventSettings;
  permissions: NotificationEventSettings;
  askUserQuestion: NotificationEventSettings;
  sessionComplete: NotificationEventSettings;
}

// ── Main AppSettings interface ──

/** Main-process app settings (persisted to JSON file in data dir). */
export interface AppSettings {
  /** Include pre-release versions when checking for updates */
  allowPrereleaseUpdates: boolean;
  /** Number of recent chats to show per project in the sidebar (default: 10) */
  defaultChatLimit: number;
  /** Preferred code editor for "Open in Editor" actions (default: "auto") */
  preferredEditor: PreferredEditor;
  /** Voice dictation mode: "native" uses OS dictation, "whisper" uses local AI model (default: "native") */
  voiceDictation: VoiceDictationMode;
  /** Per-event notification and sound configuration */
  notifications: NotificationSettings;
  /** Custom client name sent to Codex servers during handshake (default: "Harnss") */
  codexClientName: string;
  /** Which Codex binary source to use */
  codexBinarySource: CodexBinarySource;
  /** Absolute path used when codexBinarySource is custom */
  codexCustomBinaryPath: string;
  /** Which Claude binary source to use */
  claudeBinarySource: ClaudeBinarySource;
  /** Absolute path used when claudeBinarySource is custom */
  claudeCustomBinaryPath: string;
  /** Show developer-only "Dev Fill" button in chat title bar (local dev builds only) */
  showDevFillInChatTitleBar: boolean;
  /** Show the Jira board UI in the sidebar and main panel (developer preview) */
  showJiraBoard: boolean;
  /** Preferred native macOS background material when window transparency is enabled */
  macBackgroundEffect: MacBackgroundEffect;
  /** Enable anonymous analytics to help improve the app (default: true) */
  analyticsEnabled: boolean;
  /** Anonymous user ID for analytics (auto-generated) */
  analyticsUserId?: string;
  /** Last date (YYYY-MM-DD) when daily_active_user was sent */
  analyticsLastDailyActiveDate?: string;
  /** Enable the authenticated localhost remote-control server */
  remoteEnabled: boolean;
  /** Localhost port used by the remote-control server */
  remotePort: number;
  /** Bearer token required by remote-control clients */
  remoteToken: string;
  /** Enable the optional Telegram channel adapter */
  telegramEnabled: boolean;
  /** Additive realtime voice gateway and desktop voice bridge settings */
  realtimeVoice: RealtimeVoiceSettings;
}
