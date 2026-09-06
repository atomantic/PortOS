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
- `physicalDescription` — 50–100 words of stable, concrete image-generation identity: apparent age, scale/build or non-human form, surface/skin, hair and eyes when applicable, distinguishing marks, signature attire, and materials. Never substitute the character's name for visible detail.
- `personality` — specific contradictions and behavior under pressure, not a list of flattering adjectives.
- `background` — only the history that explains present choices, obligations, and blind spots.
- `visualNotes` — 1–2 sentences capturing the at-a-glance silhouette and palette ("layered practical streetwear in faded mustard + charcoal; chunky boots; ever-present beanie").
- `silhouetteNotes` — bulleted-as-prose distinctive shape features ("compact upper body; layered silhouette; tapered lower half; short hair adds 5cm height").
- `postureNotes` — habitual posture cues ("slight forward lean; weight in left foot; shoulders loose; ready-to-move; eyes constantly scanning").
- `specialTraits` — non-redundant standout details ("quick hands; chipped nail polish; scar on right eyebrow; restless energy; observant").
- `visualIdentity` — design language axes ("knobs + sights; urban utilitarian; analog tech feel; small signals of story; hard to pin down").
- `motivations` — primary drives in 2–3 sentences. What does the character WANT, and what does the character fear losing?
- **Character framework (Ghost → Wound → Lie → Want → Need).** Only propose these for a lead/antagonist the universe clearly centers; leave blank for a bit-player. They must interlock — pass these checks before writing them:
  - `ghost` — the past event that wounded the character (1–2 sentences). Must causally explain the Lie.
  - `wound` — the lasting emotional damage the Ghost left (1 sentence).
  - `lie` — the false belief the character holds because of the Wound. State it in ONE sentence ("I only matter if I win").
  - `need` — the internal alternative the Lie is holding shut ("I matter whether I win or lose"). Often the direct opposite of the Lie, but it may instead QUALIFY the belief ("winning matters, and it is not what makes me worth keeping") — write whichever is true for this character rather than forcing a mirror image.
  - `want` — the concrete external goal the character pursues, which usually conflicts with the Need.
- **Psychology (`psychology`) — OPTIONAL.** A structured layer on top of the chain above, not a replacement for it. Ghost and Wound stay the origin history; Want and Need stay the conscious pursuit and the internal alternative. Propose it only for a character the universe genuinely centers, and only when the existing data supports it. Rules:
  - `theoryOfControl` — the character's operating rule in ONE sentence, stated as they would hold it, WITHOUT calling it false ("if I stay useful, nobody leaves"). This is NOT a restatement of the `lie`. A `lie` is an optional judgment about a belief; the theory of control is the belief as the rule they actually run on. If a `lie` is already populated, treat it as a starting point — never copy it verbatim, and never assert the two are identical.
  - `strategy` — the behavior the theory motivates.
  - `protectiveBenefit` — what that behavior genuinely protects them from.
  - `presentCost` — what it costs them NOW.
  - `testingPressure` / `candidateChange` — what would put the theory under load, and the revision it might undergo. Anticipated only: the story-specific progression that actually gets dramatized belongs to an authored character arc, not to this profile. Do not write events, issue numbers, or a sequence here.
  - `drives` — `survival`, `connection`, and `status`, each with a `desire` and a `fear`. **`status` means perceived value to a GROUP** — respect, standing, being counted — not wealth and not dominance. For a non-human character, interpret the three axes in terms of its own form (continuity, coupling, standing within whatever it belongs to) rather than forcing a human interior onto it.
  - `assessment` — omit it for an ordinary authored profile. Use `"unknown"` when the supplied data does not support a theory of control, or `"not-applicable"` when the character has no legible interior at all (a hive, a weather front, an unpersoned system) — and in EITHER case put your one-sentence reason in `assessmentNote` and omit the rest of the object. An honest "unknown" beats an invented interior.
- `arcType` — one of `positive` (overcomes the Lie, embraces the Truth), `negative` (consumed by the Lie), or `flat` (already knows the Truth; changes the world instead). Omit if unclear.
- `sliders` — rate `proactivity`, `likability`, `competence` each 1–10. Rule: HIGH (≥7) on at least TWO, OR high on one with clear room to grow. All-low reads boring; all-high-from-the-start reads as a Mary Sue. Omit for a bit-player.
- `secrets` — 2+ things this character hides (from others or themselves). Short prose items.
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
- `wardrobes` — 1–4 recurring outfit/state variants with `name` and image-generation-ready `description`. For non-human characters use form-appropriate presentation or interface states instead of inventing clothing.

## Output contract

Return ONLY valid JSON, no markdown fence, no commentary. Include ONLY the keys you are proposing values for — if you have nothing meaningful to add for a field (or it was already populated), OMIT the key entirely. Do not echo unchanged values.

```json
{
  "pronouns": "string",
  "age": "string",
  "coreTheme": "string",
  "speechAccent": "string",
  "speechPattern": "string",
  "physicalDescription": "string",
  "personality": "string",
  "background": "string",
  "visualNotes": "string",
  "silhouetteNotes": "string",
  "postureNotes": "string",
  "specialTraits": "string",
  "visualIdentity": "string",
  "motivations": "string",
  "ghost": "string",
  "wound": "string",
  "lie": "string",
  "want": "string",
  "need": "string",
  "psychology": {
    "theoryOfControl": "string",
    "strategy": "string",
    "protectiveBenefit": "string",
    "presentCost": "string",
    "testingPressure": "string",
    "candidateChange": "string",
    "assessment": "assessed | unknown | not-applicable",
    "assessmentNote": "string — required when assessment is unknown or not-applicable",
    "drives": {
      "survival": {"desire": "string", "fear": "string"},
      "connection": {"desire": "string", "fear": "string"},
      "status": {"desire": "string", "fear": "string"}
    }
  },
  "arcType": "positive | negative | flat",
  "sliders": {"proactivity": 1, "likability": 1, "competence": 1},
  "secrets": ["string"],
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
  "wardrobes": [{"name": "string", "description": "string"}],
  "rationale": "1-sentence summary of the character direction you chose"
}
```
