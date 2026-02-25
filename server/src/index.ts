import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// --- Types ---

interface AgentStatus {
  agentId: string;
  status: "running" | "waiting_for_user" | "idle" | "error";
  projectName: string;
  client?: string;
  cwd?: string;
  pid?: number;
  timestamp: number;
}

interface ServerLock {
  pid: number;
  port: number;
  version: string;
}

type WsMessage =
  | { type: "snapshot"; data: AgentStatus[] }
  | { type: "status_update"; data: AgentStatus }
  | { type: "agent_removed"; data: { agentId: string } };

// --- Config ---

const VERSION = "1.0.0";
const STALE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours (fallback for agents without PID)
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds
const LOCK_DIR = join(homedir(), ".agent-observer");
const LOCK_FILE = join(LOCK_DIR, "server.lock");
const VALID_STATUSES = new Set(["running", "waiting_for_user", "idle", "error"]);

// --- State ---

const store = new Map<string, AgentStatus>();
const startTime = Date.now();

// --- Express App ---

const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    version: VERSION,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

app.post("/api/status", (req, res) => {
  const { agentId, status, projectName } = req.body;

  if (!agentId || typeof agentId !== "string") {
    res.status(400).json({ error: "Missing or invalid field: agentId" });
    return;
  }
  if (!status || !VALID_STATUSES.has(status)) {
    res.status(400).json({ error: "Missing or invalid field: status" });
    return;
  }
  if (!projectName || typeof projectName !== "string") {
    res.status(400).json({ error: "Missing or invalid field: projectName" });
    return;
  }

  const client = req.body.client;
  const cwd = req.body.cwd;
  const pid = req.body.pid;

  const entry: AgentStatus = {
    agentId,
    status,
    projectName,
    ...(client && typeof client === "string" ? { client } : {}),
    ...(cwd && typeof cwd === "string" ? { cwd } : {}),
    ...(pid && typeof pid === "number" ? { pid } : {}),
    timestamp: Date.now(),
  };

  store.set(agentId, entry);
  broadcast({ type: "status_update", data: entry });
  res.json({ ok: true });
});

app.get("/api/status", (_req, res) => {
  res.json(Array.from(store.values()));
});

app.delete("/api/status/:agentId", (req, res) => {
  const { agentId } = req.params;
  if (!store.has(agentId)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  store.delete(agentId);
  broadcast({ type: "agent_removed", data: { agentId } });
  res.json({ ok: true });
});

// --- HTTP + WebSocket Server ---

const server = createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const snapshot: WsMessage = {
    type: "snapshot",
    data: Array.from(store.values()),
  };
  ws.send(JSON.stringify(snapshot));
});

function broadcast(message: WsMessage): void {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// --- Stale Agent Cleanup ---

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [agentId, entry] of store) {
    let stale = false;

    if (entry.pid) {
      // PID available: check if process is still alive
      stale = !isProcessAlive(entry.pid);
    } else {
      // No PID: fall back to timeout
      stale = now - entry.timestamp > STALE_TIMEOUT_MS;
    }

    if (stale) {
      store.delete(agentId);
      broadcast({ type: "agent_removed", data: { agentId } });
    }
  }
}, CLEANUP_INTERVAL_MS);

// --- Lock File ---

function writeLockFile(port: number): void {
  mkdirSync(LOCK_DIR, { recursive: true });
  const lock: ServerLock = { pid: process.pid, port, version: VERSION };
  writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2));
}

function removeLockFile(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      unlinkSync(LOCK_FILE);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

// --- Shutdown ---

function shutdown(): void {
  clearInterval(cleanupInterval);
  removeLockFile();
  wss.close();
  server.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// --- Start ---

server.listen(0, () => {
  const addr = server.address();
  if (addr && typeof addr === "object") {
    writeLockFile(addr.port);
    console.log(`Agent Observer server running on port ${addr.port}`);
  }
});
