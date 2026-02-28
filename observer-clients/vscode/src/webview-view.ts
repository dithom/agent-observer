import * as vscode from "vscode";

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

type WebviewMessage =
  | { type: "focusAgent"; agentId: string; pid?: number; cwd?: string }
  | { type: "rename"; agentId: string };

export class AgentWebviewViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "agentObserver.agents";

  private agents: Map<string, AgentStatus> = new Map();
  private webviewView: vscode.WebviewView | undefined;
  private onFocusAgent: (agentId: string, pid?: number, cwd?: string) => void;
  private onRenameAgent: (agentId: string) => void;
  private disposables: vscode.Disposable[] = [];

  constructor(
    onFocusAgent: (agentId: string, pid?: number, cwd?: string) => void,
    onRenameAgent: (agentId: string) => void,
  ) {
    this.onFocusAgent = onFocusAgent;
    this.onRenameAgent = onRenameAgent;

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("agentObserver.groupByProject") || e.affectsConfiguration("agentObserver.moveInactiveToTop")) {
          this.postSettingsUpdate();
        }
      }),
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getFullHtml();

    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      switch (msg.type) {
        case "focusAgent": {
          this.onFocusAgent(msg.agentId, msg.pid, msg.cwd);
          break;
        }
        case "rename": {
          this.onRenameAgent(msg.agentId);
          break;
        }
      }
    });

    this.updateBadge();
    this.postSettingsUpdate();

    // Send current state to the freshly (re-)opened webview
    if (this.agents.size > 0) {
      this.postAgentsUpdate();
    }
  }

  setAgents(agents: AgentStatus[]): void {
    this.agents.clear();
    for (const agent of agents) {
      this.agents.set(agent.agentId, agent);
    }
    this.postAgentsUpdate();
    this.updateBadge();
  }

  updateAgent(agent: AgentStatus): void {
    this.agents.set(agent.agentId, agent);
    this.postAgentsUpdate();
    this.updateBadge();
  }

  removeAgent(agentId: string): void {
    this.agents.delete(agentId);
    this.postAgentsUpdate();
    this.updateBadge();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private postSettingsUpdate(): void {
    if (!this.webviewView) {
      return;
    }
    const config = vscode.workspace.getConfiguration("agentObserver");
    const groupByProject = config.get<boolean>("groupByProject", true);
    const moveInactiveToTop = config.get<boolean>("moveInactiveToTop", false);
    this.webviewView.webview.postMessage({ type: "updateSettings", groupByProject, moveInactiveToTop });
  }

  private postAgentsUpdate(): void {
    if (!this.webviewView) {
      return;
    }
    const agents = Array.from(this.agents.values());
    this.webviewView.webview.postMessage({ type: "updateAgents", agents });
  }

  private updateBadge(): void {
    if (!this.webviewView) {
      return;
    }
    const agents = Array.from(this.agents.values());
    const attentionCount = agents.filter(
      (a) => a.status === "waiting_for_user" || a.status === "error",
    ).length;
    this.webviewView.badge = attentionCount > 0
      ? { value: attentionCount, tooltip: `${attentionCount} agent(s) need attention` }
      : undefined;
  }

  private getFullHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    --status-running: #4caf50;
    --status-waiting: #ff9800;
    --status-error: #f44336;
    --status-idle: #9e9e9e;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 8px;
  }
  .empty {
    color: var(--vscode-descriptionForeground);
    padding: 16px 8px;
    text-align: center;
  }
  .project-group { margin-bottom: 8px; }
  .project-header {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    padding: 4px 0;
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
    user-select: none;
  }
  .project-header:hover { color: var(--vscode-foreground); }
  .chevron {
    display: inline-block;
    width: 16px;
    text-align: center;
    transition: transform 0.15s;
  }
  .chevron.collapsed { transform: rotate(-90deg); }
  .project-children { overflow: hidden; }
  .project-children.collapsed { display: none; }
  .card {
    border-left: 4px solid var(--status-idle);
    background: var(--vscode-editor-background);
    border-radius: 4px;
    padding: 8px 10px;
    margin: 4px 0;
    cursor: pointer;
    transition: background 0.1s, transform 0.25s ease, border-left-color 0.3s ease;
  }
  .card:hover { background: var(--vscode-list-hoverBackground); }
  .card.status-running { border-left-color: var(--status-running); }
  .card.status-waiting_for_user { border-left-color: var(--status-waiting); }
  .card.status-error { border-left-color: var(--status-error); }
  .card.status-idle { border-left-color: var(--status-idle); }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }
  .card-name {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }
  .edit-btn {
    opacity: 0;
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 14px;
    line-height: 1;
    flex-shrink: 0;
  }
  .card:hover .edit-btn { opacity: 0.6; }
  .edit-btn:hover { opacity: 1 !important; background: var(--vscode-toolbar-hoverBackground); }
  .card-status {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    transition: background 0.3s ease;
  }
  .status-dot.running { background: var(--status-running); }
  .status-dot.waiting_for_user { background: var(--status-waiting); }
  .status-dot.error { background: var(--status-error); }
  .status-dot.idle { background: var(--status-idle); }
  .card-project {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-top: 2px;
    display: none;
  }
  .status-text-wrap {
    position: relative;
    overflow: hidden;
    flex: 1;
  }
  .status-text {
    display: block;
  }
  @keyframes statusTextIn {
    from { opacity: 0; transform: translateY(100%); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes statusTextOut {
    from { opacity: 1; transform: translateY(0); }
    to { opacity: 0; transform: translateY(-100%); }
  }
  .status-text-in {
    animation: statusTextIn 0.25s ease both;
  }
  .status-text-out {
    position: absolute;
    top: 0;
    left: 0;
    animation: statusTextOut 0.25s ease both;
  }
  .card-time {
    display: none;
  }
  @keyframes cardEnter {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .card-enter {
    animation: cardEnter 0.25s ease both;
  }
  .card-exit {
    transition: opacity 0.2s ease, transform 0.2s ease, margin 0.2s ease, padding 0.2s ease, max-height 0.2s ease;
    opacity: 0;
    transform: translateY(-8px);
    max-height: 0 !important;
    margin: 0 !important;
    padding-top: 0 !important;
    padding-bottom: 0 !important;
    overflow: hidden;
    pointer-events: none;
  }
</style>
</head>
<body>
<div id="root"><div class="empty">No agents connected</div></div>
<script>
(function() {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  let agents = [];
  let collapsed = {};
  let groupByProject = false;
  let moveInactiveToTop = false;

  const STATUS_LABELS = {
    running: 'Running',
    waiting_for_user: 'Waiting for user',
    error: 'Error',
    idle: 'Idle'
  };

  function shortId(id) {
    return id.length > 12 ? id.substring(0, 8) : id;
  }

  function relativeTime(ts) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    return Math.floor(diff / 3600) + 'h ago';
  }

  function render() {
    if (agents.length === 0) {
      root.innerHTML = '<div class="empty">No agents connected</div>';
      return;
    }

    const empty = root.querySelector('.empty');
    if (empty) empty.remove();

    if (groupByProject) {
      renderGrouped();
    } else {
      renderFlat();
    }
  }

  function sortAgents(list) {
    if (!moveInactiveToTop) return list;
    return [...list].sort((a, b) => {
      const aInactive = a.status !== 'running' ? 0 : 1;
      const bInactive = b.status !== 'running' ? 0 : 1;
      if (aInactive !== bInactive) return aInactive - bInactive;
      return a.timestamp - b.timestamp;
    });
  }

  // FLIP animation: capture positions before DOM change, animate after
  function capturePositions(container) {
    const positions = new Map();
    for (const card of container.querySelectorAll('.card:not(.card-exit)')) {
      positions.set(card.dataset.agentId, card.getBoundingClientRect().top);
    }
    return positions;
  }

  function animateExit(card) {
    card.style.maxHeight = card.offsetHeight + 'px';
    requestAnimationFrame(() => {
      card.classList.add('card-exit');
    });
    card.addEventListener('transitionend', () => card.remove(), { once: true });
    // Fallback: remove after 300ms if transitionend doesn't fire
    setTimeout(() => { if (card.parentNode) card.remove(); }, 300);
  }

  function animateFlip(container, oldPositions) {
    for (const card of container.querySelectorAll('.card')) {
      const oldTop = oldPositions.get(card.dataset.agentId);
      if (oldTop === undefined) continue;
      const newTop = card.getBoundingClientRect().top;
      const delta = oldTop - newTop;
      if (delta === 0) continue;
      card.style.transition = 'none';
      card.style.transform = 'translateY(' + delta + 'px)';
      requestAnimationFrame(() => {
        card.style.transition = '';
        card.style.transform = '';
      });
    }
  }

  function renderGrouped() {
    // Group by project
    const groups = {};
    for (const a of agents) {
      (groups[a.projectName] = groups[a.projectName] || []).push(a);
    }
    const projectNames = Object.keys(groups).sort();

    // Build or update DOM
    const existingGroups = new Map();
    for (const el of root.querySelectorAll('.project-group')) {
      existingGroups.set(el.dataset.project, el);
    }

    // Remove groups that no longer exist
    for (const [name, el] of existingGroups) {
      if (!groups[name]) el.remove();
    }

    // Remove any flat-mode cards
    for (const card of root.querySelectorAll(':scope > .card')) {
      card.remove();
    }

    let prevEl = null;
    for (const project of projectNames) {
      let groupEl = existingGroups.get(project);
      if (!groupEl) {
        groupEl = createGroupEl(project);
        if (prevEl) {
          prevEl.after(groupEl);
        } else {
          root.innerHTML = '';
          root.appendChild(groupEl);
        }
      }
      updateGroupCards(groupEl, groups[project]);
      prevEl = groupEl;
    }
  }

  function renderFlat() {
    // Remove any grouped elements
    for (const el of root.querySelectorAll('.project-group')) {
      el.remove();
    }

    const sorted = sortAgents([...agents].sort((a, b) =>
      (a.projectName + displayName(a)).localeCompare(b.projectName + displayName(b))
    ));

    const existingCards = new Map();
    for (const card of root.querySelectorAll(':scope > .card')) {
      existingCards.set(card.dataset.agentId, card);
    }

    // Animate out cards for agents that no longer exist
    const agentIds = new Set(sorted.map(a => a.agentId));
    for (const [id, card] of existingCards) {
      if (!agentIds.has(id)) {
        existingCards.delete(id);
        animateExit(card);
      }
    }

    const oldPositions = capturePositions(root);

    for (const agent of sorted) {
      let card = existingCards.get(agent.agentId);
      if (!card) {
        card = createCard(agent);
      } else {
        updateCard(card, agent);
      }
      // Show project line in flat mode
      const projEl = card.querySelector('.card-project');
      if (projEl) projEl.style.display = 'block';
      root.appendChild(card);
    }

    animateFlip(root, oldPositions);
  }

  function createGroupEl(project) {
    const group = document.createElement('div');
    group.className = 'project-group';
    group.dataset.project = project;

    const header = document.createElement('div');
    header.className = 'project-header';
    const isCollapsed = collapsed[project] || false;
    header.innerHTML = '<span class="chevron' + (isCollapsed ? ' collapsed' : '') + '">&#9660;</span>' + escapeHtml(project);
    group.appendChild(header);

    const children = document.createElement('div');
    children.className = 'project-children' + (isCollapsed ? ' collapsed' : '');
    group.appendChild(children);

    header.addEventListener('click', () => {
      collapsed[project] = !collapsed[project];
      const chev = header.querySelector('.chevron');
      chev.classList.toggle('collapsed', collapsed[project]);
      children.classList.toggle('collapsed', collapsed[project]);
    });

    return group;
  }

  function updateGroupCards(groupEl, groupAgents) {
    const children = groupEl.querySelector('.project-children');
    const existingCards = new Map();
    for (const card of children.querySelectorAll('.card')) {
      existingCards.set(card.dataset.agentId, card);
    }

    // Animate out cards for agents that no longer exist
    for (const [id, card] of existingCards) {
      if (!groupAgents.find(a => a.agentId === id)) {
        existingCards.delete(id);
        animateExit(card);
      }
    }

    const oldPositions = capturePositions(children);
    const sorted = sortAgents(groupAgents);

    for (const agent of sorted) {
      let card = existingCards.get(agent.agentId);
      if (!card) {
        card = createCard(agent);
      } else {
        updateCard(card, agent);
      }
      children.appendChild(card);
    }

    animateFlip(children, oldPositions);
  }

  function createCard(agent) {
    const card = document.createElement('div');
    card.className = 'card status-' + agent.status + ' card-enter';
    card.addEventListener('animationend', () => card.classList.remove('card-enter'), { once: true });
    card.dataset.agentId = agent.agentId;
    card.dataset.status = agent.status;
    card.dataset.pid = agent.pid || '';
    card.dataset.cwd = agent.cwd || '';
    card.dataset.timestamp = agent.timestamp;

    card.innerHTML =
      '<div class="card-header">' +
        '<span class="card-name">' + escapeHtml(displayName(agent)) + '</span>' +
        '<button class="edit-btn" title="Rename">&#9998;</button>' +
      '</div>' +
      '<div class="card-project">' + escapeHtml(agent.projectName) + '</div>' +
      '<div class="card-status">' +
        '<span class="status-dot ' + agent.status + '"></span>' +
        '<span class="status-text-wrap"><span class="status-text">' + statusText(agent) + '</span></span>' +
      '</div>';

    card.addEventListener('click', (e) => {
      if (e.target.closest('.edit-btn')) return;
      vscode.postMessage({ type: 'focusAgent', agentId: agent.agentId, pid: agent.pid, cwd: agent.cwd });
    });
    card.querySelector('.edit-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'rename', agentId: agent.agentId });
    });

    return card;
  }

  function updateCard(card, agent) {
    const oldStatus = card.dataset.status || '';
    card.className = 'card status-' + agent.status;
    card.dataset.status = agent.status;
    card.dataset.pid = agent.pid || '';
    card.dataset.cwd = agent.cwd || '';
    card.dataset.timestamp = agent.timestamp;
    card.querySelector('.card-name').textContent = displayName(agent);
    card.querySelector('.card-project').textContent = agent.projectName;
    card.querySelector('.status-dot').className = 'status-dot ' + agent.status;

    const newText = statusText(agent);
    const wrap = card.querySelector('.status-text-wrap');
    const textEl = card.querySelector('.status-text');

    if (oldStatus && oldStatus !== agent.status && wrap) {
      // Animate: old text slides out up, new text slides in from below
      const oldEl = document.createElement('span');
      oldEl.className = 'status-text status-text-out';
      oldEl.textContent = textEl.textContent;
      wrap.appendChild(oldEl);
      oldEl.addEventListener('animationend', () => oldEl.remove(), { once: true });

      textEl.textContent = newText;
      textEl.classList.add('status-text-in');
      textEl.addEventListener('animationend', () => textEl.classList.remove('status-text-in'), { once: true });
    } else {
      textEl.textContent = newText;
    }
  }

  function statusText(agent) {
    if (agent.status === 'running') return STATUS_LABELS[agent.status];
    return STATUS_LABELS[agent.status] + ', ' + relativeTime(agent.timestamp);
  }

  function displayName(agent) {
    return agent.label || agent.client || shortId(agent.agentId);
  }

  function escapeHtml(str) {
    const d = document.createElement('span');
    d.textContent = str;
    return d.innerHTML;
  }

  // Update timestamps every 10 seconds
  setInterval(() => {
    for (const card of root.querySelectorAll('.card')) {
      if (!card.dataset.timestamp) continue;
      const isRunning = card.classList.contains('status-running');
      const textEl = card.querySelector('.status-text');
      if (!textEl) continue;
      const label = isRunning ? 'Running' : textEl.textContent.split(',')[0];
      textEl.textContent = isRunning ? label : label + ', ' + relativeTime(Number(card.dataset.timestamp));
    }
  }, 10000);

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'updateAgents') {
      agents = msg.agents;
      render();
    } else if (msg.type === 'updateSettings') {
      groupByProject = msg.groupByProject;
      moveInactiveToTop = msg.moveInactiveToTop;
      root.innerHTML = '';
      render();
    }
  });
})();
</script>
</body>
</html>`;
  }
}
