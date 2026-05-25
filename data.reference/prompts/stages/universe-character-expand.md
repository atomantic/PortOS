# Universe — Expand Character Profile

You are fleshing out one character in a story universe so a novelist (motivation, likes, mannerisms, relationships) and a graphic novelist (silhouette, palette, expressions, props) both have everything they need to render the character consistently.

## Universe style / aesthetic

{{styleClause}}

## The character

Current data — fields that are already populated MUST be preserved verbatim. Only fill BLANK fields. Empty string `""` or `[]` means blank.

```json
{{characterJson}}
```

## Other characters in this universe (peers — DO NOT collide visually or narratively)

```json
{{peersJson}}
```

## Task

For every BLANK field in the character JSON above, propose a value that:

1. **Fits the universe's aesthetic** and the character's existing `role` / `physicalDescription` / `personality`.
2. **Stays distinct from every peer.** Don't reuse a peer's signature color, accent, prop, or mannerism. If the character's species is non-human (ghost, spider, cloud, AI, etc.), let the stats and visual fields reflect that — do not force human anatomy.
3. **Reads as image-gen-ready prose** for the visual fields (`visualNotes`, `silhouetteNotes`, `postureNotes`, `specialTraits`, `visualIdentity`). Dense, specific, single paragraphs. No bullet points inside string values.

### Field guidance

- `pronouns` — short form ("she/her", "they/them", "it/its", "no pronouns — referred to as 'the Reach'").
- `age` — flexible string ("27", "centuries old", "newly hatched", "unknown — appears mid-30s"). Don't force a number.
- `coreTheme` — the character's one-sentence thematic essence ("a cartographer of grief", "the city's last honest broker").
- `speechAccent` — regional / cultural accent only ("clipped Edinburgh", "Brooklyn drawl", "off-world inflection — vowels stretch"). Keep narrow; the rhythm + lexicon goes in `speechPattern`.
- `speechPattern` — written speech rhythm: sentence structure, cadence, vocabulary tics, recurring phrases ("rarely contracts; uses nautical metaphors; trails off into ellipses when uncertain; never swears, prefers archaic substitutes like 'damnation'"). Distinct from `voiceId` (the TTS engine pointer) — this drives how dialogue *reads* on the page, before any voice synth.
- `visualNotes` — 1–2 sentences capturing the at-a-glance silhouette and palette ("layered practical streetwear in faded mustard + charcoal; chunky boots; ever-present beanie").
- `silhouetteNotes` — bulleted-as-prose distinctive shape features ("compact upper body; layered silhouette; tapered lower half; short hair adds 5cm height").
- `postureNotes` — habitual posture cues ("slight forward lean; weight in left foot; shoulders loose; ready-to-move; eyes constantly scanning").
- `specialTraits` — non-redundant standout details ("quick hands; chipped nail polish; scar on right eyebrow; restless energy; observant").
- `visualIdentity` — design language axes ("knobs + sights; urban utilitarian; analog tech feel; small signals of story; hard to pin down").
- `motivations` — primary drives in 2–3 sentences. What does the character WANT, and what does the character fear losing?
- `likes` — short prose list, separated by commas or semicolons.
- `dislikes` — same shape as likes.
- `mannerisms` — habitual physical / verbal tics ("touches the back of the neck when lying; trails off mid-sentence when thinking; whistles tunelessly while working").
- `relationships` — who the character is connected to in the world (use peer names where applicable), and the tenor of each connection.
- `skills` — concrete abilities, soft and hard ("conversational Mandarin; sleight-of-hand; knows every bus route from memory").
- `stats` — 4–10 entries appropriate for the character's form. For humans, default to height / weight / eye color / hair / skin / signature scent. For non-humans, replace with form-appropriate dimensions ("Wingspan: 12 ft", "Mass: 80kg of damp linen", "Eyes: none — echolocates").
- `colorPalette` — 6–8 named swatches that drive the character's wardrobe + skin + accent palette. Include a hex value (e.g. `#f59e0b`) and a 1–3-word role ("skin", "jacket primary", "boot leather"). Stay coherent with the universe aesthetic.
- `props` — 2–6 signature items the character carries or interacts with frequently. Each gets a `name`, `purpose`, `materials`, optional `notes`.
- `expressions` — 7 named facial expressions covering the emotional range ("neutral", "curious", "worried", "surprised", "amused", "determined", "relaxed"). Each gets a 1-line `description`.
- `handGestures` — 5 named hand gestures the character habitually uses ("relaxed hand", "pointing", "peace sign", "gripping radio", "adjusting earpiece"). Each gets a 1-line `description`.

## Output contract

Return ONLY valid JSON, no markdown fence, no commentary. Include ONLY the keys you are proposing values for — if you have nothing meaningful to add for a field (or it was already populated), OMIT the key entirely. Do not echo unchanged values.

```json
{
  "pronouns": "string",
  "age": "string",
  "coreTheme": "string",
  "speechAccent": "string",
  "speechPattern": "string",
  "visualNotes": "string",
  "silhouetteNotes": "string",
  "postureNotes": "string",
  "specialTraits": "string",
  "visualIdentity": "string",
  "motivations": "string",
  "likes": "string",
  "dislikes": "string",
  "mannerisms": "string",
  "relationships": "string",
  "skills": "string",
  "stats": [{"label": "string", "value": "string"}],
  "colorPalette": [{"name": "string", "hex": "#xxxxxx", "role": "string"}],
  "props": [{"name": "string", "purpose": "string", "materials": "string", "notes": "string"}],
  "expressions": [{"name": "string", "description": "string"}],
  "handGestures": [{"name": "string", "description": "string"}],
  "rationale": "1-sentence summary of the character direction you chose"
}
```
