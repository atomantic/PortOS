# Pipeline — Series Arc Verification

You are a continuity editor doing a cross-volume pass on a planned series. The user has authored an arc and volume plan, and may not yet have per-episode breakdowns — your job is to surface **structural problems before the production pipeline burns LLM + GPU minutes on broken material**. This is NOT a taste-only critique; flag contradictions, protected-intent drift, and structural breaks with the smallest concrete repair.

## Series bible

- **Name:** {{series.name}}
- **Target format:** {{series.targetFormat}}
- **Logline:** {{series.logline}}
- **Premise:**

```
{{series.premise}}
```

{{> bible-deference }}

{{#hasLinkedWorld}}
## Linked World — protected intent + series-scoped canon

The series is grounded in this World Builder world: **{{worldName}}**.

- **Protected author intent (starter idea):** {{worldStarter}}
- **World logline:** {{worldLogline}}
- **World premise:**

```
{{worldPremise}}
```

The starter idea is the user's authoritative originating contract. Generated
world fields, named canon, and the proposed arc may elaborate it but may not
replace its ontology, protagonists, or central dramatic engine. The named canon
below is scoped to this series; omitted shared-world records are not evidence
that an old draft's cast, villain, faction, or institution belongs in this arc.

### World canon — named characters, places, objects

```
{{worldCanonText}}
```

### World entity categories — established factions, locations, technology

```
{{worldCategoriesText}}
```

### World composite reference sheets

```
{{worldCompositesText}}
```

The categories and composites above are **established world canon**, not exploratory scratch.
A faction, location, vehicle, artifact, or interface listed there is grounded
even when no named-canon record exists for it — the canon trunks above stay
empty until prose mints entities into them. Do NOT report such an entity as
invented, un-canonized, or absent from the world bible; check this block before
flagging any entity as ungrounded.
{{/hasLinkedWorld}}

## Full arc

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

## Volumes + episodes

```json
{{seasonsTreeJson}}
```

{{#arcSpineOnly}}
This is the pre-episode **arc-spine checkpoint**. Judge the protected premise,
active principals, whole-series dramatic engine, character causality, and
volume allocation. Episode arrays are intentionally empty: do not flag missing
episodes, episode arc roles, or episode-level continuity. The spine must be safe
to expand before episode generation begins.
{{/arcSpineOnly}}

## What to look for

This is an **exhaustive inventory, not a sample**. Walk the whole arc and every
volume in order, finish every check below, and reconcile every repeated fact
before drafting the response. Finding one defect must not stop the audit. Return
every distinct, evidence-backed high/medium issue in this response; consolidate
duplicates that share one root cause, but do not hold valid findings for a later
pass. A clean result means the entire supplied plan was checked.

Score each volume + each episode against the arc. Specifically check:

1. **Protected-intent drift.** Does the plan replace the originating protagonists, ontology, or core story engine with an incompatible cast, villain, institution, or conflict? Does it demote a living nonhuman principal into a tool when the premise gives it an independent need?
2. **Character causality and contradictions.** Do the active principals' wants, needs, choices, and relationships cause the major turns? Did a major character end volume N in a state that contradicts volume N+1's opening, or die and later speak without explanation?
3. **Dropped subplots.** A subplot introduced in an early volume's `endingHook` or episode `synopsis` that never resolves in a later volume or episode.
4. **Episode-count vs. arc-weight mismatch.** A volume with `episodeCountTarget: 12` whose synopsis carries only 3 meaningful turns, or a short volume carrying a full novel's weight.
5. **Unresolved hooks at the series finale.** The final volume fails to pay off the whole-arc logline, protagonist arc, or major themes.
6. **Arc-role imbalance.** Once episodes exist, a volume with 8 episodes and zero `pilot` / `finale` `arcRole` entries (or duplicate pilots/finales).
7. **Theme drift.** A theme is named in `arc.themes` but does not appear in any volume synopsis or episode logline.
8. **Story-shape adherence.** If a Vonnegut shape was selected, verify the volume-level fortune trajectory traces that curve. The whole-series finale must land at the shape's terminal level.
9. **Cross-record fact reconciliation.** Compare the full-arc summary,
   protagonist arc, and volume/episode synopses for:
   - travel geography and whether ordinary movement is actually local after each extraordinary crossing;
   - authorization scope, passenger/cargo manifests, custody, consent, and recall rights;
   - resource quantities, deadlines, extensions, and who approves them;
   - the issue/episode where each irreversible character choice happens, so a milestone is neither spent early nor repeated;
   - issue/episode load, so independent climaxes have room for setup, resistance, choice, and consequence.
10. **Dramatic economy.** Once episodes exist, each synopsis needs a concrete
    goal, obstacle, consequential choice, and changed situation. Flag a plan
    dominated by permissions, ledgers, clauses, exceptions, or repeated
    statements of what nobody may do. Procedural precision can support a turn;
    it is not a substitute for one. Adjacent episodes must not resolve the same
    conflict by making another authority relinquish control.
11. **Planning altitude and metadata fit.** An episode synopsis is a drafting
    seed, not a near-manuscript or a running continuity appendix. Roughly
    150–300 words is usually enough; above 450 words is a medium concern unless
    the episode demonstrably needs the complexity, and above 700 is high. Flag
    append-only caveats, duplicated facts, or minor procedures that bury the
    dramatic turn. The title, `arcRole`, and `lengthProfile` must describe what
    the episode actually does — especially pilot, midpoint, all-is-lost, and
    finale labels. The numeric `pageTarget` and `minutesTarget` are the
    materialized scope for both presets and custom profiles; judge whether the
    planned action can actually fill that space without padding or compression.
12. **Premise-engine continuity.** Track every major quest or promise in the
    originating premise across the whole series. A survival, rescue, romance,
    or institutional subplot must not silently erase a co-equal search, mystery,
    relationship, or personal need. The finale may defer an engine only through
    a visible choice that preserves a credible next step or payoff.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no commentary. Each `issues[]` entry must be **actionable** — name the volume and (if applicable) the episode that's broken, name the rule it breaks, and propose a concrete fix the user can apply by editing the offending record:

```json
{
  "issues": [
    {
      "severity": "high",
      "location": "volume:2 / episode:5",
      "problem": "string (what's wrong, with the specific evidence)",
      "suggestion": "string (the smallest edit that resolves it)"
    }
  ]
}
```

`severity` must be one of `high` / `medium` / `low`:

- **`high`** — would break a viewer's understanding of the story (dead character speaking, contradictory protagonist state).
- **`medium`** — would make the story feel sloppy (dropped subplot, unbalanced volume).
- **`low`** — opportunity to tighten (under-used theme, missing arc-role variety).

Return `{ "issues": [] }` if everything checks out. Do NOT pad with low-confidence "consider also..." entries.
