#!/bin/bash
# Forward Claude Code hook payload to the daemon via HTTP.
# All hook events (UserPromptSubmit, PermissionRequest, PreToolUse, PostToolUse,
# PostToolUseFailure, Stop, SessionEnd, PreCompact) use this same script.
# The daemon reads hook_event_name from the JSON and handles state transitions.

DAEMON_URL="http://127.0.0.1:4451/hook"
HOOK_ERROR_LOG="$HOME/.claude/session-signals/hook-errors.log"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
[ -z "$SESSION_ID" ] && exit 0

if ! curl -sf --max-time 2 -H "Content-Type: application/json" \
     -d "$INPUT" "$DAEMON_URL" > /dev/null 2>&1; then
  # Cap error log at ~100KB to prevent unbounded growth
  if [ -f "$HOOK_ERROR_LOG" ] && [ "$(wc -c < "$HOOK_ERROR_LOG" 2>/dev/null || echo 0)" -gt 102400 ]; then
    tail -100 "$HOOK_ERROR_LOG" > "$HOOK_ERROR_LOG.tmp" 2>/dev/null \
      && mv "$HOOK_ERROR_LOG.tmp" "$HOOK_ERROR_LOG" 2>/dev/null
  fi
  mkdir -p "$(dirname "$HOOK_ERROR_LOG")" 2>/dev/null
  HOOK_NAME=$(echo "$INPUT" | jq -r '.hook_event_name // "unknown"')
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)  FAIL  $HOOK_NAME  $SESSION_ID" >> "$HOOK_ERROR_LOG" 2>/dev/null
fi
