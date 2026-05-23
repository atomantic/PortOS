# Pipeline — Differentiate Character Description

You are refining one character's `physicalDescription` so they render visually distinct from every other character in the cast. Image-generation models read this field directly — empty, vague, or near-identical descriptions produce interchangeable characters on the page.

## Target character

```json
{{targetJson}}
```

## Other characters in the cast (peers — preserve THEIR identity; do not contradict)

```json
{{peersJson}}
```

## Style / world context

{{styleClause}}

## Task

Rewrite ONLY the `physicalDescription` of the target so it is **visually distinct** from every peer above.

1. **Specify every renderable axis.** The new description MUST name:
   - apparent ethnicity / heritage cues (be specific — e.g. East Asian, Afro-Caribbean, Mediterranean, Pacific Islander, Nordic — not generic "white" or "diverse")
   - age decade (mid-20s vs late-30s vs 50s reads completely different to an image model)
   - build — height + body type (tall and lanky / compact and broad-shouldered / petite / etc.)
   - skin tone
   - hair — color, length, texture, style
   - eye color
   - distinguishing facial features (face shape, nose, eyebrows, scars, freckles, jewelry, makeup)
   - signature wardrobe — specific garments, palette, era cues
   - posture / silhouette

2. **Preserve evidence from the prose.** Anything in the target's `evidence[]` quotes is a load-bearing detail — keep those cues intact. The same applies to `firstAppearance`. Only ADD specificity where the existing description is vague or silent.

3. **Differentiate from every peer.** Scan each peer's `physicalDescription` and `aliases`. On every axis above, pick a value that does NOT collide with any peer. If two peers already collide on an axis (both have "dark hair, mid-30s"), you don't need to match either — just pick a third option. When in doubt, push your target's choice further from the cluster.

4. **Length 50–100 words.** Dense, image-gen-ready phrasing. Do NOT use the target's name inside this field.

## Output contract

Return ONLY valid JSON, no markdown fence, no commentary:

```json
{
  "physicalDescription": "string",
  "rationale": "1-sentence summary of what you changed and which peers you pushed away from",
  "changes": ["short bullet of an axis you specified or shifted", "..."]
}
```
