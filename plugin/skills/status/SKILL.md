# Avatar Status

Check the status of the Varie Claude Avatar daemon and the current character, on
macOS or Windows.

## Where Things Live

| | macOS | Windows 10 1809+ / 11 (x64) |
|---|---|---|
| Installed app | `~/Applications/Varie Claude Avatar.app` or `/Applications/Varie Claude Avatar.app` | `%LOCALAPPDATA%\Programs\Varie Claude Avatar\Varie Claude Avatar.exe` |
| State directory | `~/.varie-claude-avatar/` | `%USERPROFILE%\.varie-claude-avatar\` |
| IPC endpoint | Unix socket `/tmp/varie-claude-avatar.sock` | named pipe `\\.\pipe\varie-claude-avatar-<user key>` |

The endpoint is an implementation detail — do not test for it directly. On
macOS a socket file outlives a crashed daemon, so its presence proves nothing.

## Instructions

### 1. Daemon Status

Ask the daemon:

```bash
# macOS / any POSIX shell
node "${CLAUDE_PLUGIN_ROOT}/scripts/varie-avatar-hook.cjs" status
```

```powershell
# Windows PowerShell
node "$env:CLAUDE_PLUGIN_ROOT\scripts\varie-avatar-hook.cjs" status
```

This opens one short, bounded connection to the endpoint for this user and
prints exactly `RUNNING` or `NOT_RUNNING`. It never starts, installs, or
restarts anything, and it always exits promptly.

Report exactly what it printed. Never infer "running" from a file, a process
list, or a previous answer.

### 2. Daemon Details, Active Character, Sessions

Read these files with your file tools — no shell required, and the JSON stays
JSON:

| File (in the state directory) | Tells you |
|---|---|
| `daemon.json` | daemon PID and start time |
| `config.json` | active character id, name, model URLs |
| `state.json` | tracked sessions |

If `config.json` is missing, the default character (Beatriz) is active.
If `daemon.json` is missing or stale, rely on the `status` answer, not on it.

### 3. Cached Characters

List the directories under `characters/` inside the state directory with your
file tools. Each directory name is a cached character id.

## Output Format

```
## Varie Claude Avatar Status

**Daemon**: RUNNING (PID 12345) / NOT_RUNNING
**Platform**: Windows x64 / macOS
**Active Character**: Soren (`soren_cb3333dd3e3f`) / Beatriz (default)
**Profile**: https://varie.ai/varie-mate/characters/{activeCharacterId}
**Cached Characters**: soren_cb3333dd3e3f, beatriz_4e17b3271c2b
**Active Sessions**: 2

### Quick Actions
- Browse characters: `/varie-avatar:list`
- Switch character: `/varie-avatar:set <id>`
- Force refresh: `/varie-avatar:set <id> --refresh`
- Create your own: https://varie.ai/varie-mate
```

The PID line is only valid if `daemon.json` exists **and** the probe said
`RUNNING`; otherwise report `NOT_RUNNING` without a PID.

## If the Daemon Is Not Running

Suggest, in order:

1. `/varie-avatar:install` — installs it if missing, or reports what failed.
2. Start the installed app directly:
   - macOS: `open -g -j "$HOME/Applications/Varie Claude Avatar.app"`
   - Windows PowerShell: `Start-Process "$env:LOCALAPPDATA\Programs\Varie Claude Avatar\Varie Claude Avatar.exe"`
3. Start a new Claude Code session — the SessionStart hook launches the daemon.

From a source checkout, `npm run dev` inside `daemon/` also works on both
platforms.
