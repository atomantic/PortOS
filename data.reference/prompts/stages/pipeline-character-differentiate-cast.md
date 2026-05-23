# Pipeline — Differentiate Cast (Universe-Wide)

You are rewriting the `physicalDescription` of EVERY character in a fictional universe so each renders visually distinct in image generation. Image-gen models can't disambiguate characters from story context — only from description text. Two characters with similar descriptions will collide on the page.

## Universe context

{{styleClause}}

## Current cast

```json
{{castJson}}
```

## Task

For each character above, return a rewritten `physicalDescription` that:

1. **Specifies every renderable axis.** For humanoid characters, name:
   - apparent ethnicity / heritage cues (be specific — East Asian, Afro-Caribbean, Mediterranean, Pacific Islander, Nordic — not generic)
   - age decade (mid-20s vs late-30s vs 50s reads completely different)
   - build — height + body type
   - skin tone
   - hair — color, length, texture, style
   - eye color
   - distinguishing facial features (face shape, nose, eyebrows, scars, freckles, jewelry, makeup)
   - signature wardrobe — specific garments, palette, era cues
   - posture / silhouette

   For non-humanoid characters (creatures, monsters, sentient AIs, animals with prosthetics, ethereal entities), substitute the axes that apply: species, scale, locomotion, surface material/texture, color, signature accessories or prosthetics, glow/translucency/aura. Skip the axes that don't apply. The goal is the same — every renderable trait specified so the image model can't default to a generic shape.

2. **Differentiate from every other character in the cast.** Treat the cast as a SET. Scan every other character's `physicalDescription`. On each axis, no two characters may collide on multiple dimensions. If five characters trend "dark hair, mid-30s," push four of them to different combinations.

3. **Preserve evidence from the prose.** Each character's `evidence[]` quotes are load-bearing prose details — keep those cues intact in the rewrite. Same for `firstAppearance`. Only ADD specificity where the existing description is vague or silent. Do not contradict the evidence.

4. **Length 50–100 words** per description. Dense, image-gen-ready phrasing. Do NOT use the character's name inside its own `physicalDescription`.

5. **Output one entry per input character**, matching `id` verbatim. Skip nothing.

## Output contract

Return ONLY valid JSON, no markdown fence, no commentary:

```json
{
  "characters": [
    {
      "id": "chr-...",
      "physicalDescription": "string",
      "changes": ["short bullet of an axis you specified or shifted", "..."]
    }
  ],
  "rationale": "1-2 sentences on the overall differentiation strategy across the cast"
}
```
