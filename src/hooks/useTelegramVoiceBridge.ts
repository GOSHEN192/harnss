import { useEffect } from "react";
import { transcribeTelegramVoice } from "@/lib/telegram-voice";

export function useTelegramVoiceBridge(): void {
  useEffect(() => {
    const unsubscribe = window.claude.telegram.onVoice(async ({ chatId, mediaPath, mimeType }) => {
      try {
        const media = await window.claude.telegram.readMedia(mediaPath);
        if ("error" in media) throw new Error(media.error);
        const bytes = Uint8Array.from(atob(media.data), (character) => character.charCodeAt(0));
        const text = await transcribeTelegramVoice(new Blob([bytes], { type: mimeType }));
        if (!text) throw new Error("语音中没有识别到文字");
        const result = await window.claude.telegram.sendVoiceTranscription(chatId, text);
        if (result.error) throw new Error(result.error);
      } catch (error) {
        console.error("[telegram] voice transcription failed", error);
        await window.claude.telegram.notify(
          chatId,
          `语音处理失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    return unsubscribe;
  }, []);
}
