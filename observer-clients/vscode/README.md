# Agent Observer — VS Code Extension

Real-time monitoring of AI agents across projects and VS Code windows.

## Features

- **Sidebar TreeView** — See all running agents grouped by project, with live status and relative timestamps
- **Status Bar** — Aggregated status at a glance (running, waiting, error)
- **Click to Focus** — Click an agent to jump to its VS Code window
- **Automatic Server** — The extension manages the observer server automatically, no setup needed

### Sidebar

![Sidebar TreeView with agents grouped by project](https://raw.githubusercontent.com/dithom/agent-observer/main/observer-clients/vscode/docs/sidebar.jpg)

### Status Bar

![Status Bar — all agents running](https://raw.githubusercontent.com/dithom/agent-observer/main/observer-clients/vscode/docs/status-bar__working-expanded.jpg)

![Status Bar — agent waiting for user](https://raw.githubusercontent.com/dithom/agent-observer/main/observer-clients/vscode/docs/status-bar__waiting-expanded.jpg)

![Status Bar — collapsed](https://raw.githubusercontent.com/dithom/agent-observer/main/observer-clients/vscode/docs/status-bar__working-collapsed.jpg)

## Status Icons

| Status | Icon | Meaning |
|---|---|---|
| Running | Green dot | Agent is actively working |
| Waiting | Orange ring | Agent needs your input |
| Idle | Grey dot | Agent is inactive |
| Error | Red X | Agent encountered an error |

## Setup

1. Install this extension from the VS Code Marketplace
2. Install an agent plugin (e.g. [Claude Code Plugin](https://github.com/dithom/agent-observer))
3. The extension activates automatically and starts monitoring

## Requirements

- VS Code `code` CLI — required for "click to focus" feature. Install via: `Cmd+Shift+P` → "Shell Command: Install 'code' command in PATH"
