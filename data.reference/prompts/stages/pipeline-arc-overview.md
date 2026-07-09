# Pipeline — Series Arc Overview

You are a senior story editor sketching the **top-level multi-season story spine** for a new series. The user has a series bible (name, logline, premise, characters, target format, target issue count). The output gets persisted as `series.arc` + `series.seasons[]` and feeds every downstream per-season + per-episode prompt.

This is the most expensive single call in the pipeline (you reason over the full series scope) so be deliberate.

## Story shape (Vonnegut)

{{{shapeGuidance}}}

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

- **Target total episode count (rough budget across all seasons):** {{series.issueCountTarget}}

{{#hasLinkedWorld}}
## Linked World — canonical entities

The series is grounded in this World Builder world: **{{worldName}}**. When you write season loglines / synopses and the protagonist arc, ground them in these entities by name (not generic placeholders). If a world canon entry below names a character, place, or object that fits the season's beats, prefer it over inventing a new one.

### World canon — named characters, places, objects

```
{{worldCanonText}}
```
{{/hasLinkedWorld}}

{{> bible-deference }}

## How to shape the arc

1. **Logline (one sentence).** Pitch the whole multi-season arc — not the pilot. Should answer "what is this *show* about" if you only get 20 seconds in an elevator.
2. **Summary (~500 words).** Act structure across the whole series. Hit the rough turning points: where does the protagonist start, where do they pivot at the end of each season, where do they land at the series finale. Be specific enough that someone writing season 2 can tell whether their idea fits.
3. **Themes (2–5 short tags).** The recurring concerns — `betrayal`, `legacy`, `the cost of memory`, `class & inheritance`. Keep each tag short (≤80 chars).
4. **Protagonist arc.** Character growth across all seasons. Where does the protagonist start morally / emotionally, and where do they end. This is the spine for later character-consistency checks.
5. **Season outlines.** Break the arc into 2–5 seasons. Default to **3 seasons** if `issueCountTarget` is large enough; collapse to 2 if the premise is tight. For each season write:
   - **`number`** — 1-indexed, contiguous.
   - **`title`** — short noun phrase (e.g. *The Choir Awakens*, *Diaspora*, *Salt at the Root*). Avoid generic ones like "Pilot" or "Season 1".
   - **`logline`** — one sentence; what changes in this season.
   - **`endingHook`** — the image or line that pulls the audience into season N+1. Skippable for the final season (leave empty).
   - **`episodeCountTarget`** — integer. Divide `issueCountTarget` across the seasons roughly proportionally to season weight. Sum of all `episodeCountTarget`s should approximately equal `issueCountTarget`.
6. **Thread nesting (MICE).** Treat each season as opening and closing narrative threads (a Milieu / Inquiry / Character / Event question). Threads must close in the REVERSE order they open — the last thread opened is the first resolved, like nested brackets. In each season's `logline` (or the `summary`), name the thread this season OPENS and the thread it CLOSES, so the nesting is legible: a season that opens a thread it never closes leaves a dangling question; one that closes a thread out of order breaks the nesting.
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
  "protagonistArc": "string (character growth across all seasons)",
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
