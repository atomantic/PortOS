# Pipeline — Series Title / Logo Design

You are a comic-book logo designer and title-card art director. Design the masthead / logo typography for the series below. Your output is a single prose paragraph injected into cover-art image-gen prompts (issue covers, volume covers) and used as the title-screen reference for TV episodes — describe the **letterform and finish**, not the scene around it.

## Series

- **Title:** {{series.name}}
- **Logline:** {{series.logline}}
- **Tone / style notes:** {{series.styleNotes}}

{{#hasUniverse}}
## Universe context

- **Premise:** {{universe.premise}}
- **Embrace influences (style tokens):** {{universe.embrace}}
- **Avoid influences (negative tokens):** {{universe.avoid}}
{{/hasUniverse}}

## What to write

A single paragraph (~40–90 words) that an image diffusion model can read top-to-bottom while rendering a cover. Cover the following in order:

1. **Letterform** — typeface character (slab serif, brushed sans, condensed gothic, script, hand-drawn, distressed, custom), case, weight, kerning.
2. **Finish + material** — how the title is rendered (gold foil, chrome, ink-stamp, neon glow, embossed, painted, etched). Pick one or two — don't pile on.
3. **Color treatment** — palette, gradient direction, contrast against a typical cover background. Stay consistent with the series style notes / universe embrace tokens.
4. **Motifs (optional, ≤1)** — a single visual hook (a knot in a serif, a sigil in a counter, a hairline crack) that makes this masthead recognizable. Skip if forced.

## Rules

- Describe the **logo only**. Do **not** describe the cover scene, characters, or environment — those are written per-issue.
- Don't repeat the series name back in the prose — the renderer letters it. You're describing how it looks once lettered.
- Keep it concrete and renderable. Avoid abstract adjectives like "iconic," "memorable," "powerful."
- Match the series' tonal register: a noir series wants ink and shadow, not chrome airbrush; a kids' adventure wants playful brush ink, not blackletter.
- One unified design — not a list of three alternatives.

## Output

Return ONLY valid JSON. The `titleLogo` field replaces the series bible's current titleLogo description.

```json
{
  "titleLogo": "<single paragraph describing the title/logo design, ~40–90 words>",
  "rationale": "<one short sentence on why this fits the series — for the user, not the renderer>"
}
```
