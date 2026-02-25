import { EventEmitter } from "events";
import WebSocket from "ws";

interface AgentStatus {
  agentId: string;
  status: "running" | "waiting_for_user" | "idle" | "error";
  projectName: string;
  timestamp: number;
}

type WsMessage =
  | { type: "snapshot"; data: AgentStatus[] }
  | { type: "status_update"; data: AgentStatus }
  | { type: "agent_removed"; data: { agentId: string } };

export class WebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private port: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private disposed = false;

  constructor(port: number) {
    super();
    this.port = port;
  }

  connect(): void {
    if (this.disposed) {
      return;
    }

    try {
      this.ws = new WebSocket(`ws://localhost:${this.port}/ws`);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.reconnectDelay = 1000;
      this.emit("connected");
    });

    this.ws.on("message", (data) => {
      try {
        const message: WsMessage = JSON.parse(data.toString());
        this.emit(message.type, message.data);
      } catch {
        // Ignore malformed messages
      }
    });

    this.ws.on("close", () => {
      this.emit("disconnected");
      this.scheduleReconnect();
    });

    this.ws.on("error", () => {
      // Error will be followed by close event
    });
  }

  updatePort(port: number): void {
    if (this.port !== port) {
      this.port = port;
      this.disconnect();
      this.connect();
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
  }
}
