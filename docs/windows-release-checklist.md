# Windows Release Acceptance Checklist

Manual acceptance for a Varie Claude Avatar release candidate on **clean**
Windows virtual machines. Every box below starts unticked and may only be ticked
by the person who actually performed the step and saw the result. An untested
step stays unticked; it is never assumed from a passing step on the other VM.

Run the whole list once on **Windows 10 1809+ x64** and once on **Windows 11
x64**. The two runs are independent: a green Windows 11 run says nothing about
Windows 10.

> Automated gates (GitHub Actions CI, macOS packaging, Windows packaging) are
> recorded elsewhere. This document covers only what a machine cannot check.

---

## 1. Release Candidate Metadata

| Field | Value |
|-------|-------|
| Tag | |
| Version (`daemon/package.json`) | |
| Commit SHA | |
| Workflow run URL | |
| Build date (UTC) | |
| Tester | |
| Code signing | not signed — SmartScreen expected |

Reference paths for this release:

| What | Where (Windows) |
|------|-----------------|
| Installed app | `%LOCALAPPDATA%\Programs\Varie Claude Avatar\Varie Claude Avatar.exe` |
| Plugin state | `%USERPROFILE%\.varie-claude-avatar\` |
| Installer lock | `%USERPROFILE%\.varie-claude-avatar\.installing` |
| Hook log | `%USERPROFILE%\.varie-claude-avatar\hook.log` |
| Installer log | `%USERPROFILE%\.varie-claude-avatar\install.log` |
| Daemon log | `%APPDATA%\Varie Claude Avatar\debug.log` |
| IPC endpoint | named pipe `\\.\pipe\varie-claude-avatar-<user key>` |

---

## 2. Artifact SHA-256

Fill in before touching a VM, from the artifacts that will actually be
published. Recompute on the VM after download and confirm the two match.

```powershell
Get-FileHash -Algorithm SHA256 "<path to artifact>"
```

| Artifact | Size (bytes) | SHA-256 (build host) | SHA-256 (on VM) | Match |
|----------|--------------|----------------------|-----------------|-------|
| `Varie Claude Avatar-<version>-win-x64-setup.exe` | | | | |
| `Varie Claude Avatar-<version>-win-x64-portable.exe` | | | | |

- [ ] Both artifacts were downloaded from the published release, not copied from a build directory
- [ ] Both hashes recomputed on the VM match the build-host hashes
- [ ] The two artifacts are different files (different hashes)

---

## 3. Windows 10 version 1809 or newer, x64

VM build number: ______________   Snapshot restored from clean image: ☐

### 3.1 Installation

- [ ] Clean install: VM restored from a pristine snapshot, no previous version, no leftover `%USERPROFILE%\.varie-claude-avatar\`
- [ ] Silent install with `/S` completes without a UAC prompt and without user interaction
- [ ] Installed path is exactly `%LOCALAPPDATA%\Programs\Varie Claude Avatar`
- [ ] The install is per-user: nothing was written under `C:\Program Files`
- [ ] `install.log` records the installation and contains no stack trace

### 3.2 First Session

- [ ] First Claude Code session after install launches the daemon automatically (SessionStart hook)
- [ ] The overlay appears without the user starting the app manually
- [ ] The SessionStart hook returns well inside its timeout; Claude Code is not visibly delayed
- [ ] `hook.log` contains no repeated warnings for the session

### 3.3 Events

Trigger each event from a real Claude Code session and confirm the avatar reacts:

- [ ] `session_start`
- [ ] `user_prompt`
- [ ] `approval_needed` (tool approval, with tool name and command summary)
- [ ] `tool_complete`
- [ ] `notification`
- [ ] `attention` (idle prompt)
- [ ] `question`
- [ ] `plan_complete`
- [ ] `question_complete`
- [ ] `stop`
- [ ] `subagent_stop`
- [ ] `session_end`
- [ ] `reload_character` (via `/varie-avatar:set <id>`)

### 3.4 Concurrent Sessions

- [ ] Two Claude Code sessions run at the same time against one daemon
- [ ] Notifications from both sessions appear, each attributed to its own project
- [ ] The stats panel counts two active sessions
- [ ] Ending one session leaves the other's notifications intact

### 3.5 Overlay Behaviour

- [ ] The overlay background is genuinely transparent (desktop and windows visible behind the character)
- [ ] The overlay stays always-on-top over a maximised window
- [ ] The overlay does not steal focus when a notification arrives
- [ ] Drag repositions the character, and the position survives a restart
- [ ] Scale **S** renders correctly
- [ ] Scale **M** renders correctly
- [ ] Scale **L** renders correctly
- [ ] Minimize hides the overlay and it can be restored

### 3.6 Tray

- [ ] The tray icon uses the application icon and is not blank
- [ ] Tray → **Show** reveals the overlay
- [ ] Tray → **Hide** hides the overlay
- [ ] Tray → **Quit** terminates the daemon and leaves no process behind

### 3.7 Statistics

- [ ] The stats panel opens on hover over the top-left corner
- [ ] Session counts, daily and weekly totals, and top projects are populated
- [ ] The pin button keeps the panel visible
- [ ] Statistics survive a daemon restart

### 3.8 Characters

- [ ] `/varie-avatar:list` returns characters
- [ ] `/varie-avatar:set <id>` reports the config saved **and** the reload delivered (`RELOAD_SENT`)
- [ ] The character bundle downloads and the avatar visibly changes
- [ ] The bundle is cached under `%USERPROFILE%\.varie-claude-avatar\characters\<id>\`
- [ ] A second switch to the cached character loads from cache with no download
- [ ] `/varie-avatar:set <id> --refresh` clears the cached bundles and re-downloads

### 3.9 Recovery

- [ ] Killing the daemon and starting a new Claude Code session relaunches it
- [ ] The daemon restarts with the previous character, position, and statistics
- [ ] A stale `%USERPROFILE%\.varie-claude-avatar\.installing` lock left by a killed installer is recovered: the next install proceeds instead of blocking forever
- [ ] The recovered install does not delete or corrupt a lock held by a live installer

### 3.10 IPC

- [ ] The named pipe exists while the daemon runs, and is gone after Quit:
      `[System.IO.Directory]::GetFiles("\\.\pipe\") | Where-Object { $_ -like "*varie-claude-avatar*" }`
- [ ] The pipe name is per-user (it contains the user key, not a fixed global name)
- [ ] `node "$env:CLAUDE_PLUGIN_ROOT\scripts\varie-avatar-hook.cjs" status` prints `RUNNING` while up
- [ ] The same command prints `NOT_RUNNING` after Quit, and returns promptly

### 3.11 Windows v1 Interaction Limits

- [ ] Clicking a notification **dismisses it and does nothing else**
- [ ] Clicking a notification does **not** focus or raise the originating terminal
- [ ] Clicking a notification does **not** send approval input, keystrokes, or clipboard content anywhere
- [ ] No approval in Claude Code was ever granted by the avatar

### 3.12 Portable Build

- [ ] The portable `.exe` runs from a folder with no installation
- [ ] The portable build runs from a path containing spaces
- [ ] The portable build delivers hook events over the same named pipe
- [ ] The portable build does not create `%LOCALAPPDATA%\Programs\Varie Claude Avatar`

### 3.13 Uninstall

- [ ] Uninstall from Settings → Apps removes `%LOCALAPPDATA%\Programs\Varie Claude Avatar`
- [ ] No daemon process survives the uninstall
- [ ] User data under `%USERPROFILE%\.varie-claude-avatar\` is **retained** (config, characters, stats)
- [ ] Reinstalling afterwards restores the previous character and statistics

### 3.14 SmartScreen

- [ ] Running the downloaded setup `.exe` by double-click shows the expected SmartScreen prompt
- [ ] **More info → Run anyway** proceeds and the install completes
- [ ] The portable `.exe` shows the same prompt on first run
- [ ] The observed wording matches what the release notes tell users to expect

---

## 4. Windows 11 x64

VM build number: ______________   Snapshot restored from clean image: ☐

### 4.1 Installation

- [ ] Clean install: VM restored from a pristine snapshot, no previous version, no leftover `%USERPROFILE%\.varie-claude-avatar\`
- [ ] Silent install with `/S` completes without a UAC prompt and without user interaction
- [ ] Installed path is exactly `%LOCALAPPDATA%\Programs\Varie Claude Avatar`
- [ ] The install is per-user: nothing was written under `C:\Program Files`
- [ ] `install.log` records the installation and contains no stack trace

### 4.2 First Session

- [ ] First Claude Code session after install launches the daemon automatically (SessionStart hook)
- [ ] The overlay appears without the user starting the app manually
- [ ] The SessionStart hook returns well inside its timeout; Claude Code is not visibly delayed
- [ ] `hook.log` contains no repeated warnings for the session

### 4.3 Events

- [ ] `session_start`
- [ ] `user_prompt`
- [ ] `approval_needed` (tool approval, with tool name and command summary)
- [ ] `tool_complete`
- [ ] `notification`
- [ ] `attention` (idle prompt)
- [ ] `question`
- [ ] `plan_complete`
- [ ] `question_complete`
- [ ] `stop`
- [ ] `subagent_stop`
- [ ] `session_end`
- [ ] `reload_character` (via `/varie-avatar:set <id>`)

### 4.4 Concurrent Sessions

- [ ] Two Claude Code sessions run at the same time against one daemon
- [ ] Notifications from both sessions appear, each attributed to its own project
- [ ] The stats panel counts two active sessions
- [ ] Ending one session leaves the other's notifications intact

### 4.5 Overlay Behaviour

- [ ] The overlay background is genuinely transparent (desktop and windows visible behind the character)
- [ ] The overlay stays always-on-top over a maximised window
- [ ] The overlay does not steal focus when a notification arrives
- [ ] Drag repositions the character, and the position survives a restart
- [ ] Scale **S** renders correctly
- [ ] Scale **M** renders correctly
- [ ] Scale **L** renders correctly
- [ ] Minimize hides the overlay and it can be restored

### 4.6 Tray

- [ ] The tray icon uses the application icon and is not blank
- [ ] Tray → **Show** reveals the overlay
- [ ] Tray → **Hide** hides the overlay
- [ ] Tray → **Quit** terminates the daemon and leaves no process behind

### 4.7 Statistics

- [ ] The stats panel opens on hover over the top-left corner
- [ ] Session counts, daily and weekly totals, and top projects are populated
- [ ] The pin button keeps the panel visible
- [ ] Statistics survive a daemon restart

### 4.8 Characters

- [ ] `/varie-avatar:list` returns characters
- [ ] `/varie-avatar:set <id>` reports the config saved **and** the reload delivered (`RELOAD_SENT`)
- [ ] The character bundle downloads and the avatar visibly changes
- [ ] The bundle is cached under `%USERPROFILE%\.varie-claude-avatar\characters\<id>\`
- [ ] A second switch to the cached character loads from cache with no download
- [ ] `/varie-avatar:set <id> --refresh` clears the cached bundles and re-downloads

### 4.9 Recovery

- [ ] Killing the daemon and starting a new Claude Code session relaunches it
- [ ] The daemon restarts with the previous character, position, and statistics
- [ ] A stale `%USERPROFILE%\.varie-claude-avatar\.installing` lock left by a killed installer is recovered: the next install proceeds instead of blocking forever
- [ ] The recovered install does not delete or corrupt a lock held by a live installer

### 4.10 IPC

- [ ] The named pipe exists while the daemon runs, and is gone after Quit:
      `[System.IO.Directory]::GetFiles("\\.\pipe\") | Where-Object { $_ -like "*varie-claude-avatar*" }`
- [ ] The pipe name is per-user (it contains the user key, not a fixed global name)
- [ ] `node "$env:CLAUDE_PLUGIN_ROOT\scripts\varie-avatar-hook.cjs" status` prints `RUNNING` while up
- [ ] The same command prints `NOT_RUNNING` after Quit, and returns promptly

### 4.11 Windows v1 Interaction Limits

- [ ] Clicking a notification **dismisses it and does nothing else**
- [ ] Clicking a notification does **not** focus or raise the originating terminal
- [ ] Clicking a notification does **not** send approval input, keystrokes, or clipboard content anywhere
- [ ] No approval in Claude Code was ever granted by the avatar

### 4.12 Portable Build

- [ ] The portable `.exe` runs from a folder with no installation
- [ ] The portable build runs from a path containing spaces
- [ ] The portable build delivers hook events over the same named pipe
- [ ] The portable build does not create `%LOCALAPPDATA%\Programs\Varie Claude Avatar`

### 4.13 Uninstall

- [ ] Uninstall from Settings → Apps removes `%LOCALAPPDATA%\Programs\Varie Claude Avatar`
- [ ] No daemon process survives the uninstall
- [ ] User data under `%USERPROFILE%\.varie-claude-avatar\` is **retained** (config, characters, stats)
- [ ] Reinstalling afterwards restores the previous character and statistics

### 4.14 SmartScreen

- [ ] Running the downloaded setup `.exe` by double-click shows the expected SmartScreen prompt
- [ ] **More info → Run anyway** proceeds and the install completes
- [ ] The portable `.exe` shows the same prompt on first run
- [ ] The observed wording matches what the release notes tell users to expect

---

## 5. Evidence Attached

Collect from **each** VM separately and attach to the release candidate record.
Label every file with the VM it came from.

### Windows 10

- [ ] `%APPDATA%\Varie Claude Avatar\debug.log`
- [ ] `%USERPROFILE%\.varie-claude-avatar\hook.log`
- [ ] `%USERPROFILE%\.varie-claude-avatar\install.log`
- [ ] Screenshot: overlay transparent over a maximised window
- [ ] Screenshot: approval notification with project and command summary
- [ ] Screenshot: stats panel with two concurrent sessions
- [ ] Screenshot: tray menu
- [ ] Screenshot: SmartScreen prompt
- [ ] SHA-256 of both artifacts as computed on this VM

### Windows 11

- [ ] `%APPDATA%\Varie Claude Avatar\debug.log`
- [ ] `%USERPROFILE%\.varie-claude-avatar\hook.log`
- [ ] `%USERPROFILE%\.varie-claude-avatar\install.log`
- [ ] Screenshot: overlay transparent over a maximised window
- [ ] Screenshot: approval notification with project and command summary
- [ ] Screenshot: stats panel with two concurrent sessions
- [ ] Screenshot: tray menu
- [ ] Screenshot: SmartScreen prompt
- [ ] SHA-256 of both artifacts as computed on this VM

---

## 6. Anomalies and Outcome

### Anomalies

| # | VM | Step | What happened | Expected | Severity | Blocking |
|---|----|------|---------------|----------|----------|----------|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |

### Outcome

- [ ] Windows 10 1809+ x64: every box in section 3 ticked
- [ ] Windows 11 x64: every box in section 4 ticked
- [ ] Every anomaly is either resolved or explicitly accepted, with a reason
- [ ] No blocking anomaly remains open

**Verdict:** ☐ Accepted ☐ Rejected

Signed: ______________________   Date (UTC): ______________

A verdict of Accepted requires every box above to be ticked by someone who ran
the step. Ticking a box that was not performed invalidates the whole record.
