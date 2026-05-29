# Story Builder — Reader Map Refine

You are refining an existing **reader map** (the roadmap of what the audience feels and wonders across a serialized story) in response to specific feedback. Apply the feedback surgically — keep what works, change only what the feedback calls for.

## Current reader map

```json
{{currentReaderMapJson}}
```

## Story context (for grounding)

{{#arcSummary}}- Arc summary: {{arcSummary}}{{/arcSummary}}
{{#protagonistArc}}- Protagonist arc: {{protagonistArc}}{{/protagonistArc}}

### Emotional backbone (Vonnegut shape)

{{shapeGuidance}}

## Feedback to apply

{{#feedback}}{{feedback}}{{/feedback}}{{^feedback}}(no specific feedback — tighten pacing: ensure every hook has a payoff, escalate intensity toward act breaks, and place cliffhangers at issue boundaries.){{/feedback}}

## Task

Return the FULL revised reader map (not a diff). Preserve entries the feedback doesn't touch. Beat `kind` must be one of: {{beatKindsCsv}}. `intensity` is 0.0–1.0. Leave `resolvesHookId` as `null`. Also return a short `changes` list (≤ 12 bullet strings) describing what you changed, and a one-sentence `rationale`.

## Output

Return ONLY a JSON object (no prose, no code fence):

```json
{
  "hooks": [{ "label": "string", "atArcPosition": 0, "note": "string" }],
  "payoffs": [{ "label": "string", "atArcPosition": 0, "resolvesHookId": null, "note": "string" }],
  "beats": [{ "kind": "hook", "atArcPosition": 0, "intensity": 0.5, "note": "string" }],
  "cliffhangers": [{ "atIssueBoundary": 1, "note": "string" }],
  "changes": ["string"],
  "rationale": "string"
}
```
