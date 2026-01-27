# Varie Claude Avatar

An animated character companion for [Claude Code](https://claude.ai/code) that lives as a desktop overlay, reacting to your coding sessions with expressions and notifications.

Pick from a library of characters — or create your own on [Varie](https://varie.ai) — and launch it alongside Claude Code. The avatar shows expressions as tools run, keeps you on top of notifications across multiple sessions, and tracks your usage stats at a glance.

**Privacy:** No external network connections except downloading character data from Varie. All session stats, notifications, and state stay local on your machine.

## How It Works

Two components work together:

- **Plugin** — Claude Code hooks that send events (tool use, session start/end, approvals) to the daemon
- **Daemon** — Electron desktop overlay that renders an animated [Spine](http://esotericsoftware.com/) character and shows notifications

## Install

### Step 1: Install the Plugin

In any Claude Code session:

```
/plugin install varie-avatar
```

Or add the marketplace and install:

```
/plugin marketplace add https://github.com/varie-ai/varie-claude-avatar
/plugin install varie-avatar@varie-avatar-local
```

### Step 2: Start Coding — the Daemon Installs Automatically

On your first session, the plugin detects the daemon isn't installed and **downloads it automatically** in the background. You'll see:

```
[varie-avatar] Daemon not found. Downloading in background — it'll be ready next session.
```

The avatar will appear starting from your next session.

**Or install it manually:**

```
/varie-avatar:install
```

**Or download directly:**

Download the latest `.dmg` from [Releases](https://github.com/varie-ai/varie-claude-avatar/releases), open it, and drag to Applications.

That's it. The avatar launches automatically on every Claude Code session after the daemon is installed.

## What It Reacts To

| Event | Avatar Response |
|-------|----------------|
| Tool needs approval | Shows notification badge, approval expression |
| Tool completes | Success expression |
| Claude asks a question | Question expression + notification |
| Plan ready for review | Notification badge |
| Claude needs attention | Pulsing notification |

## Changing Characters

Use the plugin skills to browse and switch characters:

```
/varie-avatar:list          # Browse available characters
/varie-avatar:set <id>      # Switch to a character
/varie-avatar:status        # Check current character and daemon status
```

Characters are loaded from the [Varie](https://varie.ai) character library.

## Stats Panel

Hover over the top-left corner of the overlay to see:
- Active session count (green dot)
- Today's and this week's session totals
- Your most-used projects

Pin the panel with the pin button to keep it visible.

## Project Structure

```
varie-claude-avatar/
├── daemon/              # Electron desktop overlay app
│   ├── src/main/        # Main process (window, socket server, tracking)
│   ├── src/renderer/    # Renderer (Spine character, notifications, UI)
│   ├── assets/          # App icons
│   └── package.json
├── plugin/              # Claude Code plugin
│   ├── .claude-plugin/  # Plugin manifest
│   ├── hooks/           # Event hooks (SessionStart, PreToolUse, etc.)
│   ├── scripts/         # Daemon launcher + event notification scripts
│   └── skills/          # /varie-avatar:list, :set, :status
└── scripts/             # Build and deploy helpers
```

## Development

### Running the Daemon in Dev Mode

```bash
cd daemon
npm install
npm run dev     # Build + launch Electron
npm run watch   # Watch mode (rebuild on file change)
```

### Testing Notifications

```bash
# Send a test notification via Unix socket
echo '{"type":"notification","tool":"","sessionId":"test","timestamp":'$(date +%s)000',"metadata":{"project":"test","projectPath":"/test","summary":""}}' | nc -w1 -U /tmp/varie-claude-avatar.sock
```

### Packaging

```bash
npm run package:mac   # macOS .app + .dmg
npm run package:win   # Windows .exe (NSIS + portable)
```

## Requirements

- **macOS** 10.15+ (Catalina or later)
- **Claude Code** with plugin support
- **Node.js** 18+ (for building from source)

## License

MIT
