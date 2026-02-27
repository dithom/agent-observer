import * as vscode from "vscode";

interface AgentStatus {
  agentId: string;
  status: "running" | "waiting_for_user" | "idle" | "error";
  projectName: string;
  client?: string;
  cwd?: string;
  pid?: number;
  timestamp: number;
}

const PRIORITY = 100;

interface StatusStyle {
  backgroundColor?: vscode.ThemeColor;
  color?: vscode.ThemeColor;
}

function statusStyle(status: string): StatusStyle {
  switch (status) {
    case "running":
      return { color: new vscode.ThemeColor("charts.green") };
    case "waiting_for_user":
      return { backgroundColor: new vscode.ThemeColor("statusBarItem.warningBackground") };
    case "error":
      return { backgroundColor: new vscode.ThemeColor("statusBarItem.errorBackground") };
    default:
      return {};
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case "running":
      return "$(play)";
    case "waiting_for_user":
      return "$(bell)";
    case "error":
      return "$(error)";
    case "idle":
      return "$(circle-outline)";
    default:
      return "$(question)";
  }
}

function relativeTime(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 60) { return `${diff}s ago`; }
  if (diff < 3600) { return `${Math.floor(diff / 60)}m ago`; }
  return `${Math.floor(diff / 3600)}h ago`;
}

export class StatusBar {
  private toggleItem: vscode.StatusBarItem;
  private extraItems: vscode.StatusBarItem[] = [];
  private agents: Map<string, AgentStatus> = new Map();
  private connected = false;
  private expanded = false;
  private toggleDisposable: vscode.Disposable;

  constructor() {
    this.toggleItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, PRIORITY);
    this.toggleItem.command = "agentObserver.toggle";
    this.toggleDisposable = vscode.commands.registerCommand("agentObserver.toggle", () => {
      this.expanded = !this.expanded;
      this.update();
    });
    this.update();
    this.toggleItem.show();
  }

  setAgents(agents: AgentStatus[]): void {
    this.agents.clear();
    for (const agent of agents) {
      this.agents.set(agent.agentId, agent);
    }
    this.update();
  }

  updateAgent(agent: AgentStatus): void {
    this.agents.set(agent.agentId, agent);
    this.update();
  }

  removeAgent(agentId: string): void {
    this.agents.delete(agentId);
    this.update();
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    this.update();
  }

  private update(): void {
    for (const item of this.extraItems) {
      item.dispose();
    }
    this.extraItems = [];

    if (!this.connected) {
      this.toggleItem.text = "$(alert) Server offline";
      this.toggleItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      this.toggleItem.tooltip = "Agent Observer: Server not reachable";
      return;
    }

    const agents = Array.from(this.agents.values());

    if (agents.length === 0) {
      this.toggleItem.text = "$(eye) No agents";
      this.toggleItem.backgroundColor = undefined;
      this.toggleItem.color = undefined;
      this.toggleItem.tooltip = "Agent Observer: No agents connected";
      this.expanded = false;
      return;
    }

    const chevron = this.expanded ? "$(chevron-down)" : "$(chevron-right)";
    const errorCount = agents.filter((a) => a.status === "error").length;
    const waitingCount = agents.filter((a) => a.status === "waiting_for_user").length;
    const runningCount = agents.filter((a) => a.status === "running").length;

    this.toggleItem.text = `$(eye) ${agents.length} agent${agents.length !== 1 ? "s" : ""} ${chevron}`;
    this.toggleItem.color = undefined;
    if (errorCount > 0) {
      this.toggleItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else if (waitingCount > 0) {
      this.toggleItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else if (runningCount > 0) {
      this.toggleItem.backgroundColor = undefined;
      this.toggleItem.color = new vscode.ThemeColor("charts.green");
    } else {
      this.toggleItem.backgroundColor = undefined;
    }
    this.toggleItem.tooltip = `Agent Observer: ${runningCount} running, ${waitingCount} waiting, ${errorCount} error\nClick to ${this.expanded ? "collapse" : "expand"}`;

    if (this.expanded) {
      const byProject = new Map<string, AgentStatus[]>();
      for (const agent of agents) {
        const list = byProject.get(agent.projectName) || [];
        list.push(agent);
        byProject.set(agent.projectName, list);
      }

      let idx = 0;
      for (const [project, projectAgents] of byProject) {
        const label = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, PRIORITY - 1 - idx);
        label.text = `$(folder) ${project}:`;
        label.tooltip = `Project: ${project}`;
        label.show();
        this.extraItems.push(label);
        idx++;

        for (const agent of projectAgents) {
          const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, PRIORITY - 1 - idx);
          const displayName = agent.client || agent.agentId.substring(0, 8);
          item.text = `${statusIcon(agent.status)} ${displayName}`;
          const style = statusStyle(agent.status);
          item.backgroundColor = style.backgroundColor;
          item.color = style.color;

          if (agent.cwd) {
            item.command = { title: "Focus Window", command: "agentObserver.focusWindow", arguments: [agent.agentId, agent.pid, agent.cwd] };
            item.tooltip = `${displayName}\n${agent.projectName} — ${agent.status}\n${relativeTime(agent.timestamp)}\nClick to focus window`;
          } else {
            item.tooltip = `${displayName}\n${agent.projectName} — ${agent.status}\n${relativeTime(agent.timestamp)}`;
          }

          item.show();
          this.extraItems.push(item);
          idx++;
        }
      }
    }
  }

  dispose(): void {
    this.toggleItem.dispose();
    for (const item of this.extraItems) {
      item.dispose();
    }
    this.toggleDisposable.dispose();
  }
}
