import { spawn } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

interface ServerLock {
  pid: number;
  port: number;
  version: string;
}

const LOCK_DIR = join(homedir(), ".agent-observer");
const LOCK_FILE = join(LOCK_DIR, "server.lock");
const INSTANCES_DIR = join(LOCK_DIR, "instances");

let instanceId: string | undefined;

export function getServerBundlePath(): string {
  return join(__dirname, "server.js");
}

export function readLockFile(): ServerLock | null {
  try {
    if (!existsSync(LOCK_FILE)) {
      return null;
    }
    const content = readFileSync(LOCK_FILE, "utf-8");
    return JSON.parse(content) as ServerLock;
  } catch {
    return null;
  }
}

export function isServerRunning(lock: ServerLock): boolean {
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function registerInstance(): void {
  mkdirSync(INSTANCES_DIR, { recursive: true });
  instanceId = `${process.pid}-${Date.now()}`;
  writeFileSync(join(INSTANCES_DIR, instanceId), "");
}

function unregisterInstance(): void {
  if (instanceId) {
    try {
      unlinkSync(join(INSTANCES_DIR, instanceId));
    } catch {
      // Ignore
    }
    instanceId = undefined;
  }
}

function getInstanceCount(): number {
  try {
    if (!existsSync(INSTANCES_DIR)) {
      return 0;
    }
    return readdirSync(INSTANCES_DIR).length;
  } catch {
    return 0;
  }
}

export function startServer(): number | null {
  const lock = readLockFile();
  if (lock && isServerRunning(lock)) {
    registerInstance();
    return lock.port;
  }

  // Clean up stale lock file
  if (lock) {
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      // Ignore
    }
  }

  const serverPath = getServerBundlePath();
  if (!existsSync(serverPath)) {
    return null;
  }

  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  registerInstance();

  // Wait for lock file to appear (poll up to 5 seconds)
  return null; // Port will be read asynchronously
}

export async function waitForServer(timeoutMs: number = 5000): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const lock = readLockFile();
    if (lock && isServerRunning(lock)) {
      return lock.port;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

export function stopServerIfLast(): void {
  unregisterInstance();

  const remaining = getInstanceCount();
  if (remaining > 0) {
    return;
  }

  const lock = readLockFile();
  if (lock && isServerRunning(lock)) {
    try {
      process.kill(lock.pid, "SIGTERM");
    } catch {
      // Ignore
    }
  }
}
