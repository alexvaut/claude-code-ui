#!/bin/bash
# Setup script for claude-code-ui daemon hooks
# Installs hooks for accurate session state detection:
# - UserPromptSubmit: detect when user starts a turn (working)
# - PermissionRequest: detect when waiting for user approval
# - Stop: detect when Claude finishes responding (waiting)
# - SessionEnd: detect when session closes (idle)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETTINGS_FILE="$HOME/.claude/settings.json"
SIGNALS_DIR="$HOME/.claude/session-signals"

echo "Setting up claude-code-ui hooks..."

# Create signals directory
mkdir -p "$SIGNALS_DIR"
echo "Created $SIGNALS_DIR"

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "Error: jq is required but not installed."
    echo "Install with: brew install jq (macOS) or apt install jq (Linux)"
    exit 1
fi

# Check if settings.json exists
if [ ! -f "$SETTINGS_FILE" ]; then
    echo "Creating new settings.json..."
    echo '{}' > "$SETTINGS_FILE"
fi

# Backup settings
cp "$SETTINGS_FILE" "$SETTINGS_FILE.backup"
echo "Backed up settings to $SETTINGS_FILE.backup"

# Build the hooks configuration
# UserPromptSubmit: write working signal when user starts turn
USER_PROMPT_HOOK="$SCRIPT_DIR/hooks/user-prompt-submit.sh"
# PermissionRequest: write pending permission file
PERMISSION_HOOK="$SCRIPT_DIR/hooks/permission-request.sh"
# Stop: write turn-ended signal
STOP_HOOK="$SCRIPT_DIR/hooks/stop.sh"
# SessionEnd: write session-ended signal
SESSION_END_HOOK="$SCRIPT_DIR/hooks/session-end.sh"
# PreToolUse (Task): write active agent signal when subagent spawns
TASK_START_HOOK="$SCRIPT_DIR/hooks/task-start.sh"
# PostToolUse (Task): remove agent signal when subagent completes
TASK_END_HOOK="$SCRIPT_DIR/hooks/task-end.sh"
# PreCompact: write compacting signal when context compaction starts
COMPACT_START_HOOK="$SCRIPT_DIR/hooks/compact-start.sh"

# Helper: upsert a hook entry — replaces existing entry with matching command prefix, or appends
# Usage: upsert_hook <hook_type> <matcher> <command>
# This preserves existing hooks from other tools (e.g., Claude-Code-Remote)
upsert_hook() {
  local hook_type="$1" matcher="$2" command="$3"
  local entry="{\"matcher\": \"$matcher\", \"hooks\": [{\"type\": \"command\", \"command\": \"$command\"}]}"
  # Use a relative marker for matching — MSYS on Windows converts /c/... to C:/... in --arg,
  # breaking startswith. "packages/daemon/scripts/hooks/" is safe and unique.
  local marker="packages/daemon/scripts/hooks/"

  jq --arg type "$hook_type" --arg marker "$marker" --argjson entry "$entry" '
    .hooks[$type] //= [] |
    # Remove any existing entry whose command contains our marker
    .hooks[$type] = [.hooks[$type][] | select(.hooks[0].command | contains($marker) | not)] |
    # Append our entry
    .hooks[$type] += [$entry]
  ' "$SETTINGS_FILE" > "$SETTINGS_FILE.tmp"
  mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"
}

# Add all hooks (merges with existing — preserves hooks from other tools)
upsert_hook "UserPromptSubmit" "" "$USER_PROMPT_HOOK"
upsert_hook "PermissionRequest" "" "$PERMISSION_HOOK"
upsert_hook "Stop" "" "$STOP_HOOK"
upsert_hook "SessionEnd" "" "$SESSION_END_HOOK"
upsert_hook "PreToolUse" "Task" "$TASK_START_HOOK"
upsert_hook "PostToolUse" "Task" "$TASK_END_HOOK"
upsert_hook "PreCompact" "" "$COMPACT_START_HOOK"

echo "Added hooks to $SETTINGS_FILE:"
echo "  - UserPromptSubmit (detect turn started → working)"
echo "  - PermissionRequest (detect approval needed)"
echo "  - Stop (detect turn ended → waiting)"
echo "  - SessionEnd (detect session closed → idle)"
echo "  - PreToolUse/Task (detect subagent spawned → tasking)"
echo "  - PostToolUse/Task (detect subagent completed)"
echo "  - PreCompact (detect context compaction)"
echo ""
echo "Setup complete! The daemon will now accurately track session states."
echo ""
echo "Note: You may need to restart any running Claude Code sessions for hooks to take effect."
