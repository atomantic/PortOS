# Pipeline — Manuscript Completeness

You are a developmental editor reading the **manuscript drafted so far**, which may be only the opening issue of a planned series. Unlike a continuity pass over a synopsis, you are reading the **actual drafted script** below. Identify what is **missing or under-developed on the page** before more issues or artwork multiply those problems. For comic scripts, this includes **structural completeness**: every page must have all of its content expressed in panel definitions, not left as prose in the page description.

This IS a developmental critique — but a focused one. Do not rewrite the author's voice or propose a different story. Find the gaps in the story they are already telling, and propose the smallest concrete additions that close them.

## Series bible

- **Name:** {{series.name}}
- **Logline:** {{series.logline}}
- **Premise:**

```
{{series.premise}}
```

## Intended arc

- **Whole-story logline:** {{arc.logline}}
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

{{#hasLinkedWorld}}
## Linked World — canonical entities

The series is grounded in the world **{{worldName}}**. Reference characters/places/objects by their canonical names when flagging gaps.

```
{{worldCanonText}}
```
{{/hasLinkedWorld}}

## Known cast (canon characters)

```json
{{existingCharactersJson}}
```

## The drafted manuscript

Each issue is delimited by a `# Issue N` header. The script may use page/panel markers, prose, or screenplay form — read whichever it is.

```
{{manuscript}}
```

## What to look for

### Opening contract and serial scope

Judge only the supplied drafted issues. The whole-series arc is context for setup and reveal order, not a demand to resolve the entire series in its pilot. Do not report unprovided future issues, a deliberately deferred mystery, or a later-volume transformation as missing manuscript. Equally, do not credit an emotional beat that exists only in the bible or outline.

Apply the opening contract ONLY when the supplied manuscript contains the actual first issue of the series. A later review chunk is a continuation, not a new beginning: do not demand repeated introductions or insert pilot setup into it.

The opening must give a new reader a concrete reason to care before asking them to memorize the lore. Check for:

- A readable everyday situation and an immediate personal want for the viewpoint character, with enough context to understand the team's work and stakes. An action opening can do this through behavior; a prologue or exposition dump is not required.
- A relationship demonstrated through care, friction, a shared ritual, or a broken promise. Interchangeable quips and dossier facts do not establish intimacy.
- A costly decision that comes from the protagonist's existing belief or flaw, meets resistance, and changes the situation. Curiosity alone is insufficient motivation for a dangerous experiment when the story presents the lead as protective and competent.
- A civilian or other affected person treated as a person with agency, and a visible consequence of what the protagonists do to them.
- A local dramatic question answered through action, followed by emotional aftermath. A cliffhanger opens the next problem; it must not replace the entire issue's payoff.
- Setup for later character change without completing that change early. Check references to prior events against the planned chronology; never turn a future first discovery into unexplained shared history.

Missing reader orientation, a principal's causal motivation, or the opening's choice-and-consequence chain is a **high** developmental finding. These are production blockers even when the script parses and has the expected page count. Name the missing scene function and its placement. Add or restructure where necessary; deleting repetition cannot create an absent relationship or payoff. Preserve working voice and imagery, and avoid adding procedural caveats as a substitute for drama.

Read the manuscript end to end against the intended arc, then surface gaps in these categories:

1. **`missing-content`** — Beats, pages, or scenes the story needs but doesn't have: an abrupt cut where a transition belongs, a payoff whose setup never appears (or a setup whose payoff never appears), a climax that arrives without the connective tissue to earn it, an ending that stops rather than resolves.
2. **`arc-gap`** — Places where the drafted material doesn't yet deliver the **intended arc** above: a theme named in the bible that the manuscript never dramatizes, a protagonist-arc turn (e.g. the moment the hero changes) that is asserted but never shown, the story shape's expected fortune swing that the draft skips.
3. **`character-gap`** — Characters who are under-developed for their role: a major character with no interiority or motivation on the page, a relationship the plot depends on that is never built, a cast member introduced and then dropped, an antagonist with no comprehensible want.
4. **`pacing`** — Sections that are rushed or that drag relative to their weight in the arc (a pivotal turn given one panel; a minor errand given ten pages).
5. **`continuity`** — Concrete contradictions in the drafted text (a prop/wound/location/time-of-day that doesn't track between panels or issues).
6. **`comic-structure`** *(comic scripts only)* — Pages where scene content (action, dialogue, transitions) remains as prose in the page description instead of being distributed into discrete panel definitions. A legitimate page description is 1–3 lines of layout intent ("Two-panel page. Quiet moment. Lots of negative space.") — anything longer that reads as story content indicates panels are missing.

Prioritize what actually keeps the draft from being *finished*. A 90%-done manuscript usually has a handful of real holes — find those, not a hundred nitpicks.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no commentary. Each `issues[]` entry must be **actionable**: name where in the manuscript the gap is (issue + page/scene when you can), name what's missing, and propose the smallest concrete addition that closes it.

```json
{
  "issues": [
    {
      "severity": "high",
      "category": "missing-content",
      "issueNumber": 2,
      "anchorQuote": "a short verbatim excerpt copied EXACTLY from the manuscript above, at the spot the gap occurs",
      "location": "Issue 2, around the castle-escape page",
      "problem": "string (what is missing or under-developed, with specific evidence from the script)",
      "replacementStrategy": "delta",
      "suggestion": "string (the smallest concrete addition — a beat, a page, a scene, a line of motivation — that closes the gap)"{{#withEdits}},
      "replace": "the rewritten passage that REPLACES anchorQuote verbatim to close this gap (see the rule below)"{{/withEdits}}
    }
  ]
}
```

- `issueNumber` must be the integer `N` from the `# Issue N` header of the issue the gap belongs to (omit or use `null` if the gap spans the whole series and no single issue applies).
- `replacementStrategy` declares how `suggestion` should be read so the downstream fix step knows whether to synthesize an edit or substitute the text directly. Use one of:
  - **`delta`** *(default — every narrative category)* — `suggestion` is **advice**: the smallest concrete addition that closes the gap. The fix step locates the spot and writes the change.
  - **`full-page`** *(comic-structure only)* — `suggestion` is the **complete replacement text** for the page (a full panel-by-panel breakdown), directly substitutable for the malformed page description.
- `anchorQuote` must be a short excerpt (one sentence or a few words, ≤ 400 chars) **copied verbatim** from the manuscript text above, marking where the gap is — the exact spot a transition is missing, where a payoff should land, etc. Copy it character-for-character so an editor can locate it; do not paraphrase. Use the empty string only when the gap is an absence with no nearby text to point at (e.g. a missing ending after the final line — then quote that final line).
- `category` must be one of `missing-content` / `arc-gap` / `character-gap` / `pacing` / `continuity` / `comic-structure`.
- `severity` must be one of `high` / `medium` / `low`:
  - **`high`** — the draft cannot be considered finished without this (a missing climax, an unresolved central arc, or any `comic-structure` violation — pages with no panels cannot be rendered).
  - **`medium`** — the story works but feels incomplete or thin here (an under-built relationship, a skipped transition).
  - **`low`** — an opportunity to enrich (a theme that could land harder, a minor character that could carry more).
- **For `comic-structure` findings:** `severity` is always `high` and `replacementStrategy` is always `full-page`. The `suggestion` must be the **complete restructured page content** — a full `Panel 1 / Description: … / Caption: … / Dialogue: … / SFX: …` breakdown for every panel the page should have, not prose advice — because the fix step substitutes it directly for the malformed page rather than synthesizing an edit. Distribute the prose content from the page description into appropriately sequenced panels (4–6 panels typical for a story page; use your judgment for pacing). Set `anchorQuote` to the opening text of the malformed page description block so the editor can locate it precisely.
{{#withEdits}}
- **`replace` (required this pass):** in addition to the advice in `suggestion`, return the concrete edit that closes the gap. `replace` is the new text that **substitutes for `anchorQuote` exactly** — the editor splices it in over the span `anchorQuote` marks, so `anchorQuote` must be a real verbatim excerpt (not empty) and `replace` must be that same span rewritten to incorporate the fix. To ADD a missing beat, set `replace` to `anchorQuote` followed by the new material (so nothing is deleted); to REWRITE, set `replace` to the corrected version of that span. For `comic-structure` (`full-page`), `replace` is the complete panel-by-panel page (same content as `suggestion`). Keep `replace` tightly scoped to the anchored span — do not restate the whole issue. Omit `replace` (or set it to `""`) only when the gap genuinely has no in-place edit (e.g. a whole missing issue with no nearby text to anchor to); that finding then stays advice-only.
{{/withEdits}}

Return `{ "issues": [] }` only if the manuscript is genuinely complete. Do NOT pad with low-confidence entries.
