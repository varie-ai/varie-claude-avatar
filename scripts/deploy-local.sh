#!/bin/bash
# deploy-local.sh — Build, package, and install daemon to /Applications
# Usage: ./scripts/deploy-local.sh [--skip-build]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON_DIR="$SCRIPT_DIR/../daemon"
APP_NAME="Varie Claude Avatar"
APP_SRC="$DAEMON_DIR/release/mac-arm64/$APP_NAME.app"
APP_DEST="/Applications/$APP_NAME.app"
SOCKET="/tmp/varie-claude-avatar.sock"

cd "$DAEMON_DIR"

# Step 1: Build + Package (unless --skip-build)
if [[ "$1" != "--skip-build" ]]; then
  echo "→ Building..."
  npm run build

  echo "→ Packaging for macOS..."
  npm run package:mac
else
  echo "→ Skipping build (--skip-build)"
fi

# Step 2: Kill running process
echo "→ Stopping running instance..."
pkill -9 -f "$APP_NAME" 2>/dev/null || true
sleep 1
rm -f "$SOCKET"

# Step 3: Replace app
echo "→ Installing to /Applications..."
rm -rf "$APP_DEST"
cp -R "$APP_SRC" "$APP_DEST"

# Step 4: Launch
echo "→ Launching..."
open -g -j "$APP_DEST"

echo "✓ Done — $APP_NAME is running"
