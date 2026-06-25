# Pipeline — Beat Continuity Auto-Resolve

You are a senior story editor cleaning up a planned series so it passes the whole-manuscript **beat-continuity** check. A continuity pass over the per-issue **beat sheets** returned a list of cross-issue structural findings. Your job is to rewrite the **beats of the specific issues that caused each finding** so every finding is resolved — while preserving as much of the author's original beats as possible.

Every series is published as both a graphic novel (issues → volumes) AND a TV series (episodes → seasons). One issue == one episode. Your edits are at the **beat** layer (no script has been generated yet), so editing them is safe and cheap — that is the whole point of fixing here instead of after the full scripts exist.

## Series bible

- **Name:** {{series.name}}
- **Logline:** {{series.logline}}
- **Premise:**

```
{{series.premise}}
```

{{#hasLinkedWorld}}
## Linked World — canonical entities

The series is grounded in this World Builder world: **{{worldName}}**. Ground rewritten beats in these entities by name.

```
{{worldCanonText}}
```
{{/hasLinkedWorld}}

{{> bible-deference }}

## Intended whole-series shape

- **Whole-series logline:** {{arc.logline}}
- **Themes:** {{arc.themesCsv}}
- **Protagonist arc:**

```
{{arc.protagonistArc}}
```

- **Arc summary:**

```
{{arc.summary}}
```

## Story shape (Vonnegut)

{{{shapeGuidance}}}

Preserve the picked shape — the issue-level beats must still trace this curve after your edits.

## Volumes + issues (current beats)

Each issue carries its current `beats` (or a `synopsis` if not yet expanded). The `number` is the series-global episode number you will key corrections to.

```json
{{seasonsTreeJson}}
```

## Findings to resolve

Resolve **every** one of these:

```json
{{findingsJson}}
```

## How to resolve

1. **Edit beats, not the arc.** This pass only rewrites per-issue beat sheets. Do NOT propose arc/volume synopsis changes here — if a finding could ONLY be fixed by restructuring volumes, say so in `notes` and leave the beats untouched.
2. **Anchor each fix in the issue that *originates* the problem.** A dropped cliffhanger is fixed by adding the payoff beat to the issue that should carry it (or removing the dangling setup); a duplicated "first" is fixed by demoting the later occurrence in that issue's beats; a finale that drifts is fixed by rewriting the final issue's beats to land the arc. Make the **smallest** change that removes the contradiction while preserving the issue's dramatic purpose.
3. **Read each finding's `problem` + `suggestion`.** The suggestion is a hint, not gospel — but the resulting beats MUST make the finding go away.
4. **Only rewrite issues that already have beats.** An issue still at synopsis depth has no beats to edit — skip it (omit it from `episodes[]`); it'll be expanded later from the corrected arc.
5. **Never delete an issue** — omit it from `episodes[]` to leave its beats exactly as they are.
6. **Preserve cross-issue consistency.** When you change a beat that another issue depends on, make sure your set of edits is internally consistent across all the issues you touch.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no commentary:

```json
{
  "episodes": [
    {
      "seasonNumber": 3,
      "episodeNumber": 23,
      "beats": "string (the FULL corrected beat sheet for this issue — escape newlines as \\n)"
    }
  ],
  "notes": "string (optional — flag any finding you could only partially resolve at the beat layer, or that needs an arc-level restructure. Empty string if every finding is fully addressed.)"
}
```

The `episodes[]` array is a SPARSE list of beat rewrites — include only the issues you actually changed. Each `beats` value REPLACES that issue's current beat sheet in full, so write the complete corrected beats, not a delta. Issues you don't list are left exactly as they are.
