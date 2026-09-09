import { ipcMain } from "electron";
import { TelegramChannel } from "../telegram/channel";

export function register(channel: TelegramChannel): void {
  ipcMain.handle("telegram:get-status", () => channel.getStatus());
  ipcMain.handle("telegram:set-token", async (_event, token: unknown) => {
    try {
      if (typeof token !== "string") throw new Error("Telegram Bot Token is required");
      await channel.setToken(token);
      return { ok: true };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("telegram:clear-token", async () => {
    try {
      await channel.clearToken();
      return { ok: true };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("telegram:set-allowed-users", (_event, userIds: unknown) => {
    if (!Array.isArray(userIds) || userIds.some((id) => typeof id !== "string")) {
      return { error: "Telegram user IDs must be strings" };
    }
    channel.setAllowedUserIds(userIds as string[]);
    return { ok: true };
  });
  ipcMain.handle("telegram:set-instructions", (_event, instructions: unknown) => {
    if (typeof instructions !== "string" || instructions.trim().length > 4000) {
      return { error: "Assistant instructions must be at most 4000 characters" };
    }
    channel.setAssistantInstructions(instructions);
    return { ok: true };
  });
  ipcMain.handle("telegram:send-voice-transcription", async (_event, payload: unknown) => {
    try {
      if (!payload || typeof payload !== "object"
        || typeof (payload as { chatId?: unknown }).chatId !== "number"
        || typeof (payload as { text?: unknown }).text !== "string") {
        throw new Error("Invalid voice transcription");
      }
      await channel.sendVoiceTranscription(
        (payload as { chatId: number }).chatId,
        (payload as { text: string }).text,
      );
      return { ok: true };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("telegram:read-media", async (_event, mediaPath: unknown) => {
    try {
      if (typeof mediaPath !== "string") throw new Error("Invalid media path");
      return await channel.readMedia(mediaPath);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("telegram:notify", async (_event, payload: unknown) => {
    try {
      if (!payload || typeof payload !== "object"
        || typeof (payload as { chatId?: unknown }).chatId !== "number"
        || typeof (payload as { text?: unknown }).text !== "string") {
        throw new Error("Invalid Telegram notification");
      }
      await channel.notifyChat(
        (payload as { chatId: number }).chatId,
        (payload as { text: string }).text,
      );
      return { ok: true };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}
