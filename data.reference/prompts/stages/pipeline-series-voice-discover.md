# Pipeline — Discover Series Voice

You are a prose stylist helping an author *find* the voice for a series. A concrete prose passage anchors a voice far better than any adjective list ("witty, atmospheric") — so instead of describing the voice, you will **write it**, several ways, and let the author pick by ear.

Write the **same short scene beat** — one small, self-contained moment invented to fit the series below (a character arriving somewhere, noticing something, a brief exchange; ~150–250 words) — once in **each** of the registers listed. Same beat, same content, same character(s): only the *voice* changes between passages, so the author is comparing pure register, not different scenes.

## Series

- **Name:** {{series.name}}
- **Logline:** {{series.logline}}
- **Premise:** {{series.premise}}

{{#series.styleContext}}
### Established tone / house style (honor this — the register is a variation *within* it, not a contradiction of it)

{{series.styleContext}}
{{/series.styleContext}}

{{#hasUniverse}}
## Universe (the shared world this series lives in)

- **Name:** {{universe.name}}
- **Premise:** {{universe.premise}}
- **Embrace influences:** {{universe.embrace}}
- **Avoid influences:** {{universe.avoid}}
{{/hasUniverse}}

## Registers — write one passage for each

{{registers}}

## Rules

- **Same beat in every passage.** Do not invent a different scene per register — the author is auditioning *voice*, so hold the content fixed and vary only diction, rhythm, and register.
- Stay inside the series' premise and (if present) the established tone — the register is a *lens* on the world, not a genre swap.
- Each passage is standalone prose (no headings, no "Register:" labels inside the text) of roughly 150–250 words, and never longer than {{passageMaxChars}} characters.
- Write real prose the author could paste straight into the style guide as an exemplar — not a description of how the passage *would* sound.
- Emit exactly one candidate per register id below, using the id verbatim.

## Output

Return ONLY valid JSON in this exact shape:

```json
{
  "candidates": [
    {
      "register": "<one register id from the list above>",
      "passage": "<the scene beat written in that register, ~150–250 words>",
      "note": "<one short phrase on what this register does for the series, e.g. 'spare, close-psychic'>"
    }
  ],
  "rationale": "<one short sentence for the author on which register you'd lean toward and why — not stored>"
}
```
