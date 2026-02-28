import * as vscode from "vscode";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { exec, execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { startServer, waitForServer, stopServerIfLast, readLockFile, isServerRunning } from "./server-manager";
import { WebSocketClient } from "./websocket-client";
import { StatusBar } from "./status-bar";
import { AgentWebviewViewProvider } from "./webview-view";

const DEBUG_FLAG_DIR = join(homedir(), ".agent-observer");
const DEBUG_FLAG_FILE = join(DEBUG_FLAG_DIR, "debug");

interface AgentStatus {
  agentId: string;
  status: "running" | "waiting_for_user" | "idle" | "error";
  projectName: string;
  client?: string;
  cwd?: string;
  pid?: number;
  label?: string;
  timestamp: number;
}

let wsClient: WebSocketClient | undefined;
let statusBar: StatusBar | undefined;
let webviewProvider: AgentWebviewViewProvider | undefined;
let previousAgents: Map<string, AgentStatus> = new Map();
let serverPort: number | null = null;

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

  // "✓ Group by Project" shown when enabled → clicking disables
  context.subscriptions.push(
    vscode.commands.registerCommand("agentObserver.enableGroupByProject", () => {
      vscode.workspace.getConfiguration("agentObserver").update("groupByProject", false, true);
    }),
  );
  // "Group by Project" shown when disabled → clicking enables
  context.subscriptions.push(
    vscode.commands.registerCommand("agentObserver.disableGroupByProject", () => {
      vscode.workspace.getConfiguration("agentObserver").update("groupByProject", true, true);
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
  webviewProvider = new AgentWebviewViewProvider(
    (agentId, pid, cwd) => {
      vscode.commands.executeCommand("agentObserver.focusWindow", agentId, pid, cwd);
    },
    async (agentId) => {
      const agent = previousAgents.get(agentId);
      const currentLabel = agent?.label || "";
      const newLabel = await vscode.window.showInputBox({
        prompt: "Enter a label for this agent",
        value: currentLabel,
        placeHolder: "e.g. Refactoring auth module",
      });
      if (newLabel === undefined) {
        return; // cancelled
      }
      if (serverPort) {
        try {
          await fetch(`http://localhost:${serverPort}/api/status/${agentId}/label`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ label: newLabel }),
          });
        } catch {
          // Server unreachable — ignore
        }
      }
    },
  );

  const webviewDisposable = vscode.window.registerWebviewViewProvider(
    AgentWebviewViewProvider.viewType,
    webviewProvider,
  );

  context.subscriptions.push(statusBar, webviewDisposable);

  // Start server if needed
  serverPort = await ensureServer();

  if (serverPort) {
    connectWebSocket(serverPort);
  }

  // Periodically check server health
  const healthCheck = setInterval(async () => {
    const lock = readLockFile();
    if (!lock || !isServerRunning(lock)) {
      statusBar?.setConnected(false);
      serverPort = await ensureServer();
      if (serverPort) {
        if (wsClient) {
          wsClient.updatePort(serverPort);
        } else {
          connectWebSocket(serverPort);
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
    webviewProvider?.setAgents(resolved);
  });

  wsClient.on("status_update", (agent: AgentStatus) => {
    const resolved = resolveWorkspace(agent);
    previousAgents.set(resolved.agentId, resolved);
    statusBar?.updateAgent(resolved);
    webviewProvider?.updateAgent(resolved);
  });

  wsClient.on("focus_request", (data: { agentId: string; pid?: number; cwd?: string }) => {
    handleFocusRequest(data);
  });

  wsClient.on("agent_removed", (data: { agentId: string }) => {
    previousAgents.delete(data.agentId);
    statusBar?.removeAgent(data.agentId);
    webviewProvider?.removeAgent(data.agentId);
  });

  wsClient.connect();
}

export function deactivate(): void {
  wsClient?.dispose();
  stopServerIfLast();
}
