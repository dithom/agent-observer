# Agent Observer

## Sprache

- Kommunikation mit dem Entwickler: **Deutsch**
- Code, Commits, API-Responses, UI-Texte, Logs: **Englisch**

## Projektstruktur

Monorepo mit npm workspaces:

```
server/                          # Node.js HTTP + WebSocket Server (Express, ws)
observer-clients/vscode/         # VS Code Extension (TreeView, StatusBar, WebSocket-Client)
agent-plugins/claude-code/       # Claude Code Plugin (Shell-Hook → POST /api/status)
```

## Build

```bash
npm install                      # Installiert alle Workspaces
npm run build -w server          # Baut den Server (esbuild → server/dist/)
npm run build -w observer-clients/vscode  # Baut die VS Code Extension (esbuild → observer-clients/vscode/dist/)
```

TypeScript-Konfiguration: Gemeinsame `tsconfig.json` im Root, Workspaces erweitern per `extends`.

## Architektur

```
Agent-Plugins  →  POST /api/status  →  Server (Port dynamisch, Lock-File ~/.agent-observer/server.lock)
                                          ↓ WebSocket /ws
                                    Observer-Clients (Snapshot bei Connect, dann Updates)
```

- **Server**: In-Memory Store (`Map<agentId, AgentStatus>`), Stale-Cleanup per PID-Check oder Timeout
- **Agent-Plugins**: Fire-and-forget HTTP POSTs, dürfen niemals den Agenten blockieren (async hooks, `exit 0`)
- **Observer-Clients**: Verbinden sich per WebSocket, empfangen Snapshot + laufende Updates

## Versionierung

Jede Komponente wird unabhängig versioniert (SemVer):

- **Server** (`server/package.json` + `VERSION` in `src/app.ts`) — eigener Kern, wird auch in die VS Code Extension gebundelt
- **Observer-Clients** (z.B. `observer-clients/vscode/package.json`) — je nach Plattform eigenes Release
- **Agent-Plugins** (z.B. `agent-plugins/claude-code/.claude-plugin/plugin.json`) — eigenes Release

Versionen bumpen: `package.json` des jeweiligen Workspace. Beim Server zusätzlich `VERSION` in `src/app.ts`.

Git-Tags pro Komponente: `vscode/v0.1.1`, `server/v0.1.0`, `plugin-claude-code/v0.1.0`.

## Git Flow & Release

Branching: `develop` (Arbeitsbranch) → `main` (Release).

### Release-Schritte (pro Komponente)

1. Auf `develop`: Version bumpen, CHANGELOG aktualisieren, committen, pushen
2. `git checkout main && git merge develop --no-ff -m "release(<komponente>): v<version>"`
3. `git tag -a <prefix>/v<version> -m "<prefix>/v<version>"`
4. `git push origin main --tags`
5. `git checkout develop`

### VS Code Extension zusätzlich

- `.vsix` bauen: `npm run build -w server && npm run build -w observer-clients/vscode && cd observer-clients/vscode && npx @vscode/vsce package`
- Upload auf VS Code Marketplace manuell
- CHANGELOG: `observer-clients/vscode/CHANGELOG.md`

### Claude Code Plugin

- Wird über GitHub Repo verteilt (`claude plugin add dithom/agent-observer`)
- Release = Merge nach `main` (kein separater Build nötig)

## Konventionen

- Builds laufen über esbuild (nicht tsc) — siehe `build.js` in jedem Workspace
- Server lauscht auf Port 0 (OS-assigned), schreibt Port in Lock-File
- Hook-Scripts müssen immer mit Exit-Code 0 enden
- Keine externen Datenbanken — alles in-memory
