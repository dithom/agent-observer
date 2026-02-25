# Agent Observer

Real-time monitoring of AI agents across projects and VS Code windows.

## Prerequisites

- **Node.js** >= 18
- **VS Code `code` CLI** — required for "click to focus window" feature. Install via VS Code: `Cmd+Shift+P` → "Shell Command: Install 'code' command in PATH"

## Setup

```bash
npm install
npm run build -w server
npm run build -w observer-clients/vscode
```

### VS Code Extension

Symlink for local development:

```bash
ln -s <repo>/observer-clients/vscode ~/.vscode/extensions/agent-observer-vscode
```

### Claude Code Plugin

Add to your shell profile (e.g. `~/.zshrc`):

```bash
alias claude='claude --plugin-dir <repo>/agent-plugins/claude-code'
```

## Architecture

```
Agent Plugins (producers)  →  Server (HTTP/WS)  →  Observer Clients (consumers)
    Claude Code hook             In-memory store       VS Code Extension
    POST /api/status             WebSocket push        Status Bar + Sidebar
```
