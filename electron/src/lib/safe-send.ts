import type { BrowserWindow } from "electron";

// Guard IPC sends against a destroyed window.
// PTY onData, SDK event loops, and ACP callbacks fire asynchronously —
// they can outlive the BrowserWindow on quit, causing "Object has been destroyed" crashes.
//
// Renderer-crash replay: the ACP agent processes are owned by the main
// process and keep running while the renderer is down (crashed/reloading).
// Events sent during that window would be lost forever, truncating a live
// session's transcript. acp:* traffic is buffered here and replayed in
// order once the renderer reports did-finish-load again.
const REPLAYABLE_PREFIXES = ["acp:"];
const REPLAY_BUFFER_MAX_EVENTS = 20_000;
const REPLAY_BUFFER_MAX_BYTES = 8 * 1024 * 1024;

let replayBuffer: Array<{ channel: string; args: unknown[] }> = [];
let replayBytes = 0;
let rendererDown = false;

/** Called by main when the renderer process is gone (crash, not clean exit). */
export function markRendererDown(): void {
  rendererDown = true;
}

/** Called once the renderer finished loading again — flush the buffer. */
export function markRendererUp(getMainWindow: () => BrowserWindow | null): void {
  rendererDown = false;
  if (!replayBuffer.length) return;
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  const pending = replayBuffer;
  replayBuffer = [];
  replayBytes = 0;
  for (const item of pending) {
    try {
      win.webContents.send(item.channel, ...item.args);
    } catch {
      // Renderer died again mid-replay; further events re-buffer as usual.
      break;
    }
  }
}

export function safeSend(
  getMainWindow: () => BrowserWindow | null,
  channel: string,
  ...args: unknown[]
): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  if (rendererDown && REPLAYABLE_PREFIXES.some(prefix => channel.startsWith(prefix))) {
    let size = 0;
    try {
      size = JSON.stringify(args).length;
    } catch {
      return; // unserializable payload can never be replayed
    }
    if (replayBuffer.length < REPLAY_BUFFER_MAX_EVENTS
        && replayBytes + size <= REPLAY_BUFFER_MAX_BYTES) {
      replayBuffer.push({ channel, args });
      replayBytes += size;
    }
    return;
  }
  try {
    win.webContents.send(channel, ...args);
  } catch {
    // Frame disposed mid-send (renderer crash/reload). acp:* traffic is
    // covered by the replay buffer while the renderer is marked down;
    // anything else is stale by definition.
  }
}
