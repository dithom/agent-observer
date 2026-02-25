#!/usr/bin/env bash
# Agent Observer Hook Script
# Sends agent status updates to the Agent Observer server.
# Called by Claude Code hooks with status as $1 and JSON context on stdin.
# Always exits 0 to never block Claude Code.

set -euo pipefail

STATUS="${1:-}"
LOCK_FILE="$HOME/.agent-observer/server.lock"
LOG_FILE="$HOME/.agent-observer/hook-debug.log"

# Read JSON from stdin
INPUT="$(cat)"

# Debug logging (remove once hooks are verified)
mkdir -p "$(dirname "$LOG_FILE")"
echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] status=$STATUS input=$INPUT" >> "$LOG_FILE" 2>/dev/null || true

# Extract session_id and cwd from stdin JSON
SESSION_ID="$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)"
CWD="$(echo "$INPUT" | grep -o '"cwd":"[^"]*"' | head -1 | cut -d'"' -f4)"

# Derive project name from cwd
PROJECT_NAME="$(basename "$CWD")"

# Walk up the process tree to find the actual Claude Code process.
# Check both short name (comm) and full command line for portability —
# claude may appear as native binary "claude" or as "node /path/to/claude".
AGENT_PID=""
_pid=$$
while [ "$_pid" -gt 1 ] 2>/dev/null; do
  _pid="$(ps -o ppid= -p "$_pid" 2>/dev/null | tr -d ' ')" || break
  [ -z "$_pid" ] && break
  _comm="$(ps -o comm= -p "$_pid" 2>/dev/null)" || break
  case "$_comm" in
    *claude*) AGENT_PID="$_pid"; break ;;
  esac
  # Fallback: check full command line (covers "node /path/to/claude")
  _args="$(ps -o args= -p "$_pid" 2>/dev/null)" || continue
  case "$_args" in
    *claude*) AGENT_PID="$_pid"; break ;;
  esac
done

# Bail if no session_id
if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# Read port from lock file
if [ ! -f "$LOCK_FILE" ]; then
  exit 0
fi

PORT="$(grep -o '"port" *: *[0-9]*' "$LOCK_FILE" | head -1 | grep -o '[0-9]*')"

if [ -z "$PORT" ]; then
  exit 0
fi

BASE_URL="http://localhost:${PORT}"

if [ "$STATUS" = "delete" ]; then
  curl -s -X DELETE "${BASE_URL}/api/status/${SESSION_ID}" --max-time 2 > /dev/null 2>&1 || true
else
  curl -s -X POST "${BASE_URL}/api/status" \
    -H "Content-Type: application/json" \
    -d "{\"agentId\":\"${SESSION_ID}\",\"status\":\"${STATUS}\",\"projectName\":\"${PROJECT_NAME}\",\"client\":\"claude-code\",\"cwd\":\"${CWD}\",\"pid\":${AGENT_PID:-null}}" \
    --max-time 2 > /dev/null 2>&1 || true
fi

exit 0
