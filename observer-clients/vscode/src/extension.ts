import * as vscode from "vscode";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { exec, execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { startServer, waitForServer, stopServerIfLast, readLockFile, isServerRunning } from "./server-manager";
import { WebSocketClient } from "./websocket-client";
import { StatusBar } from "./status-bar";
import { AgentTreeDataProvider } from "./tree-view";

const DEBUG_FLAG_DIR = join(homedir(), ".agent-observer");
const DEBUG_FLAG_FILE = join(DEBUG_FLAG_DIR, "debug");

interface AgentStatus {
  agentId: string;
  status: "running" | "waiting_for_user" | "idle" | "error";
  projectName: string;
  client?: string;
  cwd?: string;
  pid?: number;
  timestamp: number;
}

let wsClient: WebSocketClient | undefined;
let statusBar: StatusBar | undefined;
let treeProvider: AgentTreeDataProvider | undefined;
let treeView: vscode.TreeView<any> | undefined;
let previousAgents: Map<string, AgentStatus> = new Map();

/**
 * Match an agent's cwd to the closest VS Code workspace folder.
 * Overrides projectName with the workspace folder name and cwd with
 * the workspace folder path so that "focus window" opens the right root.
 */
function resolveWorkspace(agent: AgentStatus): AgentStatus {
  if (!agent.cwd) {
    return agent;
  }
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return agent;
  }
  // Find the workspace folder that contains the agent's cwd (longest prefix wins)
  let best: vscode.WorkspaceFolder | undefined;
  for (const folder of folders) {
    const folderPath = folder.uri.fsPath;
    if (agent.cwd === folderPath || agent.cwd.startsWith(folderPath + "/")) {
      if (!best || folderPath.length > best.uri.fsPath.length) {
        best = folder;
      }
    }
  }
  if (best) {
    return { ...agent, projectName: best.name, cwd: best.uri.fsPath };
  }
  return agent;
}

function syncDebugFlag(): void {
  const enabled = vscode.workspace.getConfiguration("agentObserver").get<boolean>("debugLogging", false);
  try {
    mkdirSync(DEBUG_FLAG_DIR, { recursive: true });
    if (enabled) {
      writeFileSync(DEBUG_FLAG_FILE, "");
    } else {
      unlinkSync(DEBUG_FLAG_FILE);
    }
  } catch {
    // Ignore — file may not exist on delete, or dir creation may race
  }
}

function isWorkspaceMatch(cwd: string): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !cwd) {
    return false;
  }
  for (const folder of folders) {
    const folderPath = folder.uri.fsPath;
    if (cwd === folderPath || cwd.startsWith(folderPath + "/")) {
      return true;
    }
  }
  return false;
}

async function tryFocusTerminal(pid: number): Promise<boolean> {
  try {
    const raw = execSync("ps -eo pid=,ppid=", { encoding: "utf-8" });
    const processMap = new Map<number, number>();
    for (const line of raw.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 2) {
        processMap.set(Number(parts[0]), Number(parts[1]));
      }
    }

    // Walk up from the agent PID to collect all ancestors
    // Terminal PID (shell) is an ancestor of the agent PID (Claude Code)
    const ancestors = new Set<number>([pid]);
    let current = pid;
    while (processMap.has(current)) {
      const parent = processMap.get(current)!;
      if (parent <= 1 || ancestors.has(parent)) break;
      ancestors.add(parent);
      current = parent;
    }

    for (const terminal of vscode.window.terminals) {
      const termPid = await terminal.processId;
      if (termPid && ancestors.has(termPid)) {
        terminal.show();
        return true;
      }
    }
  } catch {
    // ps command failed — skip terminal focus
  }
  return false;
}

async function tryFocusClaudePanel(): Promise<boolean> {
  const allCommands = await vscode.commands.getCommands(true);
  if (allCommands.includes("claude-vscode.focus")) {
    await vscode.commands.executeCommand("claude-vscode.focus");
    return true;
  }
  return false;
}

async function handleFocusRequest(data: { agentId: string; pid?: number; cwd?: string }): Promise<void> {
  if (!data.cwd || !isWorkspaceMatch(data.cwd)) {
    return;
  }

  // This agent belongs to our window — focus terminal or Claude panel
  if (data.pid) {
    // Agent has a PID → terminal-based (CLI mode)
    await tryFocusTerminal(data.pid);
  } else {
    // No PID → likely GUI mode (claude-vscode)
    await tryFocusClaudePanel();
  }

  // Bring the window to foreground
  exec(`code "${data.cwd}"`);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  syncDebugFlag();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentObserver.debugLogging")) {
        syncDebugFlag();
      }
    }),
  );

  const focusDisposable = vscode.commands.registerCommand(
    "agentObserver.focusWindow",
    (agentId: string, _pid?: number, cwd?: string) => {
      if (wsClient) {
        wsClient.send({ type: "focus_request", agentId });
      } else if (cwd) {
        // Fallback: no WebSocket, just open the window directly
        exec(`code "${cwd}"`);
      }
    },
  );
  context.subscriptions.push(focusDisposable);

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

  // Let the WS client read the current port from the lock file on each
  // reconnect attempt so it picks up server restarts automatically.
  wsClient.setPortResolver(() => {
    const lock = readLockFile();
    return lock && isServerRunning(lock) ? lock.port : null;
  });

  wsClient.on("connected", () => {
    statusBar?.setConnected(true);
  });

  wsClient.on("disconnected", () => {
    statusBar?.setConnected(false);
  });

  wsClient.on("snapshot", (agents: AgentStatus[]) => {
    previousAgents.clear();
    const resolved = agents.map(resolveWorkspace);
    for (const a of resolved) {
      previousAgents.set(a.agentId, a);
    }
    statusBar?.setAgents(resolved);
    treeProvider?.setAgents(resolved);
    updateBadge();
  });

  wsClient.on("status_update", (agent: AgentStatus) => {
    const resolved = resolveWorkspace(agent);
    previousAgents.set(resolved.agentId, resolved);
    statusBar?.updateAgent(resolved);
    treeProvider?.updateAgent(resolved);
    updateBadge();
  });

  wsClient.on("focus_request", (data: { agentId: string; pid?: number; cwd?: string }) => {
    handleFocusRequest(data);
  });

  wsClient.on("agent_removed", (data: { agentId: string }) => {
    previousAgents.delete(data.agentId);
    statusBar?.removeAgent(data.agentId);
    treeProvider?.removeAgent(data.agentId);
    updateBadge();
  });

  wsClient.connect();
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
