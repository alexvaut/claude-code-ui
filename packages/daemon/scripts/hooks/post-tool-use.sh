#!/bin/bash
# Hook: PostToolUse (all tools, no matcher)
# 1. Delete permission.json (tool succeeded or was approved -> no longer needs approval)
# 2. Delete tool signal file for this specific tool_use_id
# 3. If the tool is Task, delete the task signal file

SIGNALS_DIR="$HOME/.claude/session-signals"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // empty')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

if [ -n "$SESSION_ID" ]; then
  # Always clear permission — this tool completed (auto-approved or user-approved)
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
