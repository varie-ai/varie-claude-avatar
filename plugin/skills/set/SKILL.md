# Set Active Character

Activate a Varie character as your Claude Code companion.

## Arguments

`$ARGUMENTS` — character ID, optionally followed by `--refresh` to force re-download from CDN.

Examples:
- `soren_cb3333dd3e3f`
- `soren_cb3333dd3e3f --refresh`

## Instructions

1. Parse `$ARGUMENTS` to extract the character ID and check for `--refresh` flag.

2. Validate the character exists via the public API:

```bash
curl -s "https://varie.ai/api/character-create/public/characters/<id>"
```

Expected response:
```json
{
  "id": "soren_cb3333dd3e3f",
  "name": "Soren",
  "tagline": "...",
  "quotes": ["The stars remember what mortals forget.", "Every path leads somewhere worth going.", "..."],
  "publicModel": { "status": "full_ready", "fullUrl": "...", "baseUrl": "..." }
}
```

If the response contains `"error"`:
- If the error says "Character is locked": the character needs to be unlocked by its owner. Tell the user to go to [varie.ai/varie-mate](https://varie.ai/varie-mate), find the character, and unlock it. (Unlocking is separate from making a character public — an unlocked character can be used as a companion without appearing in the public listing.)
- If the error mentions "model not available": the character's avatar bundle may not have been generated yet — the user should contact dev@varie.ai for support.
- Otherwise: tell the user the character was not found or is not available.

3. If `--refresh` was passed, delete all cached bundles to force a fresh download:

```bash
rm -f ~/.varie-claude-avatar/characters/<id>/full_avatar.varie
rm -f ~/.varie-claude-avatar/characters/<id>/base_avatar.varie
```

4. Write the active character config. Include `publicModelStatus` and the full model URLs from the API response's `publicModel` object (`fullUrl` and `baseUrl`). The daemon uses these URLs directly instead of constructing them:

```bash
mkdir -p ~/.varie-claude-avatar
cat > ~/.varie-claude-avatar/config.json << 'CONFIGEOF'
{
  "activeCharacter": "<id>",
  "characterName": "<name>",
  "publicModelStatus": "<full_ready or base_ready>",
  "modelUrls": {
    "fullUrl": "<publicModel.fullUrl from API response, or null>",
    "baseUrl": "<publicModel.baseUrl from API response, or null>"
  },
  "updatedAt": "<ISO 8601 timestamp>"
}
CONFIGEOF
```

**Important:** Use the exact URL strings from the API response's `publicModel.fullUrl` and `publicModel.baseUrl`. If a URL is `null` in the response, write `null` (not the string `"null"`).

5. Send `reload_character` event to the daemon socket:

```bash
echo '{"type":"reload_character","sessionId":"'${CLAUDE_SESSION_ID:-plugin}'","timestamp":'$(date +%s)000',"metadata":{"characterId":"<id>"}}' | nc -w1 -U /tmp/varie-claude-avatar.sock
```

6. Tell the user. Pick a **random quote** from the character's `quotes` array (if available) to give personality:

> Switched to **{name}**! The avatar will update shortly.
> *"{random quote}"* — {name}
> Meet {name}: https://varie.ai/varie-mate/characters/{id}

If the character has no quotes, omit the quote line and just show the switch confirmation.

If `--refresh` was used, also mention: "Cache cleared — downloading fresh model from CDN."

## Error Handling

- If the API call fails: "Could not verify character. Check your connection and try again."
- If the socket doesn't exist (`/tmp/varie-claude-avatar.sock`): "Character config saved, but the daemon doesn't appear to be running. Start it with `cd varie-claude-avatar/daemon && npm run dev`."
- If no character ID is provided: "Please provide a character ID. Use `/varie-avatar:list` to browse available characters."
