#!/bin/bash
# Setup script for claude-code-ui daemon hooks
# This installs the PermissionRequest hook that enables accurate "Needs Approval" detection

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_SCRIPT="$SCRIPT_DIR/permission-request-hook.sh"
SETTINGS_FILE="$HOME/.claude/settings.json"
PENDING_DIR="$HOME/.claude/pending-permissions"

echo "Setting up claude-code-ui hooks..."

# Create pending permissions directory
mkdir -p "$PENDING_DIR"
echo "Created $PENDING_DIR"

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

# Check if PermissionRequest hook already exists
if jq -e '.hooks.PermissionRequest' "$SETTINGS_FILE" > /dev/null 2>&1; then
    echo "PermissionRequest hook already configured in settings.json"
    echo "To update, remove the existing hook and run this script again."
    exit 0
fi

# Add the PermissionRequest hook with new format (matcher + hooks array)
jq --arg hook "$HOOK_SCRIPT" '.hooks.PermissionRequest = [{"matcher": {}, "hooks": [{"type": "command", "command": $hook}]}]' "$SETTINGS_FILE" > "$SETTINGS_FILE.tmp"
mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"

echo "Added PermissionRequest hook to $SETTINGS_FILE"
echo ""
echo "Setup complete! The daemon will now accurately detect when Claude Code is waiting for permission."
echo ""
echo "Note: You may need to restart any running Claude Code sessions for the hook to take effect."
