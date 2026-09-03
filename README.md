# Varie Claude Avatar

<img src="screenshots/demo.gif" width="600" alt="Varie Claude Avatar demo — animated character reacting to Claude Code" />

An animated character companion for [Claude Code](https://claude.ai/code) that lives as a desktop overlay, reacting to your coding sessions with expressions and notifications.

<p>
  <img src="screenshots/notification.png" width="220" alt="Approval notification with character" />
  <img src="screenshots/stats.png" width="220" alt="Stats panel showing session counts" />
  <img src="screenshots/notification_spread.png" width="220" alt="Multi-session notifications spread around the character" />
</p>

*Approval notifications · Session stats · ...or when you push Claude Code a little too hard across sessions*

Pick from a library of characters — or [create your own](https://varie.ai) — and launch it alongside Claude Code. The avatar shows expressions as tools run, keeps you on top of notifications across multiple sessions, and tracks your usage stats at a glance.

## Table of Contents

- [Installation](#installation)
- [Features](#features)
- [Notifications](#notifications)
- [Characters](#characters)
- [Stats Panel](#stats-panel)
- [Platform Support](#platform-support)
- [Development](#development)
- [Architecture](#architecture)
- [License](#license)

## Installation

### Install the Plugin

```
/plugin marketplace add https://github.com/varie-ai/varie-claude-avatar
/plugin install varie-avatar@varie-avatar
```

Then restart Claude Code. **That's it** — the desktop app downloads automatically in the background on your first session and launches from the next session onward, on both macOS and Windows.

### Alternative Install Methods

**Interactive install** (if the automatic download did not run):

```
/varie-avatar:install
```

**Manual download** from [Releases](https://github.com/varie-ai/varie-claude-avatar/releases):

| Platform | File | What it does |
|----------|------|--------------|
| Windows 10 1809+ / 11 (x64) | `Varie Claude Avatar-<version>-win-x64-setup.exe` | One-click NSIS installer, per-user, no admin rights |
| Windows 10 1809+ / 11 (x64) | `Varie Claude Avatar-<version>-win-x64-portable.exe` | Runs directly, installs nothing |
| macOS (Apple Silicon) | `Varie Claude Avatar-<version>-arm64.dmg` | Open and drag to Applications |
| macOS (Intel) | `Varie Claude Avatar-<version>.dmg` | Open and drag to Applications |

The Windows installer puts the app in `%LOCALAPPDATA%\Programs\Varie Claude Avatar`.

### Updating

1. Run `/plugin`, select your marketplace, then **Update marketplace**
2. Select **Installed**, choose `varie-avatar`, then **Update now**
3. Restart Claude Code for hook changes to take effect

The desktop app is updated separately from [Releases](https://github.com/varie-ai/varie-claude-avatar/releases) (auto-update coming soon).

### SmartScreen Note (Windows)

Windows builds are **not code-signed yet**. Microsoft Defender SmartScreen may show *"Windows protected your PC"* the first time you run a manually downloaded installer or the portable executable — choose **More info**, then **Run anyway**. The silent install performed automatically by the plugin does not show this prompt.

### Gatekeeper Note (macOS)

If you encounter a "developer cannot be verified" prompt on first launch:
- **macOS 14 and earlier:** Right-click the app → Open → click Open
- **macOS 15 (Sequoia):** System Settings → Privacy & Security → scroll down → click "Open Anyway"

This typically only affects manual `.dmg` installs.

## Features

### 🎭 Animated Character Overlay
- Spine-animated character sits on your desktop as a transparent overlay
- Reacts to Claude Code events with expressions and animations
- Tracks your cursor for eye-gaze follow
- Drag to reposition, resize (S/M/L), or minimize

### 🔔 Cross-Session Notifications
- See approval requests, questions, and attention alerts across all your Claude Code sessions
- Notification badges with project name, tool info, and command summaries
- Click to dismiss — keeps your workspace uncluttered

  A click **only dismisses the notification** — on macOS and Windows alike, that is all it does in this release. It does not focus a terminal and never sends approval input on your behalf; approve in Claude Code as usual. A macOS adapter that *can* focus a terminal and send an approval keystroke does exist behind the terminal-action IPC boundary, but no click and no UI control invokes it today. On **Windows** that adapter is disabled outright and reports every request as unsupported.

### 🎨 Character Library
- Browse and switch characters from the [Varie](https://varie.ai) character library
- Create your own characters at [varie.ai/varie-mate](https://varie.ai/varie-mate)
- Characters are cached locally after first download

### 📊 Usage Stats
- Session count, daily/weekly totals, top projects
- Hover top-left corner to reveal, pin to keep visible
- Data stored locally with 7-day rolling window

### 🔒 Privacy
- **No telemetry, no analytics, no tracking**
- Exactly two kinds of outbound connection are made:
  - **GitHub Releases** — to discover and download the desktop app during install and update
  - **Varie** — to look up character metadata and download character models
- All session stats, notifications, and state stay local on your machine
- The plugin talks to the daemon over a **local IPC endpoint only**: a Unix domain socket on macOS, a per-user named pipe on Windows. Nothing listens on a network port.

## Notifications

| Event | Response |
|-------|----------|
| Tool needs approval | Notification badge with tool name + command summary |
| Tool completes | Success expression |
| Claude asks a question | Question notification + expression |
| Plan ready for review | Notification badge |
| Claude needs attention | Pulsing attention notification |

## Characters

Browse and switch characters using plugin skills:

```
/varie-avatar:list          # Browse available characters
/varie-avatar:set <id>      # Switch to a character
/varie-avatar:status        # Check current character and daemon status
```

Characters are loaded from the [Varie](https://varie.ai) character library. Create your own at [varie.ai/varie-mate](https://varie.ai/varie-mate).

## Stats Panel

Hover over the top-left corner of the overlay to reveal:
- Active session count (green dot)
- Today's and this week's session totals
- Your most-used projects

Click the pin button to keep the panel visible. Click reload to reset the active session count.

## Platform Support

| Platform | Status | Installed Path |
|----------|--------|----------------|
| Windows 11 (x64) | Supported | `%LOCALAPPDATA%\Programs\Varie Claude Avatar` |
| Windows 10 version 1809 or newer (x64) | Supported | `%LOCALAPPDATA%\Programs\Varie Claude Avatar` |
| macOS (Apple Silicon) | Supported | `~/Applications/` or `/Applications/` |
| macOS (Intel) | Supported | `~/Applications/` or `/Applications/` |
| Linux | Not supported | — |

**Requirements:**
- Windows 10 version 1809 or newer, x64 — or macOS 10.15+ (Catalina or later), Intel or Apple Silicon
- Claude Code with plugin support
- **Node.js 18 or newer** — required by the plugin hooks on every platform, and for building the desktop app from source

**Windows differences in this release:**
- Notification clicks dismiss the notification only — no terminal focus, no approval input
- The IPC endpoint is a per-user named pipe rather than a Unix socket
- Builds are unsigned, so SmartScreen may prompt on a manual download

## Development

### Running the Daemon in Dev Mode

Identical on macOS and Windows:

```
cd daemon
npm install
npm run dev     # Build + launch Electron
npm run watch   # Watch mode (rebuild on file change)
```

### Running the Tests

The test runner discovers `tests/node/*.test.cjs` itself and runs the suites sequentially. Do **not** pass a shell glob to `node --test`: bash expands it, PowerShell does not.

```
node tests/node/run-tests.cjs
```

From `daemon/`, `npm test` runs the same suite.

### Testing Notifications

Send a real event through the hook CLI. This is the same client the hooks use, so it works on both platforms and needs no `nc`, no socket path, and no hand-written JSON:

```
node plugin/scripts/varie-avatar-hook.cjs attention
node plugin/scripts/varie-avatar-hook.cjs notification --message "Testing"
node plugin/scripts/varie-avatar-hook.cjs approval-needed --tool Bash
```

Ask the daemon whether it is up — prints exactly `RUNNING` or `NOT_RUNNING`:

```
node plugin/scripts/varie-avatar-hook.cjs status
```

Ask it to switch character:

```
node plugin/scripts/varie-avatar-hook.cjs reload-character --character-id soren_cb3333dd3e3f
```

### Packaging

```
cd daemon
npm run package:win   # Windows x64: NSIS setup .exe + portable .exe
npm run package:mac   # macOS .app + .dmg + .zip
```

`package:win` must run on Windows and `package:mac` on macOS; electron-builder cannot produce the other platform's signed artifacts. The Windows targets are pinned to x64 and emit:

```
daemon/release/Varie Claude Avatar-<version>-win-x64-setup.exe
daemon/release/Varie Claude Avatar-<version>-win-x64-portable.exe
```

Windows packaging extracts an archive containing symbolic links, so it needs **Developer Mode enabled** or an elevated shell; otherwise electron-builder fails with *"Cannot create symbolic link"*.

### Deploy Locally (macOS only)

```bash
# Build, package, kill old process, install to /Applications, and launch
scripts/deploy-local.sh

# Skip build (just kill + replace + launch)
scripts/deploy-local.sh --skip-build
```

This is a Bash script that installs into `/Applications`; there is no Windows equivalent. On Windows, use `npm run package:win` and run the produced installer.

## Architecture

```
plugin/                              daemon/
┌──────────────────────────┐         ┌──────────────────────────────┐
│  SessionStart hook       │──────▶  │  daemon-lifecycle            │
│  PreToolUse hook         │──┐      │  (auto-launch / auto-install)│
│  PostToolUse hook        │  │      └──────────────────────────────┘
│  Stop hook               │  │                     │
│  Notification hook       │  │      ┌──────────────▼───────────────┐
└──────────────────────────┘  │      │  IPC Server                  │
                              │      │  macOS:   Unix domain socket │
  varie-avatar-hook.cjs       │      │  Windows: named pipe         │
  (sends JSON events)      ◀──┘      └──────────────┬───────────────┘
         │                                          │
         └───────────────────────────▶┌─────────────▼────────────────┐
                                      │  Electron Main Process       │
                                      │  ├── SessionTracker          │
                                      │  ├── StatsTracker            │
                                      │  ├── MouseTracker            │
                                      │  └── TerminalActions         │
                                      └─────────────┬────────────────┘
                                                    │
                                      ┌─────────────▼────────────────┐
                                      │  Renderer                    │
                                      │  ├── Spine Character (WebGL) │
                                      │  ├── Notification Manager    │
                                      │  └── Stats Panel             │
                                      └──────────────────────────────┘
```

One Node.js hook client serves every platform. Claude Code invokes it in exec form (`node` plus an argument vector), so no shell parses the command and paths containing spaces are safe. The endpoint is resolved by `shared/ipc-endpoint.cjs`: `/tmp/varie-claude-avatar.sock` on macOS, and a named pipe derived from the user's home directory on Windows, so two accounts on the same machine never share one.

`TerminalActions` is platform-selected: the macOS adapter is able to focus a terminal and send an approval keystroke, while the Windows adapter is deliberately disabled and reports every request as unsupported. Both sit behind the preload IPC boundary, and neither is reached in this release — no renderer control invokes a terminal action, so a click only dismisses. The boundary is the extension point a later release builds on, not a feature shipping today.

### Project Structure

```
varie-claude-avatar/
├── daemon/                 # Electron desktop overlay app
│   ├── src/main/           # Main process (window, IPC server, tracking)
│   ├── src/renderer/       # Renderer (Spine character, notifications, UI)
│   ├── assets/             # App icons (icon.ico, icon.icns)
│   └── package.json        # electron-builder config: nsis, portable, dmg, zip
├── plugin/                 # Claude Code plugin
│   ├── .claude-plugin/     # Plugin manifest
│   ├── hooks/              # Event hooks (hooks.json)
│   ├── scripts/            # varie-avatar-hook.cjs + lib/ (transport, lifecycle, installer)
│   └── skills/             # /varie-avatar:list, :set, :status, :install
├── shared/                 # ipc-endpoint.cjs — the endpoint both sides agree on
├── tests/node/             # Cross-platform test suites + run-tests.cjs
└── scripts/                # deploy-local.sh (macOS)
```

## License

MIT — see [LICENSE](LICENSE) for details.
