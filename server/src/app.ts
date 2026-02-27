import express from "express";
import { createServer, Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// --- Types ---

export interface AgentStatus {
  agentId: string;
  status: "running" | "waiting_for_user" | "idle" | "error";
  projectName: string;
  client?: string;
  cwd?: string;
  pid?: number;
  label?: string;
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
  | { type: "agent_removed"; data: { agentId: string } }
  | { type: "focus_request"; data: { agentId: string; pid?: number; cwd?: string } };

// --- Config ---

export const VERSION = "0.3.0";
const STALE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours (fallback for agents without PID)
const CLEANUP_INTERVAL_MS = 30 * 1000; // 30 seconds
const WAITING_DEBOUNCE_MS = 3_000; // debounce waiting_for_user to absorb autonomous mode switches
const LOCK_DIR = join(homedir(), ".agent-observer");
const LOCK_FILE = join(LOCK_DIR, "server.lock");
const VALID_STATUSES = new Set(["running", "waiting_for_user", "idle", "error"]);

// --- Options ---

export interface CreateAppOptions {
  writeLockFile?: boolean;
  waitingDebounceMs?: number;
  cleanupIntervalMs?: number;
}

// --- Return type ---

export interface AppInstance {
  app: express.Express;
  server: Server;
  wss: WebSocketServer;
  store: Map<string, AgentStatus>;
  pendingWaiting: Map<string, ReturnType<typeof setTimeout>>;
  runCleanup: () => void;
  shutdown: () => void;
}

// --- Factory ---

export function createApp(options: CreateAppOptions = {}): AppInstance {
  const {
    writeLockFile: shouldWriteLockFile = true,
    waitingDebounceMs = WAITING_DEBOUNCE_MS,
    cleanupIntervalMs = CLEANUP_INTERVAL_MS,
  } = options;

  // --- State ---

  const store = new Map<string, AgentStatus>();
  const pendingWaiting = new Map<string, ReturnType<typeof setTimeout>>();
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
    const existing = store.get(agentId);

    // Determine label: explicit POST value wins, otherwise preserve existing
    let label: string | undefined;
    if (req.body.label !== undefined) {
      label = typeof req.body.label === "string" && req.body.label !== "" ? req.body.label : undefined;
    } else {
      label = existing?.label;
    }

    const entry: AgentStatus = {
      agentId,
      status,
      projectName,
      ...(client && typeof client === "string" ? { client } : {}),
      ...(cwd && typeof cwd === "string" ? { cwd } : {}),
      ...(pid && typeof pid === "number" ? { pid } : {}),
      ...(label ? { label } : {}),
      timestamp: Date.now(),
    };

    // Evict other sessions sharing the same PID.
    if (entry.pid) {
      for (const [otherId, other] of store) {
        if (otherId !== agentId && other.pid === entry.pid) {
          store.delete(otherId);
          const p = pendingWaiting.get(otherId);
          if (p) {
            clearTimeout(p);
            pendingWaiting.delete(otherId);
          }
          broadcast({ type: "agent_removed", data: { agentId: otherId } });
        }
      }
    }

    store.set(agentId, entry);

    if (status === "waiting_for_user") {
      const existing = pendingWaiting.get(agentId);
      if (existing) clearTimeout(existing);
      pendingWaiting.set(
        agentId,
        setTimeout(() => {
          pendingWaiting.delete(agentId);
          const current = store.get(agentId);
          if (current && current.status === "waiting_for_user") {
            broadcast({ type: "status_update", data: current });
          }
        }, waitingDebounceMs),
      );
    } else {
      const pending = pendingWaiting.get(agentId);
      if (pending) {
        clearTimeout(pending);
        pendingWaiting.delete(agentId);
      }
      broadcast({ type: "status_update", data: entry });
    }

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
    const pending = pendingWaiting.get(agentId);
    if (pending) {
      clearTimeout(pending);
      pendingWaiting.delete(agentId);
    }
    broadcast({ type: "agent_removed", data: { agentId } });
    res.json({ ok: true });
  });

  app.patch("/api/status/:agentId/label", (req, res) => {
    const { agentId } = req.params;
    const agent = store.get(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const { label } = req.body;
    if (typeof label !== "string") {
      res.status(400).json({ error: "Missing or invalid field: label" });
      return;
    }

    if (label === "") {
      delete agent.label;
    } else {
      agent.label = label;
    }

    broadcast({ type: "status_update", data: agent });
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

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type === "focus_request" && typeof msg.agentId === "string") {
          const agent = store.get(msg.agentId);
          const enriched: WsMessage = {
            type: "focus_request",
            data: {
              agentId: msg.agentId,
              ...(agent?.pid ? { pid: agent.pid } : {}),
              ...(agent?.cwd ? { cwd: agent.cwd } : {}),
            },
          };
          broadcast(enriched);
        }
        // Ignore unknown message types silently
      } catch {
        // Ignore malformed messages
      }
    });
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

  function runCleanup(): void {
    const now = Date.now();
    for (const [agentId, entry] of store) {
      let stale = false;

      if (entry.pid) {
        stale = !isProcessAlive(entry.pid);
      } else {
        stale = now - entry.timestamp > STALE_TIMEOUT_MS;
      }

      if (stale) {
        store.delete(agentId);
        const pending = pendingWaiting.get(agentId);
        if (pending) {
          clearTimeout(pending);
          pendingWaiting.delete(agentId);
        }
        broadcast({ type: "agent_removed", data: { agentId } });
      }
    }
  }

  const cleanupInterval = setInterval(runCleanup, cleanupIntervalMs);

  // --- Lock File ---

  function doWriteLockFile(port: number): void {
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

  // Write lock file when server starts listening (if enabled)
  if (shouldWriteLockFile) {
    server.on("listening", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        doWriteLockFile(addr.port);
      }
    });
  }

  // --- Shutdown ---

  function shutdown(): void {
    clearInterval(cleanupInterval);
    for (const timer of pendingWaiting.values()) clearTimeout(timer);
    pendingWaiting.clear();
    if (shouldWriteLockFile) removeLockFile();
    wss.close();
    server.close();
  }

  return { app, server, wss, store, pendingWaiting, runCleanup, shutdown };
}
