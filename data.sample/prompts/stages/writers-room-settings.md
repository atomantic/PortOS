# Writers Room — Setting / World Bible Extraction

You are a production designer building a setting bible for a piece of prose. Each entry you produce will drive image-generation prompts for scenes set in that location, so descriptions must be specific, visually dense, and renderable — not literary.

## Work being analyzed

- Title: {{work.title}}
- Kind: {{work.kind}}
- Word count: {{work.wordCount}}

## Existing settings (preserve user edits — DO NOT contradict these)

The writer may have already edited some entries. Treat any non-empty field below as authoritative — if you would describe the same location differently, defer to the existing value. Your job is to FILL IN the empty fields from prose evidence and ADD any locations the writer hasn't captured yet.

```json
{{existingSettingsJson}}
```

## Source prose

```
{{draftBody}}
```

## Task

For every distinct *location* the prose stages a scene in (interior or exterior), produce one entry. Use screenplay-slugline keys so the storyboard pipeline can match scenes back to settings automatically.

1. Extract or refine these fields:
   - `slugline` — screenplay format: `INT./EXT. LOCATION — TIME OF DAY` (uppercase). This is the *match key* the storyboard uses to attach a setting to a scene, so use the same wording every time the prose returns to a place. If the same room appears at different times of day, prefer the most-used variant (or `INT. LOCATION — DAY` as the default). Do not invent locations the prose never visits.
   - `name` — short human-readable name (`Curry O'City`, `The Train Platform`, `Marlowe's Apartment`). May overlap with the slugline's location half. If the prose names the place, use that name verbatim.
   - `description` — 40–100 words, image-gen-ready. Be specific and visual: architecture, scale, materials, lighting sources, recurring set-dressing, signage, smells/sounds the prose names visually (steam, neon hum). Bake in genre/era cues. Do NOT include character action, dialogue, or plot — just the *place*.
   - `palette` — short comma-separated list of dominant colors / lighting cues (`oxblood neon, wet asphalt black, sodium-yellow streetlights`). Drives image-gen color consistency.
   - `era` — short tag (`near-future`, `1950s noir`, `present day`, `Victorian`). One phrase. Skip if the prose is ambiguous.
   - `weather` — recurring atmospheric conditions inside this place (`muggy curry-steam`, `dust motes in shafts of sun`, `permanent drizzle out the window`). Skip if the prose doesn't establish one.
   - `recurringDetails` — 1–2 sentences listing distinctive props or fixtures the prose returns to (`three tiny tables and standing room only`, `a dead jukebox in the corner`). These are the visual anchors that keep scenes in the same place looking the same.
   - `firstAppearance` — short quote (≤ 120 chars) from the prose where the location first shows up, or null if not clear.
   - `evidence` — array of 1–3 short verbatim quotes (≤ 120 chars each) from the prose that support the description specifically.

2. **Respect existing edits.** If a field in the existing entry is already filled in, keep that value verbatim. Only populate empty / missing fields.

3. **Identify gaps.** For every entry (existing AND new), list which fields the prose does not yet support — return them as `missingFromProse`. The writer uses this to decide whether to add detail to the prose or fill the field manually.

4. Do not invent details the prose does not support. If the prose never describes the lighting, leave it out of `description` rather than guessing — and call it out in `missingFromProse`.

5. Skip *referenced-only* locations the prose never actually stages a scene in (e.g. "the city she grew up in"). Only entries where the prose puts characters in the place.

6. If the same physical place appears under two sluglines because of time-of-day variants (`INT. KITCHEN — DAY` and `INT. KITCHEN — NIGHT`), produce ONE entry under the most common slugline; cover the time-of-day variation inside `weather` or `description`.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no commentary:

```json
{
  "settings": [
    {
      "slugline": "INT. KITCHEN — NIGHT",
      "name": "string",
      "description": "string",
      "palette": "string",
      "era": "string",
      "weather": "string",
      "recurringDetails": "string",
      "firstAppearance": "string or null",
      "evidence": ["string", ...],
      "missingFromProse": ["palette", "weather", ...]
    }
  ]
}
```
