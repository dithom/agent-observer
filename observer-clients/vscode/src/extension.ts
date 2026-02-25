import * as vscode from "vscode";
import { startServer, waitForServer, stopServerIfLast, readLockFile, isServerRunning } from "./server-manager";
import { WebSocketClient } from "./websocket-client";
import { StatusBar } from "./status-bar";
import { AgentTreeDataProvider } from "./tree-view";

interface AgentStatus {
  agentId: string;
  status: "running" | "waiting_for_user" | "idle" | "error";
  projectName: string;
  client?: string;
  cwd?: string;
  timestamp: number;
}

let wsClient: WebSocketClient | undefined;
let statusBar: StatusBar | undefined;
let treeProvider: AgentTreeDataProvider | undefined;
let treeView: vscode.TreeView<any> | undefined;
let previousAgents: Map<string, AgentStatus> = new Map();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  statusBar = new StatusBar();
  treeProvider = new AgentTreeDataProvider();

  treeView = vscode.window.createTreeView("agentObserver.agents", {
    treeDataProvider: treeProvider,
  });

  context.subscriptions.push(statusBar, treeView, { dispose: () => treeProvider?.dispose() });

  // Start server if needed
  let port = await ensureServer();

  if (port) {
    connectWebSocket(port);
  }

  // Periodically check server health
  const healthCheck = setInterval(async () => {
    const lock = readLockFile();
    if (!lock || !isServerRunning(lock)) {
      statusBar?.setConnected(false);
      port = await ensureServer();
      if (port) {
        if (wsClient) {
          wsClient.updatePort(port);
        } else {
          connectWebSocket(port);
        }
      }
    }
  }, 30000);

  context.subscriptions.push({
    dispose: () => {
      clearInterval(healthCheck);
      wsClient?.dispose();
      stopServerIfLast();
    },
  });
}

async function ensureServer(): Promise<number | null> {
  const lock = readLockFile();
  if (lock && isServerRunning(lock)) {
    return lock.port;
  }

  startServer();
  return waitForServer();
}

function connectWebSocket(port: number): void {
  wsClient = new WebSocketClient(port);

  wsClient.on("connected", () => {
    statusBar?.setConnected(true);
  });

  wsClient.on("disconnected", () => {
    statusBar?.setConnected(false);
  });

  wsClient.on("snapshot", (agents: AgentStatus[]) => {
    previousAgents.clear();
    for (const a of agents) {
      previousAgents.set(a.agentId, a);
    }
    statusBar?.setAgents(agents);
    treeProvider?.setAgents(agents);
    updateBadge();
  });

  wsClient.on("status_update", (agent: AgentStatus) => {
    notifyIfNeeded(agent);
    previousAgents.set(agent.agentId, agent);
    statusBar?.updateAgent(agent);
    treeProvider?.updateAgent(agent);
    updateBadge();
  });

  wsClient.on("agent_removed", (data: { agentId: string }) => {
    previousAgents.delete(data.agentId);
    statusBar?.removeAgent(data.agentId);
    treeProvider?.removeAgent(data.agentId);
    updateBadge();
  });

  wsClient.connect();
}

function notifyIfNeeded(agent: AgentStatus): void {
  const prev = previousAgents.get(agent.agentId);

  // Only notify on status transitions, not on new agents
  if (!prev || prev.status === agent.status) {
    return;
  }

  const displayName = agent.client || agent.agentId.substring(0, 8);

  if (agent.status === "waiting_for_user") {
    const msg = vscode.window.showWarningMessage(
      `${displayName} (${agent.projectName}) is waiting for input`,
      "Focus Window"
    );
    msg.then((action) => {
      if (action === "Focus Window" && agent.cwd) {
        vscode.commands.executeCommand("agentObserver.focusWindow", agent.cwd);
      }
    });
  } else if (agent.status === "error") {
    const msg = vscode.window.showErrorMessage(
      `${displayName} (${agent.projectName}) has an error`,
      "Focus Window"
    );
    msg.then((action) => {
      if (action === "Focus Window" && agent.cwd) {
        vscode.commands.executeCommand("agentObserver.focusWindow", agent.cwd);
      }
    });
  }
}

function updateBadge(): void {
  if (!treeView) {
    return;
  }
  const agents = Array.from(previousAgents.values());
  const attentionCount = agents.filter(
    (a) => a.status === "waiting_for_user" || a.status === "error"
  ).length;

  if (attentionCount > 0) {
    treeView.badge = { value: attentionCount, tooltip: `${attentionCount} agent(s) need attention` };
  } else {
    treeView.badge = undefined;
  }
}

export function deactivate(): void {
  wsClient?.dispose();
  stopServerIfLast();
}
