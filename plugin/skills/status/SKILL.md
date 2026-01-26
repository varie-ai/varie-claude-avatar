# Avatar Status

Check the status of the Varie Claude Avatar daemon and current character.

## Instructions

Run these checks and present the results:

### 1. Daemon Status

```bash
# Check if socket exists (daemon is running)
test -S /tmp/varie-claude-avatar.sock && echo "RUNNING" || echo "NOT_RUNNING"

# Get daemon info (PID, start time)
cat ~/.varie-claude-avatar/daemon.json 2>/dev/null
```

### 2. Active Character

```bash
cat ~/.varie-claude-avatar/config.json 2>/dev/null
```

If the file doesn't exist, the default character (Vespera) is active.

### 3. Cached Characters

```bash
ls -d ~/.varie-claude-avatar/characters/*/ 2>/dev/null | xargs -I{} basename {}
```

### 4. Active Sessions

```bash
cat ~/.varie-claude-avatar/state.json 2>/dev/null
```

## Output Format

Present as:

```
## Varie Claude Avatar Status

**Daemon**: Running (PID 12345) / Not Running
**Active Character**: Soren (`soren_cb3333dd3e3f`) / Vespera (default)
**Profile**: https://varie.ai/varie-mate/characters/{activeCharacterId}
**Cached Characters**: soren_cb3333dd3e3f, vespera_b02d095ae396
**Active Sessions**: 2

### Quick Actions
- Browse characters: `/varie-avatar:list`
- Switch character: `/varie-avatar:set <id>`
- Force refresh: `/varie-avatar:set <id> --refresh`
- Create your own: https://varie.ai/varie-mate
```

If the daemon is not running, suggest: `cd varie-claude-avatar/daemon && npm run dev`
