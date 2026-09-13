# Pipeline — Series Arc Overview

You are a senior story editor sketching the **top-level whole-series story spine** for a new series. The user has a series bible (name, logline, premise, characters, target format, target issue count). The output gets persisted as `series.arc` + `series.seasons[]` (volumes) and feeds every downstream per-volume + per-episode prompt.

This is the most expensive single call in the pipeline (you reason over the full series scope) so be deliberate.

## Story shape (Vonnegut)

{{{shapeGuidance}}}

If a Series design brief is supplied above, treat it as authored intent. For renewable stories, consider recurring activity, varied episode problems/outcomes and continuing tensions; for finite stories, consider causal progress and the earned declared ending. Ground contradictions in the supplied episodes and use the existing actionable findings format when reviewing. At synopsis-only scope, limit conclusions to available material. A deliberate breather is valid; uncertainty alone does not warrant a finding. Do not invent a brief when absent, add sample-episode batches or future-season quotas, force character transformation, or change the configured issue count, reader map or emotional shape. Resolvers repair story material, never the brief.

{{#pickedShapeId}}
The user has pre-picked this shape. Your `seasonOutlines` MUST trace this fortune curve — each volume's logline and endingHook should reflect its position on the curve (low → rising → peak → falling → recovery → triumph, etc., per the shape's beats). Include `"shape": "{{pickedShapeId}}"` verbatim in your JSON output so the picked shape round-trips.
{{/pickedShapeId}}
{{^pickedShapeId}}
No shape pre-picked. Choose the single Vonnegut shape that best matches the premise's emotional trajectory (allowed: {{allowedShapeIdsCsv}}). Your `seasonOutlines` MUST trace the chosen curve. Return your pick as `"shape": "..."` in the JSON output — exactly one of the allowed ids.
{{/pickedShapeId}}

## Series bible

- **Name:** {{series.name}}
- **Target format:** {{series.targetFormat}} (`comic`, `tv`, or `comic+tv` — when both, the arc must work as a single TV season but also slice cleanly into comic issues)
- **Logline:** {{series.logline}}
- **Premise:**

```
{{series.premise}}
```

- **Style notes (tone / aesthetic):**

```
{{series.styleNotes}}
```

- **Target total episode count (rough budget across all volumes):** {{series.issueCountTarget}}

- **Recommended volume structure for this target:** {{recommendedStructure}}

Treat that recommendation as the default unless the premise supplies a concrete
reason to depart from it. In particular, do not inflate a 12-issue limited
series into three volumes merely because multi-volume fiction is possible.

{{#hasLinkedWorld}}
## Linked World — series-scoped canonical entities

The series is grounded in this World Builder world: **{{worldName}}**. The
starter idea is the user's protected originating intent; generated world fields
and canon elaborate it but may not replace its ontology, protagonists, or core
story engine. If a generated field conflicts with the starter idea, follow the
starter idea and repair the derived plan around it.

- **Protected author intent (starter idea):** {{worldStarter}}
- **World logline:** {{worldLogline}}
- **World premise:**

```
{{worldPremise}}
```

- **World style notes:**

```
{{worldStyleNotes}}
```

- **Influences to embrace:** {{worldInfluencesEmbrace}}
- **Influences to avoid:** {{worldInfluencesAvoid}}

The named canon below has been scoped to entities demonstrably tied to this
series' current protected premise and character arcs. Treat those characters as
the presumed principals. Do not promote omitted world records, abandoned-draft
antagonists, factions, or institutions into the story merely because they exist
elsewhere in the shared world. Add supporting entities only when the active
ensemble cannot carry a necessary function.

When you write volume loglines / synopses and the protagonist arc, ground them
in the scoped canonical entities below by name (not generic placeholders).

### World canon — named characters, places, objects

```
{{worldCanonText}}
```
{{/hasLinkedWorld}}

{{> bible-deference }}

## How to shape the arc

1. **Logline (one sentence).** Pitch the whole-series arc — not the opening issue. It should answer "what is this series about" in 20 seconds.
2. **Summary (~500 words).** Act structure across the whole series. Hit the rough turning points: where do the principals start, which choices pivot each volume, and where do they land at the series finale. Be specific enough that someone expanding any volume can tell whether an idea fits.
3. **Themes (2–5 short tags).** The recurring concerns — `betrayal`, `legacy`, `the cost of memory`, `class & inheritance`. Keep each tag short (≤80 chars).
4. **Protagonist arc.** Character growth across the complete volume plan. Where does the protagonist start morally / emotionally, and where do they end. This is the spine for later character-consistency checks.
5. **Volume outlines.** Break the arc into 1–5 volumes, following the recommended structure above unless story weight clearly requires a different division. A single 12-issue volume is a complete valid structure; never add volumes just to reach an arbitrary default. For each volume write:
   - **`number`** — 1-indexed, contiguous.
   - **`title`** — short noun phrase (e.g. *The Choir Awakens*, *Diaspora*, *Salt at the Root*). Avoid generic ones like "Pilot" or "Season 1".
   - **`logline`** — one sentence; what changes in this volume.
   - **`endingHook`** — the image or line that pulls the audience into volume N+1. Skippable for the final volume (leave empty).
   - **`episodeCountTarget`** — integer. Divide `issueCountTarget` across the volumes roughly proportionally to story weight. The sum should approximately equal `issueCountTarget`.
6. **Thread nesting (MICE).** Treat each volume as opening and closing narrative threads (a Milieu / Inquiry / Character / Event question). Threads must close in the REVERSE order they open — the last thread opened is the first resolved, like nested brackets. In each volume's `logline` (or the `summary`), name the thread this volume OPENS and the thread it CLOSES, so the nesting is legible: a volume that opens a thread it never closes leaves a dangling question; one that closes a thread out of order breaks the nesting.
7. **Foreshadowing ledger (2–6 seeds).** Plan the major setups the series plants early and pays off later — a Chekhov's gun, a prophecy, an unexplained scar, a withheld secret. For each seed record:
   - **`label`** — a short name for the seed (e.g. *The locked room*, *Mara's limp*, *The recurring bell*).
   - **`plantIssue`** — the 1-indexed issue number where it's first planted (subtly introduced, not explained).
   - **`reinforceIssues`** — 0 or more issue numbers between plant and payoff where the seed is quietly reinforced so the reader doesn't forget it. Keep it a light touch — a glimpse, not a recap.
   - **`payoffIssue`** — the issue number where it fires / is resolved.
   - **`note`** — one sentence on what the payoff delivers.
   - **Distance rule:** `payoffIssue` must be **at least 3 issues after** `plantIssue`. A payoff that lands right after its plant isn't foreshadowing — it's just setup-and-immediate-use. Spread seeds so the reader has time to forget before the gun fires.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no commentary:

```json
{
  "logline": "string (the whole-series pitch, one sentence)",
  "summary": "string (~500 words, multi-paragraph plain text — escape newlines as \\n)",
  "themes": ["string", "..."],
  "protagonistArc": "string (character growth across the complete volume plan)",
  "shape": "one of: rags-to-riches | tragedy | man-in-hole | icarus | cinderella | oedipus | boy-meets-girl | creation-story",
  "seasonOutlines": [
    {
      "number": 1,
      "title": "string",
      "logline": "string",
      "endingHook": "string",
      "episodeCountTarget": 8
    }
  ],
  "foreshadowing": [
    {
      "label": "string (short name for the planted seed)",
      "plantIssue": 1,
      "reinforceIssues": [3],
      "payoffIssue": 6,
      "note": "string (what the payoff delivers)"
    }
  ]
}
```
