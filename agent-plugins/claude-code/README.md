# Agent Observer — Claude Code Plugin

Reports Claude Code agent status to the [Agent Observer](https://github.com/dithom/agent-observer) server for real-time monitoring in VS Code.

## Installation

```bash
claude plugin marketplace add dithom/agent-observer
claude plugin install agent-observer@agent-observer
```

## What It Does

The plugin uses Claude Code's hook system to report status changes:

| Event | Reported Status |
|---|---|
| Session start | Waiting for user |
| Prompt submitted | Running |
| Permission request | Waiting for user |
| Tool executed | Running |
| Agent stopped | Waiting for user |
| Session end | Agent removed |

All status updates are fire-and-forget — the plugin never blocks Claude Code.

## Requirements

- [Agent Observer VS Code Extension](https://marketplace.visualstudio.com/items?itemName=dithom.agent-observer-vscode) (manages the server automatically)
