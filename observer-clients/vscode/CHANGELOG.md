# Changelog

## 0.3.0 — 2026-02-27

- Replace TreeView with WebviewView cards (colored border = status, grouped by project, collapsible)
- Add task labels: rename agents via edit icon on cards, persisted across status updates
- New server endpoint `PATCH /api/status/:agentId/label` for label management
- Status bar shows task label as display name
- Badge on sidebar icon for agents needing attention (waiting/error)
- Client-side timestamp refresh every 10 seconds

## 0.2.0 — 2026-02-27

- Focus agent terminal or Claude Code panel on click (not just the window)
- Bidirectional WebSocket communication for cross-window focus requests
- Terminal matching via process tree ancestry (agent PID → shell PID)
- Claude Code GUI panel focus as fallback when no terminal PID is available

## 0.1.2 — 2026-02-27

- Add plugin requirement notice to README
- Move requirements section before features
- Fix .DS_Store leaking into vsix package

## 0.1.1 — 2026-02-27

- Fix image paths in README for VS Code Marketplace

## 0.1.0 — 2026-02-27

- Initial release
- Real-time monitoring of AI agents across VS Code windows
- Sidebar TreeView grouped by project
- Status Bar with aggregated agent status
- Automatic server lifecycle management
- Click-to-focus: jump to the VS Code window where an agent is running
