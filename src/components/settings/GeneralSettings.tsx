import { memo, useState, useCallback, useEffect } from "react";
import { Download, MessageSquare, Code, Mic, Languages, Radio, Send } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SettingRow, SettingsSelect, SettingsHeader, SettingsSection } from "@/components/settings/shared";
import type { AppSettings, PreferredEditor, VoiceDictationMode } from "@/types";
import type { RealtimeVoiceSettings, RealtimeVoiceStatus } from "@shared/types/settings";
import { useTranslation } from "@/lib/i18n";

interface GeneralSettingsProps {
  appSettings: AppSettings | null;
  onUpdateAppSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

// ── Component ──

export const GeneralSettings = memo(function GeneralSettings({
  appSettings,
  onUpdateAppSettings,
}: GeneralSettingsProps) {
  const { language, setLanguage, t } = useTranslation();
  // Local optimistic state — synced from props once loaded
  const [allowPrerelease, setAllowPrerelease] = useState(false);
  const [chatLimit, setChatLimit] = useState(10);
  const [preferredEditor, setPreferredEditor] = useState<PreferredEditor>("auto");
  const [voiceDictation, setVoiceDictation] = useState<VoiceDictationMode>("native");
  const [remoteEnabled, setRemoteEnabled] = useState(false);
  const [remotePort, setRemotePort] = useState(8787);
  const [remoteToken, setRemoteToken] = useState("");
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramUsers, setTelegramUsers] = useState("");
  const [telegramInstructions, setTelegramInstructions] = useState("");
  const [telegramStatus, setTelegramStatus] = useState<{
    configured: boolean;
    running: boolean;
    botUsername?: string;
    pairingCode: string;
    allowedUserIds: string[];
  } | null>(null);
  const [telegramMessage, setTelegramMessage] = useState("");
  const [realtimeVoice, setRealtimeVoice] = useState<RealtimeVoiceSettings>({
    enabled: false,
    endpoint: "ws://127.0.0.1:8765/v1/realtime",
    bridgeDir: "",
    gatewayPort: 8766,
    inputDevice: "",
    outputDevice: "",
    allowSend: false,
  });
  const [realtimeDevices, setRealtimeDevices] = useState<Array<{
    index: number;
    name: string;
    maxInputChannels: number;
    maxOutputChannels: number;
  }>>([]);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeVoiceStatus>("stopped");
  const [realtimeError, setRealtimeError] = useState("");

  useEffect(() => {
    if (appSettings) {
      setAllowPrerelease(appSettings.allowPrereleaseUpdates);
      setChatLimit(appSettings.defaultChatLimit || 10);
      setPreferredEditor(appSettings.preferredEditor || "auto");
      setVoiceDictation(appSettings.voiceDictation || "native");
      setRemoteEnabled(!!appSettings.remoteEnabled);
      setRemotePort(appSettings.remotePort || 8787);
      setRemoteToken(appSettings.remoteToken || "");
      setTelegramEnabled(!!appSettings.telegramEnabled);
      if (appSettings.realtimeVoice) setRealtimeVoice(appSettings.realtimeVoice);
    }
  }, [appSettings]);

  useEffect(() => {
    const voice = window.claude.realtimeVoice;
    if (!voice) return;
    const unsubscribe = voice.onState((state) => {
      setRealtimeStatus(state.status);
      setRealtimeError(state.error ?? "");
    });
    if (realtimeVoice.enabled) {
      void voice.listDevices().then((result) => {
        if (result.devices) setRealtimeDevices(result.devices);
        if (result.error) setRealtimeError(result.error);
      });
    }
    return unsubscribe;
  }, [realtimeVoice.enabled]);

  const refreshTelegramStatus = useCallback(async () => {
    const status = await window.claude.telegram.getStatus();
    setTelegramStatus(status);
    setTelegramUsers(status.allowedUserIds.join(", "));
    setTelegramInstructions(status.assistantInstructions);
  }, []);

  useEffect(() => {
    void refreshTelegramStatus();
  }, [refreshTelegramStatus]);

  const handleTogglePrerelease = useCallback(
    async (checked: boolean) => {
      setAllowPrerelease(checked); // optimistic
      await onUpdateAppSettings({ allowPrereleaseUpdates: checked });
    },
    [onUpdateAppSettings],
  );

  const handleChatLimitChange = useCallback(
    async (value: number) => {
      const clamped = Math.max(5, Math.min(100, value));
      setChatLimit(clamped);
      await onUpdateAppSettings({ defaultChatLimit: clamped });
    },
    [onUpdateAppSettings],
  );

  const handleEditorChange = useCallback(
    async (value: PreferredEditor) => {
      setPreferredEditor(value); // optimistic
      await onUpdateAppSettings({ preferredEditor: value });
    },
    [onUpdateAppSettings],
  );

  const handleVoiceDictationChange = useCallback(
    async (value: VoiceDictationMode) => {
      setVoiceDictation(value); // optimistic
      await onUpdateAppSettings({ voiceDictation: value });
    },
    [onUpdateAppSettings],
  );

  const handleRemoteEnabledChange = useCallback(
    async (checked: boolean) => {
      setRemoteEnabled(checked);
      await onUpdateAppSettings({ remoteEnabled: checked });
    },
    [onUpdateAppSettings],
  );

  const handleRemotePortChange = useCallback(
    async (value: number) => {
      const port = Math.max(1024, Math.min(65535, value));
      setRemotePort(port);
      await onUpdateAppSettings({ remotePort: port });
    },
    [onUpdateAppSettings],
  );

  const updateRealtimeVoice = useCallback(
    async (patch: Partial<RealtimeVoiceSettings>) => {
      const next = { ...realtimeVoice, ...patch };
      setRealtimeVoice(next);
      await onUpdateAppSettings({ realtimeVoice: next });
    },
    [onUpdateAppSettings, realtimeVoice],
  );

  const refreshRealtimeDevices = useCallback(async () => {
    const result = await window.claude.realtimeVoice.listDevices();
    if (result.devices) setRealtimeDevices(result.devices);
    if (result.error) setRealtimeError(result.error);
  }, []);

  const handleTelegramEnabledChange = useCallback(
    async (checked: boolean) => {
      setTelegramEnabled(checked);
      await onUpdateAppSettings({ telegramEnabled: checked });
      await refreshTelegramStatus();
    },
    [onUpdateAppSettings, refreshTelegramStatus],
  );

  const handleTelegramTokenSave = useCallback(async () => {
    const result = await window.claude.telegram.setToken(telegramToken);
    setTelegramMessage(result.error ?? "Telegram token saved.");
    if (!result.error) {
      setTelegramToken("");
      await refreshTelegramStatus();
    }
  }, [refreshTelegramStatus, telegramToken]);

  const handleTelegramTokenClear = useCallback(async () => {
    const result = await window.claude.telegram.clearToken();
    setTelegramMessage(result.error ?? "Telegram token cleared.");
    if (!result.error) await refreshTelegramStatus();
  }, [refreshTelegramStatus]);

  const handleTelegramUsersSave = useCallback(async () => {
    const userIds = telegramUsers.split(",").map((value) => value.trim()).filter(Boolean);
    const result = await window.claude.telegram.setAllowedUsers(userIds);
    setTelegramMessage(result.error ?? "Allowed users saved.");
    if (!result.error) await refreshTelegramStatus();
  }, [refreshTelegramStatus, telegramUsers]);

  const handleTelegramInstructionsSave = useCallback(async () => {
    const result = await window.claude.telegram.setInstructions(telegramInstructions);
    setTelegramMessage(result.error ?? "Assistant identity saved.");
    if (!result.error) await refreshTelegramStatus();
  }, [refreshTelegramStatus, telegramInstructions]);

  return (
    <div className="flex h-full flex-col">
      <SettingsHeader title="General" description="Application-wide preferences" />

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 py-2">
          {/* ── Updates section ── */}
          <SettingsSection icon={Download} label="Updates" first>
            <SettingRow
              label="Include pre-release updates"
              description="Receive beta versions with the latest features. Disable to only get stable releases."
            >
              <Switch
                checked={allowPrerelease}
                onCheckedChange={handleTogglePrerelease}
              />
            </SettingRow>
          </SettingsSection>

          <SettingsSection icon={Languages} label="Language">
            <SettingRow
              label="Interface language"
              description="Choose the language used for Harnss interface labels and settings."
            >
              <SettingsSelect
                value={language}
                onValueChange={setLanguage}
                options={[
                  { value: "en", label: "English" },
                  { value: "zh", label: "Chinese" },
                ]}
              />
            </SettingRow>
          </SettingsSection>

          <SettingsSection icon={Radio} label="Remote Control">
            <SettingRow
              label="Enable remote control"
              description="Expose authenticated session control on localhost. Use the HTTPS Cloudflare Tunnel hint below for iPhone Safari."
            >
              <Switch checked={remoteEnabled} onCheckedChange={handleRemoteEnabledChange} />
            </SettingRow>
            {remoteEnabled && (
              <>
                <SettingRow label="Server port">
                  <SettingsSelect
                    value={String(remotePort)}
                    onValueChange={(value) => handleRemotePortChange(Number(value))}
                    options={[8787, 8788, 8790, 8989].map((port) => ({
                      value: String(port),
                      label: String(port),
                    }))}
                  />
                </SettingRow>
                <SettingRow
                  label="Pairing token"
                  description={t("Use Cloudflare Tunnel to access this securely: cloudflared tunnel --url http://127.0.0.1:{port}").replace("{port}", String(remotePort))}
                >
                  <div className="flex max-w-[15rem] items-center gap-2">
                    <code className="min-w-0 truncate text-[11px] text-muted-foreground">{remoteToken || "…"}</code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void window.claude.writeClipboardText(remoteToken)}
                      disabled={!remoteToken}
                    >
                      {t("Copy")}
                    </Button>
                  </div>
                </SettingRow>
              </>
            )}
          </SettingsSection>

          <SettingsSection icon={Send} label="Telegram">
            <SettingRow
              label="Enable Telegram"
              description="Connect a Telegram bot while Harnss is open. Private chats only; groups are disabled."
            >
              <Switch checked={telegramEnabled} onCheckedChange={handleTelegramEnabledChange} />
            </SettingRow>
            {telegramEnabled && (
              <>
                <SettingRow
                  label="Bot token"
                  description="Create a bot with @BotFather, then paste its token here. The token is stored encrypted."
                >
                  <div className="flex max-w-[20rem] items-center gap-2">
                    <Input
                      type="password"
                      value={telegramToken}
                      onChange={(event) => setTelegramToken(event.target.value)}
                      placeholder={telegramStatus?.configured ? "Token saved" : "123456:ABC…"}
                      className="h-8"
                    />
                    <Button size="sm" onClick={() => void handleTelegramTokenSave()} disabled={!telegramToken.trim()}>
                      Save
                    </Button>
                    {telegramStatus?.configured && (
                      <Button size="sm" variant="ghost" onClick={() => void handleTelegramTokenClear()}>
                        Clear
                      </Button>
                    )}
                  </div>
                </SettingRow>
                <SettingRow
                  label="Status"
                  description={telegramStatus?.botUsername ? `Connected as @${telegramStatus.botUsername}` : "Waiting for a valid bot token."}
                >
                  <span className="text-xs text-muted-foreground">
                    {telegramStatus?.running ? "Running" : telegramStatus?.configured ? "Stopped" : "Not configured"}
                  </span>
                </SettingRow>
                {telegramStatus?.configured && (
                  <>
                    <SettingRow
                      label="Pairing code"
                      description="Send /pair CODE to the bot from a private Telegram chat."
                    >
                      <code className="text-sm font-semibold tracking-widest">{telegramStatus.pairingCode}</code>
                    </SettingRow>
                    <SettingRow
                      label="Allowed user IDs"
                      description="Optional comma-separated Telegram user IDs. Pairing adds IDs automatically."
                    >
                      <div className="flex max-w-[20rem] items-center gap-2">
                        <Input
                          value={telegramUsers}
                          onChange={(event) => setTelegramUsers(event.target.value)}
                          placeholder="123456789, 987654321"
                          className="h-8"
                        />
                        <Button size="sm" variant="outline" onClick={() => void handleTelegramUsersSave()}>
                          Save
                        </Button>
                      </div>
                    </SettingRow>
                    <SettingRow
                      label="Assistant identity"
                      description="Instructions added to Telegram turns. The session still determines which engine, MCP servers, skills, and tools are available."
                    >
                      <div className="flex max-w-[24rem] flex-col items-end gap-2">
                        <textarea
                          value={telegramInstructions}
                          onChange={(event) => setTelegramInstructions(event.target.value)}
                          rows={4}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs"
                          placeholder="你是我们公司的 AI 助理……"
                        />
                        <Button size="sm" variant="outline" onClick={() => void handleTelegramInstructionsSave()}>
                          Save identity
                        </Button>
                      </div>
                    </SettingRow>
                  </>
                )}
                {telegramMessage && <p className="px-1 pb-2 text-xs text-muted-foreground">{telegramMessage}</p>}
              </>
            )}
          </SettingsSection>

          {/* ── Sidebar section ── */}
          <SettingsSection icon={MessageSquare} label="Sidebar">
            <SettingRow
              label="Recent chats per project"
              description="Number of chats shown by default in each project. Click 'Show more' in the sidebar to load additional chats."
            >
              <SettingsSelect
                value={String(chatLimit)}
                onValueChange={(v) => handleChatLimitChange(Number(v))}
                options={[5, 10, 15, 20, 25, 30, 50, 100].map((n) => ({ value: String(n), label: String(n) }))}
              />
            </SettingRow>
          </SettingsSection>

          {/* ── Editor section ── */}
          <SettingsSection icon={Code} label="Editor">
            <SettingRow
              label="Default editor"
              description="Choose which editor opens when you click 'Open in Editor'. Auto tries Cursor, VS Code, then Zed."
            >
              <SettingsSelect
                value={preferredEditor}
                onValueChange={handleEditorChange}
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "cursor", label: "Cursor" },
                  { value: "code", label: "VS Code" },
                  { value: "zed", label: "Zed" },
                ]}
              />
            </SettingRow>
          </SettingsSection>

          {/* ── Voice Dictation section ── */}
          <SettingsSection icon={Mic} label="Voice Dictation">
            <SettingRow
              label="Dictation mode"
              description="Native uses your OS dictation (macOS only). Whisper runs a local AI model for speech-to-text on all platforms (~40 MB download on first use)."
            >
              <SettingsSelect
                value={voiceDictation}
                onValueChange={handleVoiceDictationChange}
                options={[
                  { value: "native", label: "Native (OS)" },
                  { value: "whisper", label: "Whisper (Local AI)" },
                ]}
              />
            </SettingRow>
          </SettingsSection>

          {/* ── Realtime Voice section ── */}
          <SettingsSection icon={Radio} label={t("Realtime Voice")}>
            <SettingRow
              label={t("Enable realtime voice")}
              description={t("Enables the optional Mac desktop voice bridge. COVE web voice is managed by Remote Control. Dictation remains unchanged.")}
            >
              <Switch
                checked={realtimeVoice.enabled}
                onCheckedChange={(checked) => void updateRealtimeVoice({ enabled: checked })}
              />
            </SettingRow>
            {realtimeVoice.enabled && (
              <>
                <SettingRow
                  label={t("Status")}
                  description={t("This status is for the optional Mac desktop bridge. COVE web voice uses the phone microphone directly.")}
                >
                  <span className={`text-xs ${
                    realtimeStatus === "connected"
                      ? "text-emerald-500"
                      : realtimeStatus === "error"
                        ? "text-destructive"
                        : "text-muted-foreground"
                  }`}>
                    {realtimeStatus === "connected"
                      ? t("Connected")
                      : realtimeStatus === "starting"
                        ? t("Starting…")
                        : realtimeStatus === "error"
                          ? t("Error")
                          : t("Stopped")}
                  </span>
                </SettingRow>
                <SettingRow
                  label={t("Input device")}
                  description={t("Mac only: select iPhone Continuity Microphone after macOS exposes it, or leave system default.")}
                >
                  <SettingsSelect
                    value={realtimeVoice.inputDevice || "__system_default__"}
                    onValueChange={(value) => void updateRealtimeVoice({
                      inputDevice: value === "__system_default__" ? "" : value,
                    })}
                    options={[
                      { value: "__system_default__", label: t("System default") },
                      ...realtimeDevices
                        .filter((device) => device.maxInputChannels > 0)
                        .map((device) => ({ value: String(device.index), label: `${device.name} (#${device.index})` })),
                    ]}
                    className="max-w-[15rem]"
                  />
                </SettingRow>
                <SettingRow
                  label={t("Output device")}
                  description={t("Mac only: choose AirPods, Bluetooth, USB, or the system default output.")}
                >
                  <SettingsSelect
                    value={realtimeVoice.outputDevice || "__system_default__"}
                    onValueChange={(value) => void updateRealtimeVoice({
                      outputDevice: value === "__system_default__" ? "" : value,
                    })}
                    options={[
                      { value: "__system_default__", label: t("System default") },
                      ...realtimeDevices
                        .filter((device) => device.maxOutputChannels > 0)
                        .map((device) => ({ value: String(device.index), label: `${device.name} (#${device.index})` })),
                    ]}
                    className="max-w-[15rem]"
                  />
                </SettingRow>
                <SettingRow
                  label={t("Refresh audio devices")}
                  description={realtimeError || t("Refresh devices for the optional Mac bridge. COVE web voice does not need a Mac input device.")}
                >
                  <Button variant="outline" size="sm" onClick={() => void refreshRealtimeDevices()}>
                    {t("Refresh")}
                  </Button>
                </SettingRow>
                <SettingRow
                  label={t("COVE web voice")}
                  description={t("Enable Remote Control, open the authenticated Harnss Remote page through HTTPS, and choose COVE Voice. The COVE page uses the phone microphone directly.")}
                >
                  <span className="text-xs text-muted-foreground">{t("Open from Harnss Remote")}</span>
                </SettingRow>
                <SettingRow
                  label={t("Speech runtime endpoint")}
                  description={t("Keep the upstream speech runtime on localhost unless you add a separately authenticated gateway.")}
                >
                  <Input
                    value={realtimeVoice.endpoint}
                    onChange={(event) => setRealtimeVoice((current) => ({ ...current, endpoint: event.target.value }))}
                    onBlur={() => void updateRealtimeVoice({ endpoint: realtimeVoice.endpoint })}
                    className="h-8 w-[15rem] text-xs"
                  />
                </SettingRow>
                <SettingRow
                  label={t("Voice bridge directory")}
                  description={t("Optional. Defaults to the sibling harnss-voice-bridge project in development.")}
                >
                  <Input
                    value={realtimeVoice.bridgeDir}
                    onChange={(event) => setRealtimeVoice((current) => ({ ...current, bridgeDir: event.target.value }))}
                    onBlur={() => void updateRealtimeVoice({ bridgeDir: realtimeVoice.bridgeDir })}
                    placeholder="~/agents/harnss-voice-bridge"
                    className="h-8 w-[15rem] text-xs"
                  />
                </SettingRow>
                <SettingRow
                  label={t("Allow spoken Agent sends")}
                  description={t("Still requires the exact spoken confirmation phrase. Leave disabled for read-only voice control.")}
                >
                  <Switch
                    checked={realtimeVoice.allowSend}
                    onCheckedChange={(checked) => void updateRealtimeVoice({ allowSend: checked })}
                  />
                </SettingRow>
              </>
            )}
          </SettingsSection>
        </div>
      </ScrollArea>
    </div>
  );
});
