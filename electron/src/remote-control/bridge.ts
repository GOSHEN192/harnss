import { randomUUID } from "crypto";
import type { BrowserWindow, IpcMainEvent } from "electron";
import { ipcMain } from "electron";
import type {
  RemoteRendererRequest,
  RemoteRendererResponse,
  RemoteServerEvent,
} from "@shared/types/remote";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Correlated main↔renderer bridge for remote control.
 *
 * The main process owns transport and authentication. The renderer remains the
 * authority for live session state and engine operations.
 */
export class RemoteControlBridge {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: RemoteServerEvent) => void>();
  private readonly responseListener: (event: IpcMainEvent, response: RemoteRendererResponse) => void;
  private readonly eventListener: (event: IpcMainEvent, payload: RemoteServerEvent) => void;

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {
    this.responseListener = (event, response) => {
      const mainWindow = this.getMainWindow();
      if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return;
      if (!response || typeof response.requestId !== "string") return;

      const pending = this.pending.get(response.requestId);
      if (!pending) return;
      this.pending.delete(response.requestId);
      clearTimeout(pending.timer);
      if (response.ok) pending.resolve(response.data);
      else pending.reject(new Error(response.error || "Remote renderer request failed"));
    };
    this.eventListener = (event, payload) => {
      const mainWindow = this.getMainWindow();
      if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return;
      if (!payload || typeof payload.type !== "string") return;
      for (const listener of this.eventListeners) listener(payload);
    };

    ipcMain.on("remote:response", this.responseListener);
    ipcMain.on("remote:event", this.eventListener);
  }

  request(method: RemoteRendererRequest["method"], payload: Record<string, unknown> = {}): Promise<unknown> {
    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return Promise.reject(new Error("Harnss window is unavailable"));
    }

    const requestId = randomUUID();
    const message: RemoteRendererRequest = { requestId, method, payload };
    return new Promise((resolve, reject) => {
      const timeoutMs = method === "sessions.create" ? 30_000 : 15_000;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Remote renderer request timed out"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      mainWindow.webContents.send("remote:request", message);
    });
  }

  onEvent(listener: (event: RemoteServerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  dispose(): void {
    ipcMain.removeListener("remote:response", this.responseListener);
    ipcMain.removeListener("remote:event", this.eventListener);
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Remote control bridge stopped"));
      this.pending.delete(requestId);
    }
    this.eventListeners.clear();
  }
}
