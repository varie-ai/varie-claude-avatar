# Set Active Character

Activate a Varie character as your Claude Code companion, on macOS or Windows.

## Arguments

`$ARGUMENTS` — character ID, optionally followed by `--refresh` to force
re-download from the CDN.

Examples:
- `soren_cb3333dd3e3f`
- `soren_cb3333dd3e3f --refresh`

## Where Things Live

| | macOS | Windows 10 1809+ / 11 (x64) |
|---|---|---|
| State directory | `~/.varie-claude-avatar/` | `%USERPROFILE%\.varie-claude-avatar\` |
| Character config | `<state>/config.json` | `<state>\config.json` |
| Cached bundles | `<state>/characters/<id>/` | `<state>\characters\<id>\` |

Nothing below needs Bash, `nc`, `curl`, or shell-quoted JSON, so the same steps
work in PowerShell and in a POSIX shell.

## Instructions

1. Parse `$ARGUMENTS` into a character ID and an optional `--refresh` flag.
   If no ID was given, stop and ask for one — do not guess and do not send
   anything to the daemon.

2. Validate the character against the public API. Fetch this URL with your web
   fetch tool, or with Node, which behaves identically on both platforms
   (in Windows PowerShell `curl` is an alias for `Invoke-WebRequest`, which
   takes different flags, so a curl command line is not portable):

```bash
node -e "fetch(process.argv[1]).then(r=>r.text()).then(t=>console.log(t))" "https://varie.ai/api/character-create/public/characters/<id>"
```

Expected response:
```json
{
  "id": "soren_cb3333dd3e3f",
  "name": "Soren",
  "tagline": "...",
  "quotes": ["The stars remember what mortals forget.", "..."],
  "publicModel": { "status": "full_ready", "fullUrl": "...", "baseUrl": "..." }
}
```

If the response contains `"error"`:
- "Character is locked": the owner must unlock it at
  [varie.ai/varie-mate](https://varie.ai/varie-mate). (Unlocking is separate
  from making a character public — an unlocked character can be used as a
  companion without appearing in the public listing.)
- "model not available": the avatar bundle has not been generated yet; suggest
  contacting dev@varie.ai.
- Otherwise: the character was not found or is not available.

3. If `--refresh` was passed, delete the cached bundles for that character with
   your file tools — `<state>/characters/<id>/full_avatar.varie` and
   `<state>/characters/<id>/base_avatar.varie`. Delete only those two files, and
   only inside that character's directory. Do not shell out: `rm` does not exist
   in PowerShell and `Remove-Item` does not exist in a POSIX shell.

4. Write `<state>/config.json` with your file-writing tool, creating the state
   directory if needed. Do not build the JSON in a shell — a character name with
   an apostrophe or a URL with an ampersand would corrupt it.

```json
{
  "activeCharacter": "<id>",
  "characterName": "<name>",
  "publicModelStatus": "<full_ready or base_ready>",
  "modelUrls": {
    "fullUrl": "<publicModel.fullUrl from the API response, or null>",
    "baseUrl": "<publicModel.baseUrl from the API response, or null>"
  },
  "updatedAt": "<ISO 8601 timestamp>"
}
```

**Important:** copy the URL strings verbatim from the API response's
`publicModel.fullUrl` and `publicModel.baseUrl`. If a URL is `null` in the
response, write `null`, not the string `"null"`. The daemon uses these URLs
directly instead of constructing them.

5. Ask the daemon to reload:

```bash
# macOS / any POSIX shell
node "${CLAUDE_PLUGIN_ROOT}/scripts/varie-avatar-hook.cjs" reload-character --character-id <id>
```

```powershell
# Windows PowerShell
node "$env:CLAUDE_PLUGIN_ROOT\scripts\varie-avatar-hook.cjs" reload-character --character-id <id>
```

The ID travels as data inside the event's `metadata.characterId`; it is never
interpolated into a command line. The command prints exactly one line:

| Output | Meaning |
|---|---|
| `RELOAD_SENT` | the daemon accepted the reload; the avatar updates now |
| `RELOAD_FAILED` | the config is saved, but the daemon did not accept it (usually not running) |
| `MISSING_CHARACTER_ID` | no ID was passed; nothing was sent and no connection was opened |

6. Tell the user, and **keep the two facts separate**: saving the config and
   delivering the reload are different outcomes.

On `RELOAD_SENT`, pick a **random quote** from the character's `quotes` array:

> Switched to **{name}**! The avatar is updating now.
> *"{random quote}"* — {name}
> Meet {name}: https://varie.ai/varie-mate/characters/{id}

On `RELOAD_FAILED`:

> Saved **{name}** as your character, but the avatar daemon did not confirm the
> reload — it is probably not running. It will pick up the new character on your
> next Claude Code session. Run `/varie-avatar:status` to check.

If the character has no quotes, omit the quote line.
If `--refresh` was used, add: "Cache cleared — downloading a fresh model from the CDN."

## Error Handling

- API call fails: "Could not verify character. Check your connection and try again."
- `RELOAD_FAILED`: report the config as saved and the reload as **not** delivered,
  as above. Never report a reload you did not see acknowledged.
- No character ID: "Please provide a character ID. Use `/varie-avatar:list` to
  browse available characters."
