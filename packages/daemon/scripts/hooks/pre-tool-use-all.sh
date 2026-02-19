#!/bin/bash
# Hook: PreToolUse (all tools, no matcher)
# 1. Write generic tool signal: <sid>.tool.<tool_use_id>.json
# 2. If Task tool, also write task signal: <sid>.task.<tool_use_id>.json

SIGNALS_DIR="$HOME/.claude/session-signals"
mkdir -p "$SIGNALS_DIR"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // empty')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

if [ -n "$SESSION_ID" ] && [ -n "$TOOL_USE_ID" ]; then
  # Generic tool signal for all tools
  echo "$INPUT" | jq -c '{
    session_id: .session_id,
    tool_use_id: .tool_use_id,
    tool_name: .tool_name,
    tool_input: .tool_input,
    started_at: (now | tostring)
  }' > "$SIGNALS_DIR/$SESSION_ID.tool.$TOOL_USE_ID.json"

  # Task-specific signal for subagent tracking
  if [ "$TOOL_NAME" = "Task" ]; then
    echo "$INPUT" | jq -c '{
      session_id: .session_id,
      tool_use_id: .tool_use_id,
      agent_type: .tool_input.subagent_type,
      description: .tool_input.description,
      started_at: (now | tostring)
    }' > "$SIGNALS_DIR/$SESSION_ID.task.$TOOL_USE_ID.json"
  fi
fi
