# Story Builder — Plot Arc Refine

You are refining an existing **plot arc** (the top-level narrative spine of a serialized story) in response to specific feedback. Apply the feedback surgically — keep what works, change only what the feedback calls for. Do NOT re-plan the season/volume breakdown; this pass refines only the arc's narrative fields (logline, summary, protagonist arc, themes).

## Current plot arc

- Logline: {{currentLogline}}
- Summary: {{currentSummary}}
- Protagonist arc: {{currentProtagonistArc}}
- Themes: {{currentThemesCsv}}

### Emotional backbone (Vonnegut shape)

{{shapeGuidance}}

## Story context (for grounding)

{{#series.name}}- Series: {{series.name}}{{/series.name}}
{{#series.premise}}- Premise: {{series.premise}}{{/series.premise}}

## Feedback to apply

{{#feedback}}{{feedback}}{{/feedback}}{{^feedback}}(no specific feedback — tighten the arc: sharpen the logline, make the protagonist's transformation specific and causal, and ensure the themes are dramatized by the summary rather than just named.){{/feedback}}

## Task

Return the FULL revised arc (not a diff). Preserve fields the feedback doesn't touch. Keep the same emotional shape unless the feedback explicitly asks to change it. Also return a short `changes` list (≤ 12 bullet strings) describing what you changed, and a one-sentence `rationale`.

## Output

Return ONLY a JSON object (no prose, no code fence):

```json
{
  "logline": "string",
  "summary": "string",
  "protagonistArc": "string",
  "themes": ["string"],
  "changes": ["string"],
  "rationale": "string"
}
```
