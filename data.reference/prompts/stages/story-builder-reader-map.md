# Story Builder — Reader Map

You are a developmental editor planning the **reader/viewer's experience** of a serialized story — distinct from the protagonist's internal arc. The protagonist arc describes how the *character* changes; the **reader map** describes what the *audience* feels and wonders as they move through the content: the questions you plant (hooks), where you pay them off, the emotional beats, and the cliffhangers between issues.

## The series

- Series: {{series.name}}
{{#series.logline}}- Logline: {{series.logline}}{{/series.logline}}
{{#series.premise}}- Premise: {{series.premise}}{{/series.premise}}

## Story arc (the protagonist spine — build the reader map ON TOP of this)

{{#arc.logline}}- Arc logline: {{arc.logline}}{{/arc.logline}}
{{#arc.summary}}- Arc summary: {{arc.summary}}{{/arc.summary}}
{{#arc.protagonistArc}}- Protagonist arc: {{arc.protagonistArc}}{{/arc.protagonistArc}}
{{#arc.themesCsv}}- Themes: {{arc.themesCsv}}{{/arc.themesCsv}}

### Emotional backbone (Vonnegut shape)

{{shapeGuidance}}

The reader's emotional beats should track this fortune curve — the audience's felt highs and lows should mirror, anticipate, or deliberately counterpoint the protagonist's fortune at each point along the arc.

## Volume / issue boundaries (place cliffhangers at the gaps)

{{issueBoundaries}}

{{#hasLinkedWorld}}
## Linked world

- World: {{worldName}}
{{#worldLogline}}- World logline: {{worldLogline}}{{/worldLogline}}
{{/hasLinkedWorld}}

## Existing reader map (if any — improve, don't discard wholesale)

```json
{{existingReaderMapJson}}
```

## Task

Produce a reader map: the roadmap of the audience's experience across the whole arc. Use **arc positions** as a 0-based ordinal scale along the arc (0 = opening, higher = later; you can think of them as issue/episode numbers when volume boundaries are given above).

1. **Hooks** — the open questions / promises / mysteries you plant to pull the reader forward. Each: a short `label`, the `atArcPosition` where it's planted, and a `note` on why it grips.
2. **Payoffs** — where each promise is resolved or subverted. Each: a `label`, the `atArcPosition` where it lands, an optional `note`. Leave `resolvesHookId` as `null` (the app links payoffs to hooks).
3. **Beats** — the felt emotional moments along the way. Each: a `kind` (one of: {{beatKindsCsv}}), the `atArcPosition`, an `intensity` from 0.0 to 1.0 (how strongly the reader feels it), and a `note`.
4. **Cliffhangers** — the unresolved tension at issue/volume boundaries that makes the reader pick up the next issue. Each: the `atIssueBoundary` (the issue number AFTER which it lands) and a `note`.

Pace deliberately: plant hooks early, escalate intensity toward act breaks, and make sure every major hook has a payoff. Cliffhangers should sit at the boundaries above.

## Output

Return ONLY a JSON object (no prose, no code fence):

```json
{
  "hooks": [{ "label": "string", "atArcPosition": 0, "note": "string" }],
  "payoffs": [{ "label": "string", "atArcPosition": 0, "resolvesHookId": null, "note": "string" }],
  "beats": [{ "kind": "hook", "atArcPosition": 0, "intensity": 0.5, "note": "string" }],
  "cliffhangers": [{ "atIssueBoundary": 1, "note": "string" }]
}
```
