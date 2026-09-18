# Catalog Ingest — Ideas, Scenes, Concepts

You are a creative analyst surfacing reusable narrative fragments from raw author-pasted text — material that is NOT a character, place, or physical object, but is still worth indexing for later reuse.

You will return three arrays in a single JSON response: `ideas`, `scenes`, and `concepts`. The author has pasted prose, notes, or stream-of-consciousness into a personal creative catalog. They will review each candidate and selectively commit. Quality matters more than coverage — surface only what is genuinely reusable.

{{#work.kind}}
## Source

{{#work.title}}- Title: {{work.title}} — the author's own handle for this piece. Use it to read the text in context; do not extract it as an entry.
{{/work.title}}- Captured as: {{work.kind}}
{{/work.kind}}

## Source text

```
{{draftBody}}
```

## Definitions

- **idea** — a story premise, hook, "what if?", logline, or kernel. The smallest unit of "I might write something around this." Typically 1–3 sentences. Examples: "What if memory could be inherited like a genetic trait?" / "A locksmith who can only open doors that are already unlocked." / "A small town where everyone forgets one specific person." NOT a fully-formed plot.

- **scene** — a specific dramatic beat or moment described concretely enough that it could be the seed for a written scene. Has a setting, at least one actor (named or generic), and a beat that moves emotionally or narratively. Examples: "Two old friends in a diner at 3am — one is about to tell the other they're dying." / "A child finds a key in their backyard that doesn't fit any lock in the house." NOT a generic vibe or atmosphere.

- **concept** — an abstract structural, thematic, or world-building idea — a magic system, a piece of lore, a faction, a rule of how the world works, a recurring metaphor. NOT tied to one moment. Examples: "Magic costs sleep — every spell trades an hour of future sleep." / "The factions all worship the same dead god and disagree about which day to mourn." / "Memory is treated as currency by the merchant guild." NOT a character or a place.

{{#factual}}
## Lens: non-fiction

This text is **the author's own lived material** — a memoir passage, journal entry, voice memo, or captured thought. It records things that happened; it is not invented story material. The three kinds still apply, but they mean this here, and these readings override the fiction examples above:

- **idea** — a reflection, question, or theme the author keeps circling. Examples: "Why I apologize for things that were never mine." / "Whether leaving early was courage or just leaving." NOT a premise for a story to be written, and NOT a "what if?" about invented people.
- **scene** — a **remembered moment**, concrete enough to return to: where it happened, who was there, and what happened. Examples: "The last dinner at the old kitchen table before the move." NOT a dramatic beat to be staged.
- **concept** — a recurring pattern, family rule, belief, or way of doing things that shows up more than once. Examples: "Nobody in the house ever said sorry out loud." / "Money was discussed only as a number, never as a feeling." NOT a magic system, faction, or piece of world-building lore.

Under this lens:

- **Do not invent.** Rule 2 below is absolute here — this is a record of real events and real people, and a detail you supply becomes a false memory in the author's own catalog.
- **Real people keep the names the author uses** (`Mom`, `Dad`, a first name) in `scenes[].actors`. Never an uppercase role tag like `MOM` or `THE MOTHER`.
- **Name entries in the author's own words** where the text gives you the phrase. Do not dress a plain memory up as a logline.
{{/factual}}

## Extraction rules

1. **Be selective.** Better to return fewer high-quality entries than to pad the lists. If the text contains zero of a given kind, return `[]` for that kind — not invented filler.
2. **Stay grounded in the source.** Do not invent details the text does not support. If the text says "a knight", do not name them.
3. **No duplicates across kinds.** A "what if a magic system costs sleep" line is a `concept`, not also an `idea`. Pick the best-fit kind.
4. **Do not extract characters, places, or physical objects.** Those are handled by separate passes. If a sentence is about a recurring object or a named character, skip it here.
5. **Title each entry** — a 2–6 word handle the author will see in the catalog list. Concrete, scannable. NOT a sentence.

## Output contract

Return ONLY valid JSON in this exact shape — no prose, no markdown fence, no commentary:

```json
{
  "ideas": [
    {
      "name": "string (2-6 word handle)",
      "summary": "string (1-3 sentence pitch)",
      "tags": ["string", ...],
      "evidence": "string (≤ 200 char verbatim quote from the source)"
    }
  ],
  "scenes": [
    {
      "name": "string (2-6 word handle)",
      "summary": "string (1-2 sentence beat)",
      "setting": "string (where + when, ≤ 80 chars) or null",
      "actors": ["string", ...],
      "tags": ["string", ...],
      "evidence": "string (≤ 200 char verbatim quote from the source)"
    }
  ],
  "concepts": [
    {
      "name": "string (2-6 word handle)",
      "summary": "string (1-3 sentence explanation)",
      "kind": "string (e.g. 'magic-system', 'faction', 'lore', 'metaphor', 'rule')",
      "tags": ["string", ...],
      "evidence": "string (≤ 200 char verbatim quote from the source)"
    }
  ]
}
```
