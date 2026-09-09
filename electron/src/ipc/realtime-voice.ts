import { execFile, spawn, type ChildProcessWithoutNullStreams } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import net from "net";
import { promisify } from "util";
import { app, ipcMain, type BrowserWindow } from "electron";
import { getAppSettings } from "../lib/app-settings";
import { log } from "../lib/logger";
import { reportError } from "../lib/error-utils";
import { safeSend } from "../lib/safe-send";
import type { RealtimeVoiceSettings, RealtimeVoiceStatus } from "@shared/types/settings";

const execFileAsync = promisify(execFile);
const DEFAULT_GATEWAY_PORT = 8766;

export interface RealtimeVoiceState {
  status: RealtimeVoiceStatus;
  error?: string;
  pid?: number;
}

export interface RealtimeAudioDevice {
  index: number;
  name: string;
  maxInputChannels: number;
  maxOutputChannels: number;
}

type VoiceProcess = ChildProcessWithoutNullStreams;

function bridgeDirFor(settings: RealtimeVoiceSettings): string {
  const configured = settings.bridgeDir.trim();
  const expanded = configured.startsWith("~/")
    ? path.join(os.homedir(), configured.slice(2))
    : configured;
  return expanded
    || process.env.HARNSS_VOICE_BRIDGE_DIR?.trim()
    || path.resolve(app.getAppPath(), "../harnss-voice-bridge");
}

function resolveBridgeCommand(settings: RealtimeVoiceSettings): {
  command: string;
  prefixArgs: string[];
  cwd: string;
} {
  const cwd = bridgeDirFor(settings);
  const venvPython = path.join(cwd, ".venv", "bin", "python");
  const venvCli = path.join(cwd, ".venv", "bin", "harnss-voice-bridge");
  if (fs.existsSync(venvCli)) return { command: venvCli, prefixArgs: [], cwd };
  if (fs.existsSync(venvPython)) {
    return { command: venvPython, prefixArgs: ["-m", "harnss_voice_bridge"], cwd };
  }
  return { command: "harnss-voice-bridge", prefixArgs: [], cwd };
}

function deviceArg(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseDeviceLine(line: string): RealtimeAudioDevice | null {
  const match = line.trim().match(/^(\d+)\s+\|\s+(.*?)\s+\|\s+in=(\d+)\s+out=(\d+)$/);
  if (!match) return null;
  return {
    index: Number(match[1]),
    name: match[2],
    maxInputChannels: Number(match[3]),
    maxOutputChannels: Number(match[4]),
  };
}

function safeVoiceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:authorization|token|api[_-]?key|secret)[^,\s]*/gi, "[redacted]").slice(0, 500);
}

class RealtimeVoiceManager {
  private bridgeProcess: VoiceProcess | null = null;
  private gatewayProcess: VoiceProcess | null = null;
  private gatewayOwned = false;
  private gatewayStart: Promise<void> | null = null;
  private state: RealtimeVoiceState = { status: "stopped" };

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

  register(): void {
    ipcMain.handle("realtime-voice:get-state", () => this.state);
    ipcMain.handle("realtime-voice:list-devices", () => this.listDevices());
    ipcMain.handle("realtime-voice:start", () => this.start());
    ipcMain.handle("realtime-voice:stop", () => this.stop());
  }

  getState(): RealtimeVoiceState {
    return this.state;
  }

  async start(): Promise<RealtimeVoiceState> {
    if (this.bridgeProcess) return this.state;
    const settings = getAppSettings().realtimeVoice;
    if (!settings.enabled) {
      return this.updateState({ status: "error", error: "Enable Realtime Voice in Settings first." });
    }
    if (!getAppSettings().remoteEnabled) {
      return this.updateState({ status: "error", error: "Enable Remote Control first; the voice bridge uses its authenticated localhost API." });
    }

    const resolved = resolveBridgeCommand(settings);
    const args = [...resolved.prefixArgs, "voice", "--endpoint", settings.endpoint];
    const inputDevice = deviceArg(settings.inputDevice);
    const outputDevice = deviceArg(settings.outputDevice);
    if (inputDevice) args.push("--input-device", inputDevice);
    if (outputDevice) args.push("--output-device", outputDevice);
    if (settings.allowSend) args.push("--allow-send");

    this.updateState({ status: "starting" });
    try {
      if (!inputDevice) {
        const devices = await this.listDevices();
        if (!devices.devices?.some((device) => device.maxInputChannels > 0)) {
          return this.updateState({
            status: "error",
            error: "No Mac microphone is visible to PortAudio. Select iPhone Continuity Microphone after macOS exposes it, or use the iPhone Harnss Remote page for direct iPhone microphone access.",
          });
        }
      }
      if (!(await isWebSocketEndpointReachable(settings.endpoint))) {
        return this.updateState({
          status: "error",
          error: `Speech runtime is not reachable at ${displayEndpoint(settings.endpoint)}. Start the local speech runtime first, then try again.`,
        });
      }
      await this.ensureGateway();

      const child = spawn(resolved.command, args, {
        cwd: resolved.cwd,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.bridgeProcess = child;
      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (!text) return;
        if (text.includes("voice bridge connected")) {
          this.updateState({ status: "connected", pid: child.pid });
        }
        log("REALTIME_VOICE", text);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text) log("REALTIME_VOICE_ERR", text);
      });
      child.once("error", (error) => {
        this.bridgeProcess = null;
        this.updateState({ status: "error", error: safeVoiceError(error) });
      });
      child.once("exit", (code, signal) => {
        if (this.bridgeProcess !== child) return;
        this.bridgeProcess = null;
        if (this.state.status !== "error" && code !== 0 && signal !== "SIGTERM") {
          this.updateState({
            status: "error",
            error: `Voice bridge exited (${signal ?? `code ${code}`}). Check the bridge and speech runtime logs.`,
          });
        } else {
          this.updateState({ status: "stopped" });
        }
      });
      return this.state;
    } catch (error) {
      this.bridgeProcess = null;
      return this.updateState({ status: "error", error: safeVoiceError(error) });
    }
  }

  async stop(): Promise<RealtimeVoiceState> {
    const child = this.bridgeProcess;
    if (!child) {
      return this.updateState({ status: "stopped" });
    }
    this.bridgeProcess = null;
    let exited = false;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
        resolve();
      }, 1500);
      child.once("exit", () => {
        exited = true;
        clearTimeout(timer);
        resolve();
      });
    });
    return this.updateState({ status: "stopped" });
  }

  async dispose(): Promise<void> {
    await this.stopAll();
  }

  async reconfigure(): Promise<void> {
    await this.stop();
    await this.stopGateway();
    if (getAppSettings().realtimeVoice.enabled) await this.ensureGateway();
  }

  async ensureGateway(): Promise<void> {
    if (this.gatewayProcess || this.gatewayStart) {
      if (this.gatewayStart) await this.gatewayStart;
      return;
    }
    if (!getAppSettings().remoteEnabled) return;
    const settings = getAppSettings().realtimeVoice;
    const port = settings.gatewayPort || DEFAULT_GATEWAY_PORT;
    this.gatewayStart = this.startGateway(settings, port);
    try {
      await this.gatewayStart;
    } finally {
      this.gatewayStart = null;
    }
  }

  private async startGateway(
    settings: RealtimeVoiceSettings,
    port: number,
  ): Promise<void> {
    if (await isTcpPortOpen("127.0.0.1", port)) {
      this.gatewayOwned = false;
      log("REALTIME_GATEWAY", `reusing existing gateway on 127.0.0.1:${port}`);
      return;
    }

    const resolved = resolveBridgeCommand(settings);
    const gatewayArgs = [
      ...resolved.prefixArgs,
      "gateway",
      "--endpoint",
      settings.endpoint,
      "--listen-host",
      "127.0.0.1",
      "--listen-port",
      String(port),
    ];
    if (settings.allowSend) gatewayArgs.push("--allow-send");
    const gateway = spawn(resolved.command, gatewayArgs, {
      cwd: resolved.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.gatewayProcess = gateway;
    this.gatewayOwned = true;
    gateway.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) log("REALTIME_GATEWAY", text);
    });
    gateway.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) log("REALTIME_GATEWAY_ERR", text);
    });
    gateway.once("error", (error) => {
      if (this.gatewayProcess === gateway) this.gatewayProcess = null;
        this.gatewayOwned = false;
      log("REALTIME_GATEWAY_ERR", safeVoiceError(error));
    });
    gateway.once("exit", (code, signal) => {
      if (this.gatewayProcess !== gateway) return;
      this.gatewayProcess = null;
      this.gatewayOwned = false;
      if (code !== 0 && signal !== "SIGTERM") {
        log("REALTIME_GATEWAY_ERR", `Gateway exited (${signal ?? `code ${code}`})`);
        if (!this.bridgeProcess) {
          this.updateState({
            status: "error",
            error: `Voice gateway exited (${signal ?? `code ${code}`}). Check that port ${settings.gatewayPort || DEFAULT_GATEWAY_PORT} is available.`,
          });
        }
      }
    });
  }

  async stopAll(): Promise<void> {
    await this.stop();
    await this.stopGateway();
  }

  async listDevices(): Promise<{ devices?: RealtimeAudioDevice[]; error?: string }> {
    const settings = getAppSettings().realtimeVoice;
    const resolved = resolveBridgeCommand(settings);
    try {
      const { stdout } = await execFileAsync(
        resolved.command,
        [...resolved.prefixArgs, "list-devices"],
        { cwd: resolved.cwd, env: { ...process.env }, timeout: 15_000, maxBuffer: 256 * 1024 },
      );
      const devices = stdout
        .split(/\r?\n/)
        .map(parseDeviceLine)
        .filter((device): device is RealtimeAudioDevice => device !== null);
      return { devices };
    } catch (error) {
      return { error: safeVoiceError(error) };
    }
  }

  private async stopGateway(): Promise<void> {
    if (!this.gatewayOwned) {
      this.gatewayProcess = null;
      return;
    }
    const gateway = this.gatewayProcess;
    if (!gateway) return;
    this.gatewayProcess = null;
    this.gatewayOwned = false;
    let exited = false;
    gateway.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!exited) gateway.kill("SIGKILL");
        resolve();
      }, 1000);
      gateway.once("exit", () => {
        exited = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private updateState(next: RealtimeVoiceState): RealtimeVoiceState {
    this.state = next;
    safeSend(this.getMainWindow, "realtime-voice:state", next);
    return next;
  }
}

function isTcpPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function isWebSocketEndpointReachable(endpoint: string): Promise<boolean> {
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return false;
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === "wss:" ? 443 : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    return await isTcpPortOpen(parsed.hostname, port);
  } catch {
    return false;
  }
}

function displayEndpoint(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "the configured endpoint";
  }
}

let manager: RealtimeVoiceManager | null = null;

export function register(getMainWindow: () => BrowserWindow | null): RealtimeVoiceManager {
  manager = new RealtimeVoiceManager(getMainWindow);
  manager.register();
  return manager;
}

export function getManager(): RealtimeVoiceManager | null {
  return manager;
}

export async function stop(): Promise<void> {
  await manager?.dispose();
}
