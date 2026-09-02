# Install Daemon

Download and install the Varie Claude Avatar desktop app (daemon) on macOS or Windows.

## Platform Reference

| | macOS | Windows 10 1809+ / 11 (x64) |
|---|---|---|
| Installed app | `~/Applications/Varie Claude Avatar.app` or `/Applications/Varie Claude Avatar.app` | `%LOCALAPPDATA%\Programs\Varie Claude Avatar\Varie Claude Avatar.exe` |
| Plugin state | `~/.varie-claude-avatar/` | `%USERPROFILE%\.varie-claude-avatar\` |
| Installer log | `~/.varie-claude-avatar/install.log` | `%USERPROFILE%\.varie-claude-avatar\install.log` |

Every command below is run with `node`. Nothing here needs Bash, `nc`, or a Unix
socket, so the same steps work in PowerShell and in a POSIX shell. Quote the
paths: the plugin directory and the installed app both contain spaces.

## Instructions

### 1. Check What Is Already There

Use your file tools (not shell globbing) to check whether the app exists at the
platform path in the table above.

Then ask the daemon itself whether it is running — never test for a socket file,
which can survive a crash and answer "running" for a daemon that is gone:

```bash
# macOS / any POSIX shell
node "${CLAUDE_PLUGIN_ROOT}/scripts/varie-avatar-hook.cjs" status
```

```powershell
# Windows PowerShell
node "$env:CLAUDE_PLUGIN_ROOT\scripts\varie-avatar-hook.cjs" status
```

It prints exactly one line, `RUNNING` or `NOT_RUNNING`, and exits. It probes the
local endpoint only: it never launches or installs anything.

If the app is installed and the probe says `RUNNING`, tell the user and stop.

If `CLAUDE_PLUGIN_ROOT` is not set in the environment, locate
`scripts/varie-avatar-hook.cjs` under the installed plugin directory with your
file-search tool and use that absolute path instead.

### 2. Run the Installer

```bash
# macOS / any POSIX shell
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/install-daemon.cjs" --verbose
```

```powershell
# Windows PowerShell
node "$env:CLAUDE_PLUGIN_ROOT\scripts\lib\install-daemon.cjs" --verbose
```

`--verbose` mirrors progress on stdout; every line is also appended to
`install.log`. The command exits non-zero if the installation fails.

The installer resolves the latest GitHub release, picks the asset for this
platform and architecture, and installs it:

- **Windows:** downloads `*-win-x64-setup.exe` and runs it silently with `/S`,
  which installs per-user into `%LOCALAPPDATA%\Programs\Varie Claude Avatar`.
  Administrator rights are not required.
- **macOS:** downloads the ZIP and expands it into `~/Applications`.

### 3. Launch the App

The SessionStart hook launches the daemon on your next Claude Code session, so
this step is optional. To start it now:

```bash
# macOS
open -g -j "$HOME/Applications/Varie Claude Avatar.app" 2>/dev/null || \
open -g -j "/Applications/Varie Claude Avatar.app"
```

```powershell
# Windows PowerShell
Start-Process "$env:LOCALAPPDATA\Programs\Varie Claude Avatar\Varie Claude Avatar.exe"
```

### 4. Verify

Run the same `status` command as in step 1 and report what it actually printed.

`NOT_RUNNING` immediately after a successful install is normal if you skipped
step 3: the app has been installed but not started yet. Report it as
"installed, starts on your next session" — do not claim it is running.

## Output Format

```
## Varie Claude Avatar — Install

**Status**: Installed and running / Installed (starts on next session) / Failed
**Platform**: Windows x64 / macOS
**Location**: %LOCALAPPDATA%\Programs\Varie Claude Avatar  (or ~/Applications/Varie Claude Avatar.app)
**Probe**: RUNNING / NOT_RUNNING

The avatar appears automatically on your next Claude Code session.

### Quick Actions
- Check status: `/varie-avatar:status`
- Browse characters: `/varie-avatar:list`
- Switch character: `/varie-avatar:set <id>`
```

Report only what the commands printed. If the installer exited non-zero, say so
and quote the failure code from its output or from `install.log`.

## Windows SmartScreen

Windows builds are not code-signed yet. A manual download may trigger Microsoft
Defender SmartScreen ("Windows protected your PC") — choose **More info**, then
**Run anyway**. The silent `/S` install started by this skill is not affected.

## If Installation Fails

Point the user at the manual downloads:
https://github.com/varie-ai/varie-claude-avatar/releases

- Windows installer: `Varie Claude Avatar-<version>-win-x64-setup.exe`
- Windows portable: `Varie Claude Avatar-<version>-win-x64-portable.exe`
- macOS: the `.dmg` matching their chip (`-arm64` for Apple Silicon)
