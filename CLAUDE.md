# Agent Observer

## Language

- Communication with the developer: **German**
- Code, commits, API responses, UI text, logs: **English**

## Project Structure

Monorepo with npm workspaces:

```
server/                          # Node.js HTTP + WebSocket Server (Express, ws)
observer-clients/vscode/         # VS Code Extension (TreeView, StatusBar, WebSocket Client)
agent-plugins/claude-code/       # Claude Code Plugin (Shell Hook → POST /api/status)
```

## Build

```bash
npm install                      # Install all workspaces
npm run build -w server          # Build server (esbuild → server/dist/)
npm run build -w observer-clients/vscode  # Build VS Code Extension (esbuild → observer-clients/vscode/dist/)
```

TypeScript config: shared `tsconfig.json` in root, workspaces extend via `extends`.

## Architecture

```
Agent Plugins  →  POST /api/status  →  Server (dynamic port, lock file ~/.agent-observer/server.lock)
                                          ↓ WebSocket /ws
                                    Observer Clients (snapshot on connect, then updates)
```

- **Server**: In-memory store (`Map<agentId, AgentStatus>`), stale cleanup via PID check or timeout
- **Agent Plugins**: Fire-and-forget HTTP POSTs, must never block the agent (async hooks, `exit 0`)
- **Observer Clients**: Connect via WebSocket, receive snapshot + live updates

## Versioning

Each component is versioned independently (SemVer):

- **Server** (`server/package.json` + `VERSION` in `src/app.ts`) — core component, also bundled into the VS Code Extension
- **Observer Clients** (e.g. `observer-clients/vscode/package.json`) — separate release per platform
- **Agent Plugins** (e.g. `agent-plugins/claude-code/.claude-plugin/plugin.json`) — separate release

Version bump: `package.json` of the respective workspace. For the server, also update `VERSION` in `src/app.ts`.

Git tags mirror directory structure: `server/v0.1.0`, `observer-clients/vscode/v0.1.2`, `agent-plugins/claude-code/v0.1.1`.

## Git Flow & Release

Branching: `develop` (working branch) → `main` (release).

### Release Steps (per component)

1. On `develop`: bump version, update CHANGELOG, commit, push
2. `git checkout main && git merge develop --no-ff -m "release(<component>): v<version>"`
3. `git tag -a <prefix>/v<version> -m "<prefix>/v<version>"`
4. `git push origin main --tags`
5. `git checkout develop`

### VS Code Extension (additional)

- Build `.vsix`: `npm run build -w server && npm run build -w observer-clients/vscode && cd observer-clients/vscode && npx @vscode/vsce package`
- Upload to VS Code Marketplace manually
- CHANGELOG: `observer-clients/vscode/CHANGELOG.md`

### Claude Code Plugin

- Distributed via GitHub repo (`claude plugin add dithom/agent-observer`)
- Release = merge to `main` (no separate build needed)

## Conventions

- Builds use esbuild (not tsc) — see `build.js` in each workspace
- Server listens on port 0 (OS-assigned), writes port to lock file
- Hook scripts must always exit with code 0
- No external databases — everything in-memory
