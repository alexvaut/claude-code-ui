#!/bin/bash
# Setup script for claude-code-ui daemon hooks
#
# Registers a single hook script (forward-hook.sh) for all 8 hook events.
# The script forwards the raw hook payload to the daemon via HTTP POST.
# The daemon handles all state transitions internally.

set -e

# Parse options
DEBUG_HOOKS=false
for arg in "$@"; do
  case "$arg" in
    --debug) DEBUG_HOOKS=true ;;
    --help|-h)
      echo "Usage: setup-hooks.sh [--debug]"
      echo "  --debug  Also install debug hooks that log all events to hook-debug.log"
      exit 0
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# On Windows (MSYS2/Git Bash), convert /c/... paths to C:/... so they work
# when Claude Code invokes hooks with a non-MSYS bash.
if [[ "$OSTYPE" == msys* || "$OSTYPE" == cygwin* || "$OSTYPE" == mingw* ]]; then
  if command -v cygpath &> /dev/null; then
    SCRIPT_DIR="$(cygpath -m "$SCRIPT_DIR")"
  else
    # Fallback: /c/foo → C:/foo  (pure bash, no GNU sed needed)
    if [[ "$SCRIPT_DIR" =~ ^/([a-zA-Z])/ ]]; then
      SCRIPT_DIR="${BASH_REMATCH[1]^}:${SCRIPT_DIR:2}"
    fi
  fi
fi

SETTINGS_FILE="$HOME/.claude/settings.json"

echo "Setting up claude-code-ui hooks..."

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

# Helper: upsert a hook entry — replaces existing entry with matching script name, or appends.
# Usage: upsert_hook <hook_type> <matcher> <command>
# Matches on the specific script filename (not directory), so multiple hooks of the same type
# with different scripts can coexist (e.g., production + debug).
# Preserves hooks from other tools (e.g., Claude-Code-Remote).
upsert_hook() {
  local hook_type="$1" matcher="$2" command="$3"
  local entry="{\"matcher\": \"$matcher\", \"hooks\": [{\"type\": \"command\", \"command\": \"$command\"}]}"
  local script_name
  script_name=$(basename "$command")

  jq --arg type "$hook_type" --arg script_name "$script_name" --argjson entry "$entry" '
    .hooks[$type] //= [] |
    # Remove any existing entry whose command ends with our script name
    .hooks[$type] = [.hooks[$type][] | select((.hooks[0].command | endswith($script_name)) | not)] |
    # Append our entry
    .hooks[$type] += [$entry]
  ' "$SETTINGS_FILE" > "$SETTINGS_FILE.tmp"
  mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"
}

# Helper: remove a hook entry by script name from a given hook type.
# Usage: remove_hook <hook_type> <script_name>
remove_hook() {
  local hook_type="$1" script_name="$2"

  jq --arg type "$hook_type" --arg script_name "$script_name" '
    if .hooks[$type] then
      .hooks[$type] = [.hooks[$type][] | select((.hooks[0].command | endswith($script_name)) | not)] |
      # Clean up empty arrays
      if .hooks[$type] == [] then del(.hooks[$type]) else . end
    else . end
  ' "$SETTINGS_FILE" > "$SETTINGS_FILE.tmp"
  mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"
}

# Remove old individual hook scripts (replaced by forward-hook.sh)
OLD_SCRIPTS=(
  "user-prompt-submit.sh" "permission-request.sh" "pre-tool-use-all.sh"
  "post-tool-use.sh" "post-tool-use-failure.sh" "stop.sh" "session-end.sh"
  "compact-start.sh"
)
HOOK_TYPES=(
  "UserPromptSubmit" "PermissionRequest" "PreToolUse"
  "PostToolUse" "PostToolUseFailure" "Stop" "SessionEnd" "PreCompact"
)

for old_script in "${OLD_SCRIPTS[@]}"; do
  for hook_type in "${HOOK_TYPES[@]}"; do
    remove_hook "$hook_type" "$old_script"
  done
done

# Register forward-hook.sh for all 8 hook events
FORWARD_HOOK="$SCRIPT_DIR/hooks/forward-hook.sh"
for hook_type in "${HOOK_TYPES[@]}"; do
  upsert_hook "$hook_type" "" "$FORWARD_HOOK"
done

# Debug hooks: install or remove based on --debug flag
DEBUG_HOOK_SCRIPT="debug-hook.sh"
DEBUG_HOOK_TYPES=(
  "SessionStart" "UserPromptSubmit" "PreToolUse" "PermissionRequest"
  "PostToolUse" "PostToolUseFailure" "Notification" "SubagentStart"
  "SubagentStop" "Stop" "TeammateIdle" "TaskCompleted" "PreCompact"
  "SessionEnd"
)

if [ "$DEBUG_HOOKS" = true ]; then
  DEBUG_HOOK="$SCRIPT_DIR/hooks/$DEBUG_HOOK_SCRIPT"
  for hook_type in "${DEBUG_HOOK_TYPES[@]}"; do
    upsert_hook "$hook_type" "" "$DEBUG_HOOK"
  done
  echo "Installed debug hooks (logging all events to hook-debug.log)"
else
  # Remove any previously installed debug hooks
  for hook_type in "${DEBUG_HOOK_TYPES[@]}"; do
    remove_hook "$hook_type" "$DEBUG_HOOK_SCRIPT"
  done
fi

echo ""
echo "Installed hooks to $SETTINGS_FILE:"
echo "  All 8 hook events → forward-hook.sh → HTTP POST to daemon"
echo "  (UserPromptSubmit, PermissionRequest, PreToolUse, PostToolUse,"
echo "   PostToolUseFailure, Stop, SessionEnd, PreCompact)"
if [ "$DEBUG_HOOKS" = true ]; then
  echo "  + Debug: all 14 hook events logged to hook-debug.log"
fi
echo ""
echo "Setup complete! The daemon will now accurately track session states."
echo ""
echo "Note: You may need to restart any running Claude Code sessions for hooks to take effect."
