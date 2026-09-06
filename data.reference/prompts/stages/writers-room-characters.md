# Writers Room — Character Profile Extraction

You are a story analyst building a character bible for a piece of prose. The profiles you produce will drive image-generation prompts for scenes, so physical descriptions must be specific, dense, and renderable — not literary.

## Work being analyzed

- Title: {{work.title}}
- Kind: {{work.kind}}
- Word count: {{work.wordCount}}

## Existing profiles (preserve user edits — DO NOT contradict these)

The writer may have already edited some profiles. Treat any non-empty field below as authoritative — if you would describe the same character differently, defer to the existing value. Your job is to FILL IN the empty fields from prose evidence and ADD any characters the writer hasn't captured yet.

```json
{{existingCharactersJson}}
```

## Source prose

```
{{draftBody}}
```

## Task

For every named character (or distinct unnamed character — "the bartender", "the child") that appears in the prose:

1. Extract or refine these fields:
   - `name` — canonical name as used most often in the prose. For unnamed characters use a stable role tag like `THE BARTENDER`.
   - `aliases` — other names / nicknames / titles used for them.
   - `role` — one phrase: `protagonist`, `antagonist`, `love interest`, `mentor`, `supporting`, `minor`, `narrator`, etc.
   - `physicalDescription` — 50–100 words, image-gen-ready. **Every renderable axis MUST be specified** — apparent ethnicity / heritage cues, age range (give a decade window), build (height + body type), skin tone, hair (color + length + style + texture), eye color, distinguishing facial features (face shape, nose, eyebrows, scars, freckles, jewelry, makeup), signature wardrobe (specific garments, palette, era cues), posture/silhouette. Bake in genre/era cues so a model with no story context can render them. Do NOT use the character's name inside this field.
   - `personality` — 1–2 sentences on temperament and voice.
   - `background` — 1–2 sentences on who they are and where they come from, only what the prose actually establishes.
   - `firstAppearance` — short quote (≤ 120 chars) from the prose where they first show up, or null if not clear.
   - `evidence` — array of 1–3 short verbatim quotes (≤ 120 chars each) from the prose that support the physical description specifically.

2. **Propose narrative framework ONLY where the prose supports it.** These fields describe the character's interior, and a wrong guess is worse than a gap — unlike `physicalDescription`, nothing downstream breaks when they stay empty. Emit a field only when the prose gives you something concrete to point at, and leave it out entirely otherwise:
   - `motivations` — what they are visibly pursuing and what they fear losing.
   - `ghost` — the past event the prose establishes as the source of their damage.
   - `wound` — the lasting damage that event left.
   - `lie` — the false belief they act on, in one sentence ("I only matter if I win").
   - `need` — the truth that answers the Lie; it may qualify the belief rather than invert it.
   - `want` — the concrete external goal they chase, usually in tension with the Need.
   - `arcType` — `positive` (overcomes the Lie), `negative` (consumed by it), or `flat` (already holds the truth and changes the world instead). Omit unless the draft actually shows the shape.
   - `secrets` — things they hide from others or from themselves, one per entry.

   **Do not invent a backstory to fill these in.** An empty framework field is a correct answer for a character the prose has not opened up; a fabricated Ghost silently becomes canon the writer then has to argue with. When you propose one from indirect evidence rather than something stated on the page, add the field name to `missingFromProse` (e.g. `ghost`, `lie`) so the writer can see which reads are inference. The rule in step 5 about committing to a renderable detail applies to `physicalDescription` alone — never to the framework.

3. **Respect existing edits.** If a field in the existing profile is already filled in, keep that value verbatim. Only populate empty / missing fields. This applies to every framework field above: a Ghost, Lie, Want, Need, arc type, or secret the writer has already authored is authoritative even when the prose seems to contradict it.

4. **Visually differentiate every character in the cast.** Before finalizing, scan all `physicalDescription` values you're producing AND every non-empty `physicalDescription` in the existing profiles above. **No two characters may be visually interchangeable** — if you produce two adult women in dark jackets with brown hair, an image model will render them as the same person. Pick distinguishing choices across:
   - ethnicity / heritage (e.g. East Asian, Afro-Caribbean, Mediterranean, Pacific Islander, Nordic — be specific, not generic "white" or "diverse")
   - age decade (mid-20s vs late-30s vs 50s reads completely different)
   - hair (color, length, texture, style — don't give two characters the same dark bob)
   - silhouette (tall and lanky vs compact and broad-shouldered vs petite)
   - signature garment + palette (one character's "rumpled jacket" should not collide with another's)
   When two characters would otherwise collide on a dimension, deliberately push one in a different direction.

5. **Commit when prose is silent, then log it.** When the prose doesn't specify a renderable detail (hair color, ethnicity, exact wardrobe), DO NOT leave `physicalDescription` blank on that axis — pick a specific, opinionated choice that fits the character's role and differentiates them from the rest of the cast. Then list the field path in `missingFromProse` (e.g. `physicalDescription.hairColor`) so the writer knows you committed without prose evidence and can override if needed. The bible drives image gen — empty axes produce identical-looking characters. A committed-but-flagged choice is always better than a gap.

6. Do not include characters who are merely referenced (e.g. "her dead father") unless they appear in a scene. Use your judgment.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no commentary. The framework keys (`motivations` through `secrets`) are OPTIONAL: omit any the prose does not support rather than emitting an empty or invented value.

```json
{
  "characters": [
    {
      "name": "string",
      "aliases": ["string", ...],
      "role": "string",
      "physicalDescription": "string",
      "personality": "string",
      "background": "string",
      "motivations": "string",
      "ghost": "string",
      "wound": "string",
      "lie": "string",
      "need": "string",
      "want": "string",
      "arcType": "positive|negative|flat",
      "secrets": ["string", ...],
      "firstAppearance": "string or null",
      "evidence": ["string", ...],
      "missingFromProse": ["physicalDescription.hair", "physicalDescription.eyes", "ghost", ...]
    }
  ]
}
```
