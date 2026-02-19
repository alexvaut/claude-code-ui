#!/bin/bash
# Diagnostic: log ALL hook events with timestamps
# Uses the common input fields available to every hook + tool_name where available
# Exits 0 with no stdout to avoid interfering with Claude Code behavior
LOG_FILE="$HOME/.claude/session-signals/hook-debug.log"
INPUT=$(cat)
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "unknown"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "n/a"')
PERM_MODE=$(echo "$INPUT" | jq -r '.permission_mode // "n/a"')
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // empty')
REASON=$(echo "$INPUT" | jq -r '.reason // empty')
SOURCE=$(echo "$INPUT" | jq -r '.source // empty')
EXTRA=""
[ -n "$AGENT_TYPE" ] && EXTRA="$EXTRA  agent_type=$AGENT_TYPE"
[ -n "$REASON" ] && EXTRA="$EXTRA  reason=$REASON"
[ -n "$SOURCE" ] && EXTRA="$EXTRA  source=$SOURCE"
echo "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)  $EVENT  session=${SESSION_ID:0:8}  tool=$TOOL_NAME  mode=$PERM_MODE$EXTRA" >> "$LOG_FILE"
exit 0
