#!/bin/bash
# Hook script for PreCompact events
# Writes compacting signal to ~/.claude/session-signals/<session_id>.compacting.json
# This allows the daemon to detect when context compaction is in progress

SIGNALS_DIR="$HOME/.claude/session-signals"
mkdir -p "$SIGNALS_DIR"

# Read JSON from stdin
INPUT=$(cat)

# Extract session_id
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

if [ -n "$SESSION_ID" ]; then
  echo "$INPUT" | jq -c '{
    session_id: .session_id,
    started_at: (now | tostring)
  }' > "$SIGNALS_DIR/$SESSION_ID.compacting.json"
fi
