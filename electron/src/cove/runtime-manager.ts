import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import { getAppSettings } from "../lib/app-settings";
import { log } from "../lib/logger";

export const DEFAULT_COVE_RUNTIME_DIR =
  "/Users/logoshen/agents/双工实时语音开发/cove-gpt-live-voice-system";
export const DEFAULT_COVE_VOICE_PORT = 8876;

type CoveProcess = ChildProcess;

function configuredPort(): number {
  const value = Number(process.env.COVE_VOICE_PORT);
  return Number.isInteger(value) && value >= 1024 && value <= 65535
    ? value
    : DEFAULT_COVE_VOICE_PORT;
}

export function getCoveRuntimeDir(): string {
  return process.env.COVE_RUNTIME_DIR?.trim() || DEFAULT_COVE_RUNTIME_DIR;
}

export function getCoveFrontendDir(): string {
  return process.env.COVE_FRONTEND_DIR?.trim()
    || path.join(getCoveRuntimeDir(), "frontend");
}

export function getCoveVoicePort(): number {
  return configuredPort();
}

async function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

/**
 * Owns the standalone COVE runtime used by the authenticated Harnss web
 * deployment. The desktop realtime voice manager remains independent.
 */
export class CoveRuntimeManager {
  private process: CoveProcess | null = null;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;

  get pid(): number | undefined {
    return this.process?.pid;
  }

  get running(): boolean {
    return this.process !== null;
  }

  async start(): Promise<void> {
    if (this.process || this.stopping) return;
    if (!getAppSettings().remoteEnabled) return;

    const runtimeDir = getCoveRuntimeDir();
    const python = path.join(runtimeDir, ".venv", "bin", "python");
    if (!fs.existsSync(python)) {
      throw new Error(`COVE Python runtime not found at ${python}`);
    }
    if (!fs.existsSync(runtimeDir)) {
      throw new Error(`COVE runtime directory not found at ${runtimeDir}`);
    }

    const port = getCoveVoicePort();
    // A separately supervised COVE instance may already be healthy. Reuse it
    // instead of spawning a second process that immediately loses the race.
    if (await isPortOpen(port)) {
      log("COVE", `Reusing existing runtime on 127.0.0.1:${port}`);
      this.restartAttempt = 0;
      return;
    }
    const child = spawn(python, ["-m", "cove_voice_system.server"], {
      cwd: runtimeDir,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        VOICE_HOST: "127.0.0.1",
        VOICE_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) log("COVE", text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) log("COVE_ERR", text);
    });
    child.once("error", (error) => {
      if (this.process === child) this.process = null;
      log("COVE_ERR", error.message);
      this.scheduleRestart();
    });
    child.once("exit", (code, signal) => {
      if (this.process !== child) return;
      this.process = null;
      if (!this.stopping && code !== 0 && signal !== "SIGTERM") {
        log("COVE_ERR", `Runtime exited (${signal ?? `code ${code}`})`);
        this.scheduleRestart();
      } else if (!this.stopping) {
        this.scheduleRestart();
      }
    });
    this.restartAttempt = 0;
    log("COVE", `Starting runtime on 127.0.0.1:${port}`);
  }

  async stop(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.process;
    if (!child) return;
    this.process = null;
    this.stopping = true;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish();
      }, 1500);
      child.once("exit", finish);
    });
    this.stopping = false;
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer || !getAppSettings().remoteEnabled) return;
    const delay = Math.min(30_000, 500 * 2 ** this.restartAttempt);
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start().catch((error) => {
        log("COVE_ERR", error instanceof Error ? error.message : String(error));
        this.scheduleRestart();
      });
    }, delay);
  }
}
