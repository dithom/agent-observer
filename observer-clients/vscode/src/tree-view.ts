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

type TreeItem = ProjectNode | AgentNode | PlaceholderNode;

class ProjectNode extends vscode.TreeItem {
  constructor(public readonly projectName: string) {
    super(projectName, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "project";
  }
}

class AgentNode extends vscode.TreeItem {
  constructor(public readonly agent: AgentStatus) {
    super(agent.agentId, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "agent";
    this.update(agent);
  }

  update(agent: AgentStatus): void {
    const timeAgo = relativeTime(agent.timestamp);
    const displayName = agent.client || shortId(agent.agentId);
    this.label = displayName;
    this.description = `${agent.status}  ${timeAgo}`;
    this.iconPath = statusThemeIcon(agent.status);
    this.tooltip = `Agent: ${agent.agentId}\nClient: ${agent.client || "unknown"}\nStatus: ${agent.status}\nProject: ${agent.projectName}\nLast update: ${timeAgo}`;
    if (agent.cwd) {
      this.command = { title: "Focus Window", command: "agentObserver.focusWindow", arguments: [agent.agentId, agent.pid, agent.cwd] };
    }
  }
}

class PlaceholderNode extends vscode.TreeItem {
  constructor() {
    super("No agents connected", vscode.TreeItemCollapsibleState.None);
    this.contextValue = "placeholder";
  }
}

function shortId(id: string): string {
  return id.length > 12 ? id.substring(0, 8) : id;
}

function statusThemeIcon(status: string): vscode.ThemeIcon {
  switch (status) {
    case "running":
      return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"));
    case "waiting_for_user":
      return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.yellow"));
    case "idle":
      return new vscode.ThemeIcon("circle-outline", new vscode.ThemeColor("charts.gray"));
    case "error":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
    default:
      return new vscode.ThemeIcon("question");
  }
}

function relativeTime(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 60) {
    return `${diff}s ago`;
  }
  if (diff < 3600) {
    return `${Math.floor(diff / 60)}m ago`;
  }
  return `${Math.floor(diff / 3600)}h ago`;
}

export class AgentTreeDataProvider implements vscode.TreeDataProvider<TreeItem> {
  private agents: Map<string, AgentStatus> = new Map();
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Refresh timestamps every 10 seconds
    this.refreshTimer = setInterval(() => {
      if (this.agents.size > 0) {
        this._onDidChangeTreeData.fire(undefined);
      }
    }, 10000);
  }

  setAgents(agents: AgentStatus[]): void {
    this.agents.clear();
    for (const agent of agents) {
      this.agents.set(agent.agentId, agent);
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  updateAgent(agent: AgentStatus): void {
    this.agents.set(agent.agentId, agent);
    this._onDidChangeTreeData.fire(undefined);
  }

  removeAgent(agentId: string): void {
    this.agents.delete(agentId);
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (!element) {
      // Root level: group by project
      if (this.agents.size === 0) {
        return [new PlaceholderNode()];
      }

      const projects = new Map<string, AgentStatus[]>();
      for (const agent of this.agents.values()) {
        const list = projects.get(agent.projectName) || [];
        list.push(agent);
        projects.set(agent.projectName, list);
      }

      return Array.from(projects.keys())
        .sort()
        .map((name) => new ProjectNode(name));
    }

    if (element instanceof ProjectNode) {
      return Array.from(this.agents.values())
        .filter((a) => a.projectName === element.projectName)
        .map((a) => new AgentNode(a));
    }

    return [];
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    this._onDidChangeTreeData.dispose();
  }
}
