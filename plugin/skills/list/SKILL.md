# List Available Characters

Browse and discover Varie characters for your Claude Code companion.

## Instructions

### Step 1: Understand what the user wants

If the user provided a preference (e.g., "I want a calm character", "something fantasy"), note it for matching. If not, ask:

> What kind of companion are you looking for? For example: a genre (fantasy, sci-fi, modern), a vibe (calm, energetic, mysterious), or just "surprise me" to see what's available.

### Step 2: Fetch characters with pagination

Fetch the first page:

```bash
curl -s "https://varie.ai/api/character-create/public/discover?limit=20"
```

The response shape:
```json
{
  "characters": [
    {
      "id": "soren_cb3333dd3e3f",
      "name": "Soren",
      "tagline": "A mysterious wanderer with ancient secrets",
      "quotes": [
        "The stars remember what mortals forget.",
        "Every path leads somewhere worth going.",
        "Silence speaks louder than you think."
      ],
      "genre": "fantasy",
      "pronouns": "he/him",
      "personalityTags": ["mysterious", "wise", "calm"],
      "publicModel": { "status": "full_ready" }
    }
  ],
  "pagination": {
    "limit": 20,
    "hasMore": true,
    "nextCursor": "5"
  }
}
```

**Pagination:** If `pagination.hasMore` is `true` and you haven't found a good match for the user's preference, fetch the next page:

```bash
curl -s "https://varie.ai/api/character-create/public/discover?limit=20&cursor=<nextCursor>"
```

Continue fetching pages until you find good matches or there are no more pages. Collect all fetched characters before presenting results.

### Step 3: Present results

**If the user has a preference:** Filter and rank characters by matching `personalityTags`, `genre`, `tagline`, and `pronouns` against what the user described. Present your top 3-5 recommendations with reasoning:

For each recommended character, pick a **random quote** from their `quotes` array (if available). Present the quote as an attribution — no field labels:

```
*"{random quote}"* — **{Name}**
{pronouns} · {personalityTags joined}
[Profile](https://varie.ai/varie-mate/characters/{id}) · `/varie-avatar:set {id}`
```

If the character has no quotes, use `tagline` in place of the quote.

Explain briefly why each matches (e.g., "Soren's calm and wise personality fits your preference for a meditative companion").

**If browsing ("surprise me" or no preference):** List all fetched characters. For each, show a random quote as an attribution (fall back to tagline if no quotes):

```
*"{random quote}"* — **{Name}**
[Profile](https://varie.ai/varie-mate/characters/{id}) · `/varie-avatar:set {id}`
```

Highlight **Beatriz** (`beatriz_4e17b3271c2b`) and **Soren** (`soren_cb3333dd3e3f`) as recommended starters if present.

### Step 4: Activate

Tell the user: "Use `/varie-avatar:set <id>` to activate a character."

### Step 5: Custom characters

After presenting results, add:

> Don't see the perfect match? You can create your own custom character at [varie.ai/varie-mate](https://varie.ai/varie-mate) — design their appearance, personality, and story, then use them as your Claude Code companion.

## Character Page URL Pattern

Every character has a detail page with their full story, art, and personality:
```
https://varie.ai/varie-mate/characters/{id}
```

Include this URL when showing character details so users can explore further.

## Error Handling

- If the API returns an error or is unreachable, tell the user the service may be temporarily unavailable.
- Only show characters where `publicModel.status` is `"full_ready"` or `"base_ready"`.
