import { randomBytes } from "node:crypto";
import { JsonFileStore } from "./json-file-store";

export interface TelegramChannelState {
  botToken: string;
  allowedUserIds: string[];
  pairingCode: string;
  bindings: Record<string, string>;
  chatUserIds: Record<string, string>;
  assistantInstructions: string;
}

export const DEFAULT_TELEGRAM_ASSISTANT_INSTRUCTIONS =
  "你是我们公司的 AI 助理。你可以使用当前 Harnss session 已配置的工具、MCP 服务器和 skills；需要时可以调用其他 agent 协作。先理解用户目标，再安全地执行任务，并用中文简洁汇报结果。";

const store = new JsonFileStore<TelegramChannelState>({
  subDir: "telegram",
  sanitizeKey: () => "channel",
  encrypt: true,
  label: "TELEGRAM",
});

export function newPairingCode(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

export function getTelegramChannelState(): TelegramChannelState {
  const state = store.load("channel");
  const allowedUserIds = state?.allowedUserIds ?? [];
  const bindings = state?.bindings ?? {};
  const chatUserIds = { ...(state?.chatUserIds ?? {}) };
  // Older builds persisted bindings before recording the owning Telegram user.
  // When there is exactly one allowlisted user, safely migrate those legacy
  // bindings to that user instead of silently losing the active session.
  if (allowedUserIds.length === 1) {
    for (const chatId of Object.keys(bindings)) {
      if (!chatUserIds[chatId]) chatUserIds[chatId] = allowedUserIds[0];
    }
  }
  return {
    botToken: state?.botToken ?? "",
    allowedUserIds,
    pairingCode: state?.pairingCode || newPairingCode(),
    bindings,
    chatUserIds,
    assistantInstructions: state?.assistantInstructions || DEFAULT_TELEGRAM_ASSISTANT_INSTRUCTIONS,
  };
}

export function saveTelegramChannelState(patch: Partial<TelegramChannelState>): TelegramChannelState {
  const next = { ...getTelegramChannelState(), ...patch };
  store.save("channel", next);
  return next;
}

export function clearTelegramChannelState(): void {
  store.delete("channel");
}
