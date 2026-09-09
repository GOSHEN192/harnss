import { useCallback, useEffect, useState } from "react";
import type { RealtimeVoiceSettings, RealtimeVoiceStatus } from "@shared/types/settings";

export interface RealtimeVoiceControls {
  status: RealtimeVoiceStatus;
  error?: string;
  enabled: boolean;
  toggle: () => Promise<void>;
}

const DEFAULT_SETTINGS: RealtimeVoiceSettings = {
  enabled: false,
  endpoint: "ws://127.0.0.1:8765/v1/realtime",
  bridgeDir: "",
  gatewayPort: 8766,
  inputDevice: "",
  outputDevice: "",
  allowSend: false,
};

export function useRealtimeVoice(): RealtimeVoiceControls {
  const [settings, setSettings] = useState<RealtimeVoiceSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<RealtimeVoiceStatus>("stopped");
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!window.claude?.realtimeVoice) return;
    let cancelled = false;
    void window.claude.settings.get().then((next) => {
      if (!cancelled && next?.realtimeVoice) setSettings(next.realtimeVoice);
    }).catch(() => {});
    const unsubscribeSettings = window.claude.settings.onChanged((next) => {
      if (next.realtimeVoice) setSettings(next.realtimeVoice);
    });
    const unsubscribeVoice = window.claude.realtimeVoice.onState((next) => {
      setStatus(next.status);
      setError(next.error);
    });
    void window.claude.realtimeVoice.getState().then((next) => {
      if (!cancelled) {
        setStatus(next.status);
        setError(next.error);
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
      unsubscribeSettings();
      unsubscribeVoice();
    };
  }, []);

  const toggle = useCallback(async () => {
    setError(undefined);
    if (!window.claude?.realtimeVoice) {
      setStatus("error");
      setError("Realtime voice is unavailable in this build.");
      return;
    }
    if (!settings.enabled) {
      setStatus("error");
      setError("Enable Realtime Voice in Settings → General first.");
      return;
    }
    const next = status === "stopped" || status === "error"
      ? await window.claude.realtimeVoice.start()
      : await window.claude.realtimeVoice.stop();
    setStatus(next.status);
    setError(next.error);
  }, [settings.enabled, status]);

  return { status, error, enabled: settings.enabled, toggle };
}
