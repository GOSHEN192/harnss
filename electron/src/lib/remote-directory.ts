import { spawn } from "child_process";
import path from "path";

export interface RemoteDirectoryEntry {
  name: string;
  path: string;
}

export interface RemoteDirectoryListing {
  path: string;
  parent: string | null;
  entries: RemoteDirectoryEntry[];
}

interface BrowseDirectoryInput {
  binary: string;
  args?: string[];
  directory: string;
}

const REMOTE_LIST_SCRIPT = [
  "import base64,json,os,sys",
  "p=base64.b64decode(sys.argv[1]).decode('utf-8')",
  "p=os.path.realpath(p)",
  "if not os.path.isdir(p): raise NotADirectoryError(p)",
  "entries=[]",
  "for n in sorted(os.listdir(p),key=str.casefold):",
  " c=os.path.join(p,n)",
  " if os.path.isdir(c) and not os.path.islink(c): entries.append({'name':n,'path':c})",
  "print(json.dumps({'path':p,'parent':os.path.dirname(p) if p != os.path.dirname(p) else None,'entries':entries},ensure_ascii=False))",
].join("\n");

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function getSshTargetIndex(args: string[]): number {
  return args.findIndex((arg) => /^[^@/\s]+@[^/\s]+$/.test(arg));
}

export function isSshBinary(binary: string): boolean {
  return path.basename(binary.trim()) === "ssh";
}

export async function browseRemoteDirectory(input: BrowseDirectoryInput): Promise<RemoteDirectoryListing> {
  const binary = input.binary.trim();
  const args = input.args ?? [];
  if (!isSshBinary(binary)) {
    throw new Error("Remote directory browsing requires an SSH Agent.");
  }

  const targetIndex = getSshTargetIndex(args);
  if (targetIndex < 0) {
    throw new Error("Could not find the SSH host in the Agent arguments.");
  }

  const encodedPath = Buffer.from(input.directory.trim() || "/root", "utf8").toString("base64");
  const remoteCommand = `python3 -c ${shellQuote(REMOTE_LIST_SCRIPT)} ${shellQuote(encodedPath)}`;
  const sshArgs = [...args.slice(0, targetIndex), args[targetIndex], remoteCommand];

  return new Promise((resolve, reject) => {
    const child = spawn(binary, sshArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out while reading the remote directory."));
    }, 15000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `SSH exited with code ${code ?? "unknown"}.`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as RemoteDirectoryListing;
        if (!parsed.path || !Array.isArray(parsed.entries)) {
          throw new Error("Remote Agent returned an invalid directory listing.");
        }
        resolve(parsed);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Invalid remote directory response."));
      }
    });
  });
}
