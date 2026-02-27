import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp, AppInstance } from "../src/app";
import WebSocket from "ws";

// --- Helpers ---

let instance: AppInstance;
let baseUrl: string;
let wsUrl: string;

function startServer(
  options: Parameters<typeof createApp>[0] = {},
): Promise<void> {
  return new Promise((resolve) => {
    instance = createApp({ writeLockFile: false, ...options });
    instance.server.listen(0, () => {
      const addr = instance.server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
        wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
      }
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    instance.shutdown();
    instance.server.on("close", resolve);
  });
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

function del(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "DELETE" });
}

function connectWs(): Promise<{ ws: WebSocket; messages: unknown[] }> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    const ws = new WebSocket(wsUrl);
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
    });
    ws.on("open", () => {
      // Wait a tick for the snapshot message to arrive
      setTimeout(() => resolve({ ws, messages }), 50);
    });
  });
}

function waitForMessages(
  messages: unknown[],
  count: number,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (messages.length >= count) return resolve();
      if (Date.now() - start > timeoutMs)
        return reject(
          new Error(
            `Timeout waiting for ${count} messages, got ${messages.length}`,
          ),
        );
      setTimeout(check, 20);
    };
    check();
  });
}

const validAgent = {
  agentId: "agent-1",
  status: "running",
  projectName: "my-project",
};

// --- Tests ---

beforeEach(async () => {
  await startServer();
});

afterEach(async () => {
  await stopServer();
});

describe("REST API — Validation", () => {
  it("rejects missing agentId with 400", async () => {
    const res = await post("/api/status", {
      status: "running",
      projectName: "p",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/agentId/);
  });

  it("rejects invalid status with 400", async () => {
    const res = await post("/api/status", {
      agentId: "a",
      status: "invalid",
      projectName: "p",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/status/);
  });

  it("rejects missing projectName with 400", async () => {
    const res = await post("/api/status", {
      agentId: "a",
      status: "running",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/projectName/);
  });

  it("accepts valid data with 200", async () => {
    const res = await post("/api/status", validAgent);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

describe("REST API — CRUD", () => {
  it("POST then GET returns the agent", async () => {
    await post("/api/status", validAgent);
    const res = await get("/api/status");
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].agentId).toBe("agent-1");
    expect(body[0].status).toBe("running");
  });

  it("POST twice updates the agent", async () => {
    await post("/api/status", validAgent);
    await post("/api/status", { ...validAgent, status: "idle" });
    const res = await get("/api/status");
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].status).toBe("idle");
  });

  it("DELETE removes the agent", async () => {
    await post("/api/status", validAgent);
    const delRes = await del("/api/status/agent-1");
    expect(delRes.status).toBe(200);
    const res = await get("/api/status");
    const body = await res.json();
    expect(body).toHaveLength(0);
  });

  it("DELETE unknown agent returns 404", async () => {
    const res = await del("/api/status/unknown");
    expect(res.status).toBe(404);
  });
});

describe("REST API — Health", () => {
  it("returns 200 with version and uptime", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBeDefined();
    expect(typeof body.uptime).toBe("number");
  });
});

describe("WebSocket — Snapshot & Updates", () => {
  it("sends snapshot on connect", async () => {
    await post("/api/status", validAgent);
    const { ws, messages } = await connectWs();
    try {
      expect(messages).toHaveLength(1);
      const snapshot = messages[0] as { type: string; data: unknown[] };
      expect(snapshot.type).toBe("snapshot");
      expect(snapshot.data).toHaveLength(1);
    } finally {
      ws.close();
    }
  });

  it("sends status_update on POST", async () => {
    const { ws, messages } = await connectWs();
    try {
      await post("/api/status", validAgent);
      await waitForMessages(messages, 2);
      const update = messages[1] as { type: string; data: { agentId: string } };
      expect(update.type).toBe("status_update");
      expect(update.data.agentId).toBe("agent-1");
    } finally {
      ws.close();
    }
  });

  it("sends agent_removed on DELETE", async () => {
    await post("/api/status", validAgent);
    const { ws, messages } = await connectWs();
    try {
      await del("/api/status/agent-1");
      await waitForMessages(messages, 2);
      const removed = messages[1] as {
        type: string;
        data: { agentId: string };
      };
      expect(removed.type).toBe("agent_removed");
      expect(removed.data.agentId).toBe("agent-1");
    } finally {
      ws.close();
    }
  });
});

describe("PID-based Ghost Eviction", () => {
  it("evicts agent A when agent B posts with same PID", async () => {
    const { ws, messages } = await connectWs();
    try {
      await post("/api/status", {
        ...validAgent,
        agentId: "agent-A",
        pid: 1234,
      });
      await post("/api/status", {
        ...validAgent,
        agentId: "agent-B",
        pid: 1234,
      });

      // snapshot + status_update(A) + agent_removed(A) + status_update(B)
      await waitForMessages(messages, 4);
      const removed = messages.find(
        (m: any) =>
          m.type === "agent_removed" && m.data.agentId === "agent-A",
      );
      expect(removed).toBeDefined();

      const res = await get("/api/status");
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].agentId).toBe("agent-B");
    } finally {
      ws.close();
    }
  });

  it("does not evict when agents have no PID", async () => {
    await post("/api/status", { ...validAgent, agentId: "agent-A" });
    await post("/api/status", { ...validAgent, agentId: "agent-B" });
    const res = await get("/api/status");
    const body = await res.json();
    expect(body).toHaveLength(2);
  });
});

describe("Waiting-for-User Debouncing", () => {
  it("delays waiting_for_user broadcast", async () => {
    await stopServer();
    await startServer({ waitingDebounceMs: 200 });

    const { ws, messages } = await connectWs();
    try {
      await post("/api/status", { ...validAgent, status: "waiting_for_user" });

      // Should not have received update yet (only snapshot)
      await new Promise((r) => setTimeout(r, 50));
      expect(messages).toHaveLength(1);

      // After debounce period, should receive update
      await waitForMessages(messages, 2, 1000);
      const update = messages[1] as { type: string; data: { status: string } };
      expect(update.type).toBe("status_update");
      expect(update.data.status).toBe("waiting_for_user");
    } finally {
      ws.close();
    }
  });

  it("cancels waiting_for_user when running follows immediately", async () => {
    await stopServer();
    await startServer({ waitingDebounceMs: 200 });

    const { ws, messages } = await connectWs();
    try {
      await post("/api/status", { ...validAgent, status: "waiting_for_user" });
      await post("/api/status", { ...validAgent, status: "running" });

      // Should get snapshot + running update, no waiting_for_user
      await waitForMessages(messages, 2);
      // Wait a bit more to make sure no extra messages arrive
      await new Promise((r) => setTimeout(r, 300));

      const updates = (messages as any[]).filter(
        (m) => m.type === "status_update",
      );
      expect(updates).toHaveLength(1);
      expect(updates[0].data.status).toBe("running");
    } finally {
      ws.close();
    }
  });
});

describe("WebSocket — Client Messages (focus_request)", () => {
  it("broadcasts focus_request enriched with pid and cwd from store", async () => {
    // Post an agent with pid and cwd
    await post("/api/status", {
      ...validAgent,
      pid: 12345,
      cwd: "/home/user/project",
    });

    const { ws: ws1, messages: msgs1 } = await connectWs();
    const { ws: ws2, messages: msgs2 } = await connectWs();
    try {
      // Client 1 sends a focus_request
      ws1.send(JSON.stringify({ type: "focus_request", agentId: "agent-1" }));

      // Both clients should receive the enriched focus_request
      await waitForMessages(msgs1, 2); // snapshot + focus_request
      await waitForMessages(msgs2, 2); // snapshot + focus_request

      const focus1 = msgs1[1] as any;
      expect(focus1.type).toBe("focus_request");
      expect(focus1.data.agentId).toBe("agent-1");
      expect(focus1.data.pid).toBe(12345);
      expect(focus1.data.cwd).toBe("/home/user/project");

      const focus2 = msgs2[1] as any;
      expect(focus2.type).toBe("focus_request");
      expect(focus2.data.agentId).toBe("agent-1");
    } finally {
      ws1.close();
      ws2.close();
    }
  });

  it("broadcasts focus_request without pid/cwd when agent not in store", async () => {
    const { ws, messages } = await connectWs();
    try {
      ws.send(JSON.stringify({ type: "focus_request", agentId: "unknown-agent" }));

      await waitForMessages(messages, 2); // snapshot + focus_request

      const focus = messages[1] as any;
      expect(focus.type).toBe("focus_request");
      expect(focus.data.agentId).toBe("unknown-agent");
      expect(focus.data.pid).toBeUndefined();
      expect(focus.data.cwd).toBeUndefined();
    } finally {
      ws.close();
    }
  });

  it("ignores invalid client messages", async () => {
    const { ws, messages } = await connectWs();
    try {
      // Send garbage
      ws.send("not json at all");
      // Send valid JSON but unknown type
      ws.send(JSON.stringify({ type: "unknown_type", foo: "bar" }));
      // Send focus_request without agentId
      ws.send(JSON.stringify({ type: "focus_request" }));

      // Wait a bit — should not receive any extra messages beyond snapshot
      await new Promise((r) => setTimeout(r, 200));
      expect(messages).toHaveLength(1); // only snapshot
    } finally {
      ws.close();
    }
  });
});

describe("Stale Cleanup", () => {
  it("removes agent with dead PID on cleanup", async () => {
    const { ws, messages } = await connectWs();
    try {
      // Use a PID that is almost certainly not alive
      await post("/api/status", { ...validAgent, pid: 2147483647 });
      await waitForMessages(messages, 2); // snapshot + status_update

      instance.runCleanup();

      await waitForMessages(messages, 3); // + agent_removed
      const removed = messages[2] as {
        type: string;
        data: { agentId: string };
      };
      expect(removed.type).toBe("agent_removed");
      expect(removed.data.agentId).toBe("agent-1");

      const res = await get("/api/status");
      const body = await res.json();
      expect(body).toHaveLength(0);
    } finally {
      ws.close();
    }
  });
});
