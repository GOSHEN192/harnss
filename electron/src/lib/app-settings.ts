/**
 * Main-process settings store — JSON file in the app data directory.
 *
 * Unlike useSettings (renderer localStorage), this store is readable at
 * startup before any BrowserWindow exists. Use it for settings that the
 * main process needs synchronously (e.g. autoUpdater.allowPrerelease).
 *
 * File location: {userData}/openacpui-data/settings.json (kept as openacpui-data for backward compat)
 */

import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";
import { getDataDir } from "./data-dir";
import type { AppSettings, NotificationSettings } from "@shared/types/settings";

// Re-export shared types so existing `import from "./app-settings"` consumers still work
export type { AppSettings, MacBackgroundEffect, PreferredEditor, VoiceDictationMode, NotificationTrigger, NotificationEventSettings, NotificationSettings, CodexBinarySource, ClaudeBinarySource, RealtimeVoiceSettings, RealtimeVoiceStatus } from "@shared/types/settings";

const NOTIFICATION_DEFAULTS: NotificationSettings = {
  exitPlanMode: { osNotification: "unfocused", sound: "always" },
  permissions: { osNotification: "unfocused", sound: "unfocused" },
  askUserQuestion: { osNotification: "unfocused", sound: "always" },
  sessionComplete: { osNotification: "unfocused", sound: "always" },
};

const DEFAULTS: AppSettings = {
  allowPrereleaseUpdates: false,
  defaultChatLimit: 10,
  preferredEditor: "auto",
  voiceDictation: "native",
  notifications: NOTIFICATION_DEFAULTS,
  codexClientName: "Harnss",
  codexBinarySource: "auto",
  codexCustomBinaryPath: "",
  claudeBinarySource: "auto",
  claudeCustomBinaryPath: "",
  showDevFillInChatTitleBar: false,
  showJiraBoard: false,
  macBackgroundEffect: "liquid-glass",
  analyticsEnabled: true,
  remoteEnabled: false,
  remotePort: 8787,
  remoteToken: randomBytes(32).toString("base64url"),
  telegramEnabled: false,
  realtimeVoice: {
    enabled: false,
    endpoint: "ws://127.0.0.1:8765/v1/realtime",
    bridgeDir: "",
    gatewayPort: 8766,
    inputDevice: "",
    outputDevice: "",
    allowSend: false,
  },
};

// ── Internal state ──

let cached: AppSettings | null = null;

function filePath(): string {
  return path.join(getDataDir(), "settings.json");
}

// ── Public API ──

/** Read the full settings object (cached after first read). */
export function getAppSettings(): AppSettings {
  if (cached) return cached;

  try {
    const raw = fs.readFileSync(filePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    // Merge with defaults so newly added keys are always present.
    // Deep-merge `notifications` so upgrading users get defaults for each event type
    // even if their settings.json has a partial or missing notifications object.
    const parsedNotif = parsed.notifications as Partial<NotificationSettings> | undefined;
    cached = {
      ...DEFAULTS,
      ...parsed,
      remoteEnabled: parsed.remoteEnabled === true,
      remotePort: typeof parsed.remotePort === "number" && Number.isInteger(parsed.remotePort)
        ? Math.max(1024, Math.min(65535, parsed.remotePort))
        : DEFAULTS.remotePort,
      remoteToken: typeof parsed.remoteToken === "string" && parsed.remoteToken.length >= 16
        ? parsed.remoteToken
        : DEFAULTS.remoteToken,
      realtimeVoice: {
        ...DEFAULTS.realtimeVoice,
        ...(parsed.realtimeVoice && typeof parsed.realtimeVoice === "object"
          ? parsed.realtimeVoice
          : {}),
        enabled: parsed.realtimeVoice?.enabled === true,
        endpoint: typeof parsed.realtimeVoice?.endpoint === "string" && parsed.realtimeVoice.endpoint.length <= 500
          ? parsed.realtimeVoice.endpoint
          : DEFAULTS.realtimeVoice.endpoint,
        bridgeDir: typeof parsed.realtimeVoice?.bridgeDir === "string"
          ? parsed.realtimeVoice.bridgeDir.slice(0, 1000)
          : DEFAULTS.realtimeVoice.bridgeDir,
        gatewayPort: typeof parsed.realtimeVoice?.gatewayPort === "number" && Number.isInteger(parsed.realtimeVoice.gatewayPort)
          ? Math.max(1024, Math.min(65535, parsed.realtimeVoice.gatewayPort))
          : DEFAULTS.realtimeVoice.gatewayPort,
        inputDevice: typeof parsed.realtimeVoice?.inputDevice === "string"
          ? parsed.realtimeVoice.inputDevice.slice(0, 300)
          : DEFAULTS.realtimeVoice.inputDevice,
        outputDevice: typeof parsed.realtimeVoice?.outputDevice === "string"
          ? parsed.realtimeVoice.outputDevice.slice(0, 300)
          : DEFAULTS.realtimeVoice.outputDevice,
        allowSend: parsed.realtimeVoice?.allowSend === true,
      },
      notifications: {
        exitPlanMode: { ...NOTIFICATION_DEFAULTS.exitPlanMode, ...parsedNotif?.exitPlanMode },
        permissions: { ...NOTIFICATION_DEFAULTS.permissions, ...parsedNotif?.permissions },
        askUserQuestion: { ...NOTIFICATION_DEFAULTS.askUserQuestion, ...parsedNotif?.askUserQuestion },
        sessionComplete: { ...NOTIFICATION_DEFAULTS.sessionComplete, ...parsedNotif?.sessionComplete },
      },
    };
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached;
}

/** Read a single setting by key. */
export function getAppSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return getAppSettings()[key];
}

/** Update one or more settings and persist to disk. */
export function setAppSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getAppSettings();
  const next = { ...current, ...patch };
  cached = next;

  try {
    fs.writeFileSync(filePath(), JSON.stringify(next, null, 2), "utf-8");
  } catch {
    // Non-fatal — setting is still cached in memory for this session
  }
  return next;
}
