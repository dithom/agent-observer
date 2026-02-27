# Agent Observer

Real-time monitoring of AI agents across projects and VS Code windows. See at a glance which agents are running, waiting for input, or have errors.

## Installation

### 1. VS Code Extension

Install **Agent Observer** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=dithom.agent-observer-vscode).

The extension manages the observer server automatically — no separate setup needed.

### 2. Claude Code Plugin

```bash
claude plugin add dithom/agent-observer
```

That's it. The plugin reports agent status via Claude Code's hook system.

## How It Works

```
Claude Code Plugin  →  POST /api/status  →  Server  →  WebSocket  →  VS Code Extension
```

- **Claude Code Plugin** reports status changes (running, waiting, error) via hooks
- **Server** collects status from all agents (managed automatically by the VS Code extension)
- **VS Code Extension** displays agent status in the sidebar and status bar

## Features

- Sidebar TreeView grouped by project with live status
- Status Bar showing aggregated agent state
- Click-to-focus: jump to the VS Code window where an agent is running
- Automatic server lifecycle — starts on demand, stops when no clients remain

## Requirements

- VS Code `code` CLI — needed for click-to-focus. Install via: `Cmd+Shift+P` → "Shell Command: Install 'code' command in PATH"

## Development

```bash
npm install
npm run build -w server
npm run build -w observer-clients/vscode
```

## License

[MIT](LICENSE)
