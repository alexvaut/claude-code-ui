#!/bin/bash
# Hook script for PreToolUse events (matcher: "Task")
# Writes active agent info to ~/.claude/session-signals/<session_id>.task.<tool_use_id>.json
# This allows the daemon to detect when subagents are spawned

SIGNALS_DIR="$HOME/.claude/session-signals"
mkdir -p "$SIGNALS_DIR"

# Read JSON from stdin
INPUT=$(cat)

# Extract session_id and tool_use_id
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // empty')

if [ -n "$SESSION_ID" ] && [ -n "$TOOL_USE_ID" ]; then
  echo "$INPUT" | jq -c '{
    session_id: .session_id,
    tool_use_id: .tool_use_id,
    agent_type: .tool_input.subagent_type,
    description: .tool_input.description,
    started_at: (now | tostring)
  }' > "$SIGNALS_DIR/$SESSION_ID.task.$TOOL_USE_ID.json"
fi
