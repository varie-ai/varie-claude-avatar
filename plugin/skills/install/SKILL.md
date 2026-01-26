# Install Daemon

Download and install the Varie Claude Avatar desktop app (daemon).

## Instructions

### 1. Check if Already Installed

```bash
# macOS
ls -d "/Applications/Varie Claude Avatar.app" "$HOME/Applications/Varie Claude Avatar.app" 2>/dev/null

# Check if running
test -S /tmp/varie-claude-avatar.sock && echo "RUNNING" || echo "NOT_RUNNING"
```

If the app is already installed and running, tell the user and stop.

### 2. Run the Installer

Run the install-daemon script with `--verbose` to show progress:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/install-daemon" --verbose
```

If `CLAUDE_PLUGIN_ROOT` is not set, find the script:

```bash
find ~/.claude/plugins -name "install-daemon" -path "*/varie-avatar/*" 2>/dev/null | head -1
```

Then run it with `--verbose`.

### 3. Launch the App

After installation, launch the daemon:

```bash
# macOS
open -g -j "$HOME/Applications/Varie Claude Avatar.app" 2>/dev/null || \
open -g -j "/Applications/Varie Claude Avatar.app" 2>/dev/null
```

### 4. Verify

```bash
# Wait a moment for socket to appear
sleep 2
test -S /tmp/varie-claude-avatar.sock && echo "SUCCESS" || echo "NOT_STARTED"
```

## Output Format

```
## Varie Claude Avatar — Install

**Status**: Installed and running / Installed (launch on next session) / Failed
**Location**: ~/Applications/Varie Claude Avatar.app
**Version**: v0.1.0

The avatar will appear automatically on your next Claude Code session.

### Quick Actions
- Check status: `/varie-avatar:status`
- Browse characters: `/varie-avatar:list`
- Switch character: `/varie-avatar:set <id>`
```

If installation fails, provide the manual download link:
https://github.com/varie-ai/varie-claude-avatar/releases
