#!/bin/bash
# Hook: PostToolUseFailure (all tools, no matcher)
# Same cleanup as PostToolUse — user denied or tool failed

SIGNALS_DIR="$HOME/.claude/session-signals"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // empty')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

if [ -n "$SESSION_ID" ]; then
  # Always clear permission — this tool completed (denied or failed)
  rm -f "$SIGNALS_DIR/$SESSION_ID.permission.json"

  # Clear tool signal for this specific tool_use_id
  if [ -n "$TOOL_USE_ID" ]; then
    rm -f "$SIGNALS_DIR/$SESSION_ID.tool.$TOOL_USE_ID.json"
    # Also remove task signal if this was a Task tool
    if [ "$TOOL_NAME" = "Task" ]; then
      rm -f "$SIGNALS_DIR/$SESSION_ID.task.$TOOL_USE_ID.json"
    fi
  fi
fi
