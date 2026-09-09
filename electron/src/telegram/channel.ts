import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { Bot, InlineKeyboard, type Context } from "grammy";
import { getAppSettings } from "../lib/app-settings";
import { getDataDir } from "../lib/data-dir";
import {
  getTelegramChannelState,
  DEFAULT_TELEGRAM_ASSISTANT_INSTRUCTIONS,
  newPairingCode,
  saveTelegramChannelState,
  type TelegramChannelState,
} from "../lib/telegram-secrets";
import type {
  RemoteImageAttachment,
  RemoteServerEvent,
  RemoteSessionSnapshot,
  RemoteSessionSummary,
} from "@shared/types/remote";
import type { TelegramStatus } from "@shared/types/telegram";
import type { RemoteControlBridge } from "../remote-control/bridge";
import {
  isValidTelegramBotToken,
  splitTelegramMessage,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from "./utils";
const STREAM_EDIT_INTERVAL_MS = 750;

type ApprovalAction = {
  chatId: number;
  sessionId: string;
  requestId: string;
  timer: ReturnType<typeof setTimeout>;
};

type Delivery = {
  messageId?: number;
  pending?: RemoteSessionSnapshot;
  timer?: ReturnType<typeof setTimeout>;
  lastTextHash?: string;
  terminalHash?: string;
  permissionRequestId?: string;
  latestRevision?: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  failures?: number;
};

function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === "private";
}

function userId(ctx: Context): string {
  return String(ctx.from?.id ?? "");
}

function displayName(session: RemoteSessionSummary): string {
  return session.title || session.projectName || session.id.slice(0, 8);
}

function messageText(snapshot: RemoteSessionSnapshot): string {
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (message.role === "assistant" && message.content.trim()) return message.content.trim();
  }
  return "";
}

function shortActionId(): string {
  return randomBytes(5).toString("hex");
}

export class TelegramChannel {
  private bot: Bot | null = null;
  private botUsername = "";
  private unsubscribeBridge: (() => void) | null = null;
  private state: TelegramChannelState = getTelegramChannelState();
  private readonly deliveries = new Map<string, Delivery>();
  private readonly approvalActions = new Map<string, ApprovalAction>();
  private readonly chatQueues = new Map<number, Promise<void>>();
  private readonly chatQueueDepth = new Map<number, number>();
  private readonly deliveryQueues = new Map<string, Promise<void>>();
  private reconfigurePromise: Promise<void> | null = null;
  private lifecycleGeneration = 0;
  private polling = false;

  constructor(
    private readonly bridge: RemoteControlBridge,
    private readonly getMainWindow?: () => BrowserWindow | null,
  ) {}

  async start(): Promise<void> {
    await this.reconfigure();
  }

  async stop(): Promise<void> {
    this.lifecycleGeneration += 1;
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = null;
    for (const delivery of this.deliveries.values()) {
      if (delivery.timer) clearTimeout(delivery.timer);
      if (delivery.cleanupTimer) clearTimeout(delivery.cleanupTimer);
    }
    for (const approval of this.approvalActions.values()) clearTimeout(approval.timer);
    this.deliveries.clear();
    this.approvalActions.clear();
    this.chatQueues.clear();
    this.chatQueueDepth.clear();
    this.deliveryQueues.clear();
    this.polling = false;
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }
    this.botUsername = "";
  }

  async reconfigure(): Promise<void> {
    if (this.reconfigurePromise) return this.reconfigurePromise;
    const operation = this.reconfigureInternal();
    this.reconfigurePromise = operation;
    try {
      await operation;
    } finally {
      if (this.reconfigurePromise === operation) this.reconfigurePromise = null;
    }
  }

  getStatus(): TelegramStatus {
    const settings = getAppSettings();
    return {
      enabled: settings.telegramEnabled,
      configured: !!this.state.botToken,
      running: this.polling,
      ...(this.botUsername ? { botUsername: this.botUsername } : {}),
      pairingCode: this.state.pairingCode,
      allowedUserIds: [...this.state.allowedUserIds],
      assistantInstructions: this.state.assistantInstructions,
      allowGroups: false,
    };
  }

  async setToken(token: string): Promise<void> {
    const normalized = token.trim();
    if (!isValidTelegramBotToken(normalized)) {
      throw new Error("Invalid Telegram Bot Token");
    }
    const changed = this.state.botToken !== normalized;
    this.state = saveTelegramChannelState({
      botToken: normalized,
      pairingCode: newPairingCode(),
      ...(changed ? { allowedUserIds: [], bindings: {}, chatUserIds: {} } : {}),
    });
    await this.reconfigure();
  }

  async clearToken(): Promise<void> {
    this.state = saveTelegramChannelState({
      botToken: "",
      pairingCode: newPairingCode(),
      allowedUserIds: [],
      bindings: {},
      chatUserIds: {},
    });
    await this.reconfigure();
  }

  setAllowedUserIds(userIds: string[]): void {
    const normalized = [...new Set(userIds.map((id) => id.trim()).filter((id) => /^\d+$/.test(id)))];
    const bindings = Object.fromEntries(
      Object.entries(this.state.bindings).filter(([chatId]) =>
        normalized.includes(this.state.chatUserIds[chatId] ?? "")),
    );
    const chatUserIds = Object.fromEntries(
      Object.entries(this.state.chatUserIds).filter(([chatId]) => bindings[chatId] !== undefined),
    );
    this.state = saveTelegramChannelState({ allowedUserIds: normalized, bindings, chatUserIds });
  }

  private async reconfigureInternal(): Promise<void> {
    await this.stop();
    this.state = getTelegramChannelState();
    const settings = getAppSettings();
    if (!settings.telegramEnabled || !this.state.botToken) return;

    const bot = new Bot(this.state.botToken);
    bot.catch((error) => {
      console.error("[telegram] update failed", error.error);
    });
    bot.command("start", (ctx) => this.handleStart(ctx));
    bot.command("pair", (ctx) => this.handlePair(ctx));
    bot.command("sessions", (ctx) => this.handleSessions(ctx));
    bot.command("whoami", (ctx) => this.handleWhoAmI(ctx));
    bot.command("use", (ctx) => this.handleUse(ctx));
    bot.command("new", (ctx) => this.handleNew(ctx));
    bot.command("model", (ctx) => this.handleModel(ctx));
    bot.command("stop", (ctx) => this.handleAction(ctx, "interrupt"));
    bot.command("retry", (ctx) => this.handleAction(ctx, "retry"));
    bot.command("help", (ctx) => this.handleHelp(ctx));
    bot.on("callback_query:data", (ctx) => this.handleCallback(ctx));
    bot.on("message:text", (ctx) => this.handleMessage(ctx));
    bot.on("message:photo", (ctx) => this.handlePhoto(ctx));
    bot.on("message:document", (ctx) => this.handleDocument(ctx));
    bot.on("message:voice", (ctx) => this.handleVoice(ctx));

    await bot.init();
    this.bot = bot;
    this.botUsername = bot.botInfo.username;
    // Telegram clients only render the "/" command menu when the bot has
    // registered it via setMyCommands — without registration the commands
    // still work but are completely undiscoverable in the chat UI.
    try {
      await bot.api.setMyCommands([
        { command: "sessions", description: "列出会话并选择绑定的会话" },
        { command: "whoami", description: "查看当前绑定的会话" },
        { command: "model", description: "查看/切换当前会话的模型" },
        { command: "new", description: "新建会话" },
        { command: "stop", description: "停止当前会话运行" },
        { command: "retry", description: "重试上一条消息" },
        { command: "help", description: "全部命令说明" },
      ]);
    } catch (error) {
      console.warn("[telegram] setMyCommands failed", error);
    }
    this.unsubscribeBridge = this.bridge.onEvent((event) => this.handleBridgeEvent(event));
    void bot.start({
      onStart: () => {
        console.info(`[telegram] polling as @${this.botUsername}`);
      },
    }).catch((error) => {
      if (this.bot !== bot) return;
      this.bot = null;
      this.botUsername = "";
      this.polling = false;
      console.error("[telegram] polling stopped", error);
    });
    this.polling = true;
  }

  private isAllowed(ctx: Context): boolean {
    return isPrivateChat(ctx) && !!ctx.from && this.state.allowedUserIds.includes(userId(ctx));
  }

  private async handleStart(ctx: Context): Promise<void> {
    if (!isPrivateChat(ctx)) {
      await ctx.reply("Telegram groups are disabled for this channel.");
      return;
    }
    if (!this.isAllowed(ctx)) {
      await ctx.reply("This bot is not paired yet. Use /pair CODE from Harnss Settings → General → Telegram.");
      return;
    }
    await ctx.reply("Harnss Telegram is connected. Use /sessions to choose a session.");
  }

  private async handlePair(ctx: Context): Promise<void> {
    if (!isPrivateChat(ctx) || !ctx.from) return;
    const supplied = ctx.match?.toString().trim().toUpperCase();
    if (!supplied || supplied !== this.state.pairingCode) {
      await ctx.reply("Pairing code rejected.");
      return;
    }
    await this.pairUser(ctx);
  }

  private async pairUser(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    this.state = saveTelegramChannelState({
      allowedUserIds: [...new Set([...this.state.allowedUserIds, userId(ctx)])],
      pairingCode: newPairingCode(),
    });
    await ctx.reply("Paired successfully. Use /sessions to choose a Harnss session.");
  }

  private async handleSessions(ctx: Context): Promise<void> {
    if (!this.requireAllowed(ctx)) return;
    const sessions = await this.listSessions();
    if (!sessions.length) {
      await ctx.reply("No Harnss sessions are available.");
      return;
    }
    const keyboard = new InlineKeyboard();
    for (const session of sessions.slice(0, 30)) {
      keyboard.text(displayName(session).slice(0, 50), `use:${session.id}`).row();
    }
    await ctx.reply("Choose a Harnss session:", { reply_markup: keyboard });
  }

  private async handleWhoAmI(ctx: Context): Promise<void> {
    if (!this.requireAllowed(ctx)) return;
    const sessionId = this.getBoundSessionId(ctx.chat!.id);
    if (!sessionId) {
      await ctx.reply("当前还没有选择 session，请先使用 /sessions。");
      return;
    }
    const session = (await this.listSessions()).find((entry) => entry.id === sessionId);
    if (!session) {
      await ctx.reply("当前绑定的 session 已不存在，请重新使用 /sessions。");
      return;
    }
    await ctx.reply([
      `Session: ${displayName(session)}`,
      `Engine: ${session.engine ?? "claude"}`,
      `Agent: ${session.agentId ?? "claude-code"}`,
      `Project: ${session.projectName ?? session.projectId}`,
      "",
      "当前 Telegram 消息会进入这个 Harnss session。它可以使用该 session 已配置的 MCP、skills 和工具。",
    ].join("\n"));
  }

  private async handleUse(ctx: Context): Promise<void> {
    if (!this.requireAllowed(ctx)) return;
    const sessionId = ctx.match?.toString().trim();
    if (!sessionId) {
      await ctx.reply("Usage: /use SESSION_ID");
      return;
    }
    const sessions = await this.listSessions();
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      await ctx.reply("Session not found. Use /sessions to refresh the list.");
      return;
    }
    this.bindChat(ctx.chat!.id, session.id, userId(ctx));
    await ctx.reply(`Active session: ${displayName(session)}`);
  }

  private async handleNew(ctx: Context): Promise<void> {
    if (!this.requireAllowed(ctx)) return;
    const chatId = ctx.chat!.id;
    const boundId = this.getBoundSessionId(chatId);
    const sessions = await this.listSessions();
    const bound = sessions.find((session) => session.id === boundId);
    const args = ctx.match?.toString().trim().split(/\s+/).filter(Boolean) ?? [];
    const projectId = args[0] || bound?.projectId;
    const engine = args[1] === "acp" || args[1] === "codex" || args[1] === "claude" ? args[1] : undefined;
    const agentId = args[2];
    if (!projectId) {
      await ctx.reply("Choose an existing session first, then use /new. You can also pass: /new PROJECT_ID [claude|codex|acp] [AGENT_ID]");
      return;
    }
    try {
      const existingIds = new Set(sessions.map((session) => session.id));
      await this.bridge.request("sessions.create", {
        projectId,
        ...(engine ? { engine } : {}),
        ...(agentId ? { agentId } : {}),
      });
      const newest = await this.waitForCreatedSession(projectId, existingIds);
      if (newest) {
        this.bindChat(chatId, newest.id, userId(ctx));
        await ctx.reply(`New session created: ${displayName(newest)}`);
      } else {
        await ctx.reply("New session created. Use /sessions to select it.");
      }
    } catch (error) {
      await ctx.reply(`Could not create session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleHelp(ctx: Context): Promise<void> {
    if (!this.requireAllowed(ctx)) return;
    await ctx.reply([
      "可用命令：",
      "/sessions — 列出会话并选择绑定",
      "/use <会话ID> — 绑定指定会话",
      "/whoami — 查看当前绑定的会话",
      "/model — 查看当前模型与可选项（点按钮切换）",
      "/model <模型名> — 直接切换模型（支持部分匹配）",
      "/new [项目ID] [claude|codex|acp] — 新建会话",
      "/stop — 停止当前会话运行",
      "/retry — 重试上一条消息",
      "",
      "直接发送文字/图片/文件/语音 = 发给当前绑定的会话。",
    ].join("\n"));
  }

  private async handleModel(ctx: Context): Promise<void> {
    if (!this.requireAllowed(ctx)) return;
    const sessionId = this.getBoundSessionId(ctx.chat!.id);
    if (!sessionId) {
      await ctx.reply("Choose a session first with /sessions.");
      return;
    }
    const session = (await this.listSessions()).find((entry) => entry.id === sessionId);
    if (!session) {
      await ctx.reply("当前绑定的 session 已不存在，请重新使用 /sessions。");
      return;
    }
    const requested = ctx.match?.toString().trim();
    if (!requested) {
      const models = session.availableModels ?? [];
      const lines = [
        `Session: ${displayName(session)}`,
        `当前模型: ${session.model || "(引擎默认)"}`,
        session.effort ? `推理力度: ${session.effort}` : "",
      ].filter(Boolean);
      if (!models.length) {
        await ctx.reply([
          ...lines,
          "",
          "该会话未上报可选模型清单，可尝试 /model <模型名> 直接设置。",
        ].join("\n"));
        return;
      }
      const keyboard = new InlineKeyboard();
      for (const model of models.slice(0, 30)) {
        const current = session.model
          ? model.value === session.model
          : model.isDefault === true;
        keyboard.text(`${current ? "✓ " : ""}${model.displayName}`.slice(0, 60), `model:${session.id}:${model.value}`).row();
      }
      await ctx.reply(lines.join("\n"), { reply_markup: keyboard });
      return;
    }
    const models = session.availableModels ?? [];
    const lowered = requested.toLowerCase();
    const matched = models.find((model) => model.value === requested)
      ?? models.find((model) => model.displayName.toLowerCase() === lowered)
      ?? models.find((model) => model.value.toLowerCase().includes(lowered))
      ?? models.find((model) => model.displayName.toLowerCase().includes(lowered));
    const modelValue = matched?.value ?? requested;
    try {
      await this.bridge.request("sessions.update-settings", { sessionId, model: modelValue });
      await ctx.reply(`模型切换请求已发送：${matched ? `${matched.displayName} (${matched.value})` : modelValue}`);
    } catch (error) {
      await ctx.reply(`切换模型失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleAction(ctx: Context, action: "interrupt" | "retry"): Promise<void> {
    if (!this.requireAllowed(ctx)) return;
    const sessionId = this.getBoundSessionId(ctx.chat!.id);
    if (!sessionId) {
      await ctx.reply("Choose a session first with /sessions.");
      return;
    }
    await this.bridge.request("sessions.action", { sessionId, action });
    await ctx.reply(action === "interrupt" ? "Stop requested." : "Retry requested.");
  }

  private async handleMessage(ctx: Context): Promise<void> {
    const incomingText = ctx.message?.text;
    if (isPrivateChat(ctx) && ctx.from && incomingText?.trim().toUpperCase() === this.state.pairingCode) {
      await this.pairUser(ctx);
      return;
    }
    if (!this.requireAllowed(ctx)) return;
    if (incomingText) await this.sendTelegramText(ctx, incomingText);
  }

  private async handlePhoto(ctx: Context): Promise<void> {
    if (!this.requireAllowed(ctx)) return;
    const photo = ctx.message?.photo?.at(-1);
    if (!photo) return;
    try {
      const media = await this.downloadTelegramFile(photo.file_id, "telegram-photo.jpg", "image/jpeg");
      await this.sendTelegramText(ctx, "请分析我发送的图片，并结合上下文完成任务。", [{
        id: `telegram-${photo.file_unique_id}`,
        data: media.data,
        mediaType: "image/jpeg",
        fileName: "telegram-photo.jpg",
      }]);
    } catch (error) {
      await ctx.reply(`图片处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleDocument(ctx: Context): Promise<void> {
    if (!this.requireAllowed(ctx)) return;
    const document = ctx.message?.document;
    if (!document) return;
    try {
      const fileName = safeTelegramFileName(document.file_name || "telegram-file");
      const media = await this.downloadTelegramFile(
        document.file_id,
        fileName,
        document.mime_type || "application/octet-stream",
      );
      const imageType = toImageMediaType(document.mime_type);
      if (imageType) {
        await this.sendTelegramText(ctx, "请分析我发送的图片，并结合上下文完成任务。", [{
          id: `telegram-${document.file_unique_id}`,
          data: media.data,
          mediaType: imageType,
          fileName,
        }]);
      } else {
        await this.sendTelegramText(
          ctx,
          `请处理用户发送的文件：${fileName}。文件已保存到以下路径，请使用可用工具读取或分析它：${media.path}`,
        );
      }
    } catch (error) {
      await ctx.reply(`文件处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleVoice(ctx: Context): Promise<void> {
    if (!this.requireAllowed(ctx)) return;
    const voice = ctx.message?.voice;
    if (!voice) return;
    try {
      const media = await this.downloadTelegramFile(voice.file_id, `telegram-voice-${voice.file_unique_id}.ogg`, "audio/ogg");
      const mainWindow = this.getMainWindow?.();
      if (mainWindow && !mainWindow.isDestroyed()) {
        await this.bot?.api.sendMessage(ctx.chat!.id, "正在转写语音，请稍候…");
        mainWindow.webContents.send("telegram:voice", {
          chatId: ctx.chat!.id,
          mediaPath: media.path,
          mimeType: media.mimeType,
        });
      } else {
        await this.sendTelegramText(ctx, `用户发送了一段语音。请先尝试使用可用工具转录并理解它，再完成用户请求。语音文件路径：${media.path}`);
      }
    } catch (error) {
      await ctx.reply(`语音处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async sendVoiceTranscription(chatId: number, text: string): Promise<void> {
    const telegramUserId = this.state.chatUserIds[String(chatId)];
    if (!telegramUserId || !this.state.allowedUserIds.includes(telegramUserId)) {
      throw new Error("Telegram chat is not paired");
    }
    const sessionId = this.getBoundSessionId(chatId);
    if (!sessionId) throw new Error("Choose a session first with /sessions.");
    const bot = this.bot;
    if (!bot) throw new Error("Telegram bot is not running");
    await this.enqueue(chatId, async () => {
      const status = await bot.api.sendMessage(chatId, "Transcribing voice…");
      const key = this.deliveryKey(chatId, sessionId);
      const delivery = this.deliveries.get(key) ?? {};
      delivery.messageId = status.message_id;
      delivery.lastTextHash = hashText("Transcribing voice…");
      delivery.terminalHash = undefined;
      this.deliveries.set(key, delivery);
      await this.bridge.request("sessions.send", {
        sessionId,
        text: this.buildAssistantPrompt(text),
      });
    });
  }

  async notifyChat(chatId: number, text: string): Promise<void> {
    const telegramUserId = this.state.chatUserIds[String(chatId)];
    if (!telegramUserId || !this.state.allowedUserIds.includes(telegramUserId)) {
      throw new Error("Telegram chat is not paired");
    }
    if (!this.bot) throw new Error("Telegram bot is not running");
    await this.bot.api.sendMessage(chatId, text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH));
  }

  async readMedia(mediaPath: string): Promise<{ data: string; mimeType: string }> {
    const root = path.resolve(getDataDir(), "telegram-media");
    const resolved = path.resolve(mediaPath);
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Invalid Telegram media path");
    const data = await fs.readFile(resolved);
    return { data: data.toString("base64"), mimeType: "audio/ogg" };
  }

  private async sendTelegramText(
    ctx: Context,
    text: string,
    images?: RemoteImageAttachment[],
  ): Promise<void> {
    const sessionId = this.getBoundSessionId(ctx.chat!.id);
    if (!sessionId) {
      await ctx.reply("Choose a session first with /sessions.");
      return;
    }
    try {
      await this.enqueue(ctx.chat!.id, async () => {
        const deliveryKey = this.deliveryKey(ctx.chat!.id, sessionId);
        const delivery = this.deliveries.get(deliveryKey) ?? {};
        const status = await ctx.reply("Working…");
        delivery.messageId = status.message_id;
        delivery.lastTextHash = hashText("Working…");
        delivery.terminalHash = undefined;
        this.deliveries.set(deliveryKey, delivery);
        try {
          await this.bridge.request("sessions.send", {
            sessionId,
            text: this.buildAssistantPrompt(text),
            ...(images?.length ? { images } : {}),
          });
        } catch (error) {
          await this.editDelivery(ctx.chat!.id, deliveryKey, `Send failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : String(error));
    }
  }

  private async downloadTelegramFile(
    fileId: string,
    fileName: string,
    mimeType: string,
  ): Promise<{ data: string; path: string; mimeType: string }> {
    const bot = this.bot;
    if (!bot) throw new Error("Telegram bot is not running");
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) throw new Error("Telegram did not return a file path");
    const response = await fetch(`https://api.telegram.org/file/bot${this.state.botToken}/${file.file_path}`);
    if (!response.ok) throw new Error(`Telegram file download failed (${response.status})`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 20 * 1024 * 1024) throw new Error("Telegram file exceeds the 20 MB limit");
    const directory = path.join(getDataDir(), "telegram-media");
    await fs.mkdir(directory, { recursive: true });
    const savedPath = path.join(directory, `${Date.now()}-${randomBytes(6).toString("hex")}-${fileName}`);
    await fs.writeFile(savedPath, buffer, { mode: 0o600 });
    setTimeout(() => {
      void fs.unlink(savedPath).catch(() => undefined);
    }, 24 * 60 * 60 * 1000).unref();
    return { data: buffer.toString("base64"), path: savedPath, mimeType };
  }

  private buildAssistantPrompt(text: string): string {
    const instructions = this.state.assistantInstructions.trim()
      || DEFAULT_TELEGRAM_ASSISTANT_INSTRUCTIONS;
    return `<telegram-channel-instructions>\n${instructions}\n</telegram-channel-instructions>\n\n${text}`;
  }

  setAssistantInstructions(instructions: string): void {
    this.state = saveTelegramChannelState({
      assistantInstructions: instructions.trim() || DEFAULT_TELEGRAM_ASSISTANT_INSTRUCTIONS,
    });
  }

  private async handleCallback(ctx: Context): Promise<void> {
    if (!this.requireAllowed(ctx)) {
      await ctx.answerCallbackQuery({ text: "Pair this chat first." });
      return;
    }
    const data = ctx.callbackQuery?.data;
    if (!data || !ctx.chat) {
      await ctx.answerCallbackQuery({ text: "This action is unavailable." });
      return;
    }
    if (data.startsWith("use:")) {
      const sessionId = data.slice(4);
      const sessions = await this.listSessions();
      if (!sessions.some((session) => session.id === sessionId)) {
        await ctx.answerCallbackQuery({ text: "Session no longer exists." });
        return;
      }
      this.bindChat(ctx.chat.id, sessionId, userId(ctx));
      await ctx.answerCallbackQuery({ text: "Session selected" });
      await ctx.editMessageText(`Active session selected: ${sessionId}`);
      return;
    }
    if (data.startsWith("model:")) {
      // model:<sessionId>:<modelValue> — model values may themselves contain
      // ":", so split on the first separator after the prefix only.
      const separator = data.indexOf(":", 6);
      const sessionId = separator > 0 ? data.slice(6, separator) : "";
      const modelValue = separator > 0 ? data.slice(separator + 1) : "";
      if (!sessionId || !modelValue) {
        await ctx.answerCallbackQuery({ text: "Invalid model selection." });
        return;
      }
      try {
        await this.bridge.request("sessions.update-settings", { sessionId, model: modelValue });
        await ctx.answerCallbackQuery({ text: `模型已切换：${modelValue}` });
        await ctx.editMessageText(`Model switched: ${modelValue}`);
      } catch (error) {
        await ctx.answerCallbackQuery({
          text: `切换失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 190),
        });
      }
      return;
    }
    if (!data.startsWith("approval:")) return;
    const [, actionId, behavior] = data.split(":");
    const approval = this.approvalActions.get(actionId);
    if (!approval) {
      await ctx.answerCallbackQuery({ text: "This approval has expired." });
      return;
    }
    if (approval.chatId !== ctx.chat.id) {
      await ctx.answerCallbackQuery({ text: "This approval belongs to another chat." });
      return;
    }
    if (behavior !== "allow" && behavior !== "allowForSession" && behavior !== "deny") {
      await ctx.answerCallbackQuery({ text: "Invalid approval action." });
      return;
    }
    const snapshot = await this.bridge.request("sessions.get", { sessionId: approval.sessionId }) as RemoteSessionSnapshot;
    if (snapshot.pendingPermission?.requestId !== approval.requestId) {
      clearTimeout(approval.timer);
      this.approvalActions.delete(actionId);
      await ctx.answerCallbackQuery({ text: "This approval has expired." });
      return;
    }
    await this.bridge.request("sessions.approve", {
      sessionId: approval.sessionId,
      requestId: approval.requestId,
      behavior,
    });
    clearTimeout(approval.timer);
    this.approvalActions.delete(actionId);
    await ctx.answerCallbackQuery({ text: "Response sent" });
    await ctx.editMessageText(`Permission response sent: ${behavior}`);
  }

  private requireAllowed(ctx: Context): boolean {
    if (this.isAllowed(ctx)) return true;
    void ctx.reply("This chat is not paired. Use /pair CODE from Harnss Settings → General → Telegram.");
    return false;
  }

  private async listSessions(): Promise<RemoteSessionSummary[]> {
    return await this.bridge.request("sessions.list") as RemoteSessionSummary[];
  }

  private async waitForCreatedSession(
    projectId: string,
    existingIds: Set<string>,
  ): Promise<RemoteSessionSummary | undefined> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const sessions = await this.listSessions();
      const created = sessions
        .filter((session) => session.projectId === projectId && !existingIds.has(session.id))
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (created) return created;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return undefined;
  }

  private getBoundSessionId(chatId: number): string | undefined {
    return this.state.bindings[String(chatId)];
  }

  private deliveryKey(chatId: number, sessionId: string): string {
    return `${chatId}:${sessionId}`;
  }

  private handleBridgeEvent(event: RemoteServerEvent): void {
    if (event.type !== "session.updated") return;
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
    const snapshot = event.snapshot as RemoteSessionSnapshot | undefined;
    if (!sessionId || !snapshot || !this.bot) return;
    for (const [chatId, boundSessionId] of Object.entries(this.state.bindings)) {
      if (boundSessionId !== sessionId) continue;
      if (!this.state.allowedUserIds.includes(this.state.chatUserIds[chatId] ?? "")) continue;
      this.queueDelivery(Number(chatId), snapshot);
    }
  }

  private queueDelivery(chatId: number, snapshot: RemoteSessionSnapshot): void {
    const key = this.deliveryKey(chatId, snapshot.session.id);
    const delivery = this.deliveries.get(key) ?? {};
    if (snapshot.revision !== undefined
      && delivery.latestRevision !== undefined
      && snapshot.revision <= delivery.latestRevision) {
      return;
    }
    delivery.latestRevision = snapshot.revision;
    delivery.pending = snapshot;
    if (delivery.timer) return;
    // Exponential backoff while Telegram is unreachable: without this, a
    // proxy outage during a streaming session failed one send per snapshot
    // tick, each rejection was autocaptured by PostHog, and the resulting
    // error storm flooded stdout (and preceded every renderer SIGTRAP).
    const backoff = Math.min(1000 * 2 ** Math.min(delivery.failures ?? 0, 5), 30_000);
    const delay = (snapshot.isProcessing ? STREAM_EDIT_INTERVAL_MS : 0) + backoff;
    delivery.timer = setTimeout(() => {
      delivery.timer = undefined;
      const pending = delivery.pending;
      delivery.pending = undefined;
      if (pending) {
        const generation = this.lifecycleGeneration;
        const previous = this.deliveryQueues.get(key) ?? Promise.resolve();
        const next = previous
          .catch(() => undefined)
          .then(() => this.deliverSnapshot(chatId, pending, generation))
          .then(() => { delivery.failures = 0; })
          .catch((error) => {
            delivery.failures = (delivery.failures ?? 0) + 1;
            console.warn("[telegram] delivery failed", error);
          });
        this.deliveryQueues.set(key, next);
        void next.finally(() => {
          if (this.deliveryQueues.get(key) === next) this.deliveryQueues.delete(key);
        });
      }
    }, delay);
    this.deliveries.set(key, delivery);
  }

  private async deliverSnapshot(chatId: number, snapshot: RemoteSessionSnapshot, generation: number): Promise<void> {
    const bot = this.bot;
    if (!bot || generation !== this.lifecycleGeneration) return;
    const key = this.deliveryKey(chatId, snapshot.session.id);
    const delivery = this.deliveries.get(key) ?? {};
    const text = messageText(snapshot) || (snapshot.isProcessing ? "Working…" : "Agent finished without a text reply.");
    const chunks = splitTelegramMessage(text);
    const textHash = hashText(text);
    if (!snapshot.isProcessing && delivery.terminalHash === textHash) return;
    if (delivery.messageId) {
      await this.editDelivery(chatId, key, text, bot, generation);
    } else {
      const sent = await bot.api.sendMessage(chatId, chunks[0]);
      if (generation !== this.lifecycleGeneration) return;
      delivery.messageId = sent.message_id;
      delivery.lastTextHash = textHash;
      this.deliveries.set(key, delivery);
    }
    if (!snapshot.isProcessing) {
      for (const chunk of chunks.slice(1)) {
        if (generation !== this.lifecycleGeneration) return;
        await bot.api.sendMessage(chatId, chunk);
      }
      if (generation !== this.lifecycleGeneration) return;
      delivery.terminalHash = textHash;
      delivery.cleanupTimer = setTimeout(() => {
        if (this.deliveries.get(key) === delivery) this.deliveries.delete(key);
      }, 10 * 60 * 1000);
    }
    if (snapshot.pendingPermission && delivery.permissionRequestId !== snapshot.pendingPermission.requestId) {
      const actionId = shortActionId();
      this.approvalActions.set(actionId, {
        chatId,
        sessionId: snapshot.session.id,
        requestId: snapshot.pendingPermission.requestId,
        timer: setTimeout(() => this.approvalActions.delete(actionId), 10 * 60 * 1000),
      });
      const keyboard = new InlineKeyboard()
        .text("Allow", `approval:${actionId}:allow`)
        .text("Allow session", `approval:${actionId}:allowForSession`)
        .text("Deny", `approval:${actionId}:deny`);
      await bot.api.sendMessage(
        chatId,
        `Permission required${snapshot.pendingPermission.toolName ? `: ${snapshot.pendingPermission.toolName}` : ""}\n${snapshot.pendingPermission.summary ?? ""}`,
        { reply_markup: keyboard },
      );
      delivery.permissionRequestId = snapshot.pendingPermission.requestId;
      this.deliveries.set(key, delivery);
    }
  }

  private async enqueue(chatId: number, task: () => Promise<void>): Promise<void> {
    const depth = this.chatQueueDepth.get(chatId) ?? 0;
    if (depth >= 5) throw new Error("Too many messages queued. Please wait for the current request.");
    this.chatQueueDepth.set(chatId, depth + 1);
    const previous = this.chatQueues.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.chatQueues.set(chatId, next);
    try {
      await next;
    } finally {
      const nextDepth = (this.chatQueueDepth.get(chatId) ?? 1) - 1;
      if (nextDepth > 0) this.chatQueueDepth.set(chatId, nextDepth);
      else this.chatQueueDepth.delete(chatId);
      if (this.chatQueues.get(chatId) === next) this.chatQueues.delete(chatId);
    }
  }

  private async editDelivery(
    chatId: number,
    key: string,
    text: string,
    bot?: Bot,
    generation = this.lifecycleGeneration,
  ): Promise<void> {
    const activeBot = bot ?? this.bot;
    if (!activeBot || generation !== this.lifecycleGeneration) return;
    const delivery = this.deliveries.get(key);
    const textHash = hashText(text);
    if (!delivery?.messageId || delivery.lastTextHash === textHash) return;
    try {
      await activeBot.api.editMessageText(chatId, delivery.messageId, text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH));
      if (generation !== this.lifecycleGeneration) return;
      delivery.lastTextHash = textHash;
    } catch (error) {
      console.warn("[telegram] message edit failed", error);
    }
  }

  private bindChat(chatId: number, sessionId: string, telegramUserId: string): void {
    this.state = saveTelegramChannelState({
      bindings: { ...this.state.bindings, [String(chatId)]: sessionId },
      chatUserIds: { ...this.state.chatUserIds, [String(chatId)]: telegramUserId },
    });
  }
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function safeTelegramFileName(fileName: string): string {
  const normalized = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
  return normalized || "telegram-file";
}

function toImageMediaType(
  mimeType: string | undefined,
): RemoteImageAttachment["mediaType"] | undefined {
  if (mimeType === "image/png"
    || mimeType === "image/jpeg"
    || mimeType === "image/gif"
    || mimeType === "image/webp") {
    return mimeType;
  }
  return undefined;
}
