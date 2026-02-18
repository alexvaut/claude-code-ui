#!/bin/bash
# Hook script for PostToolUse events (matcher: "Task")
# Removes active agent signal when subagent completes

SIGNALS_DIR="$HOME/.claude/session-signals"

# Read JSON from stdin
INPUT=$(cat)

# Extract session_id and tool_use_id
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // empty')

if [ -n "$SESSION_ID" ] && [ -n "$TOOL_USE_ID" ]; then
  rm -f "$SIGNALS_DIR/$SESSION_ID.task.$TOOL_USE_ID.json"
fi
