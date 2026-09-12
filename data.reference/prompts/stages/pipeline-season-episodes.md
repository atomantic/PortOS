# Pipeline — Season Episode Breakdown

You are a writers-room showrunner planning the **episode-by-episode breakdown for one season** of a multi-season series. The series arc is already decided; you slot {{season.episodeCountTarget}} episodes into this season such that they (a) honor the season's logline + ending hook, (b) move the protagonist's whole-series arc forward, and (c) don't contradict the prior seasons' synopses.

## Series bible

- **Name:** {{series.name}}
- **Logline:** {{series.logline}}
- **Premise:**

```
{{series.premise}}
```

- **Style notes:** {{series.styleNotes}}

## Full-arc context

- **Whole-series logline:** {{arc.logline}}
- **Protagonist arc across all seasons:**

```
{{arc.protagonistArc}}
```

- **Themes:** {{arc.themesCsv}}

## Story shape (Vonnegut) — this season's curve placement

{{{shapeGuidance}}}

If a Series design brief is supplied above, treat it as authored intent. For renewable stories, consider recurring activity, varied episode problems/outcomes and continuing tensions; for finite stories, consider causal progress and the earned declared ending. Ground contradictions in the supplied episodes and use the existing actionable findings format when reviewing. At synopsis-only scope, limit conclusions to available material. A deliberate breather is valid; uncertainty alone does not warrant a finding. Do not invent a brief when absent, add sample-episode batches or future-season quotas, force character transformation, or change the configured issue count, reader map or emotional shape. Resolvers repair story material, never the brief.

**This season's expected emotional placement:** {{shapePosition}}

Pace the episodes you write so the season's fortune trajectory matches this placement. The first episode should open near the *level* implied by the prior season's ending, the finale episode should land at the *level* implied by this season's ending hook, and the in-between beats should bend the curve in the right direction — even when the per-episode `arcRole` would otherwise read as neutral.

{{> bible-deference }}

## Prior seasons (continuity — do not contradict)

```
{{priorSeasonsContext}}
```

## This season — the one you are planning

- **Number:** {{season.number}}
- **Title:** {{season.title}}
- **Logline:** {{season.logline}}
- **Synopsis:**

```
{{season.synopsis}}
```

- **Ending hook (where this season has to land):** {{season.endingHook}}
- **Episode count target:** {{season.episodeCountTarget}}

## How to shape the season

Plan an arc *within* the season that bends from "pickup state" (the natural starting point given prior seasons + the protagonist arc) to the **ending hook** in exactly `episodeCountTarget` beats. Common shapes:

- **6-beat season** — pilot, complication, midpoint pivot, all-is-lost, climax, finale.
- **8-episode arc** — pilot, complication, complication, midpoint, complication, all-is-lost, climax, finale.
- **12+** — add B-plot episodes between the structural beats; don't waste the count on filler.

### Structure rules (enforce while beating out the season)

- **Try-fail mandate.** 60%+ of the middle episodes (everything between pilot and climax) must end in complication, not clean success — "Yes, but…" (they get what they wanted, but it costs or backfires) or "No, and…" (they fail, and it gets worse). A run of clean wins stalls momentum.
- **Beat rules.**
  - Catalyst / pilot inciting event is EXTERNAL — it happens TO the protagonist; they don't choose it.
  - The pivot into the season's main conflict (Break Into Two) is a protagonist CHOICE — they decide to engage.
  - The all-is-lost beat includes a DEATH — literal, or the death of a hope, a relationship, or an identity.
- **Climax = the protagonist's hardest ACTIVE choice** between what they WANT (external goal) and what they NEED (the truth). They drive the decisive confrontation; it does not resolve itself around them.
- **Finale = consequence and denouement after the climax.** Pay off the season ending hook, land the emotional arc, and establish the new state without replaying the decisive confrontation.

For each episode write:

- **`number`** — 1-indexed within this season (NOT cumulative across the whole series). Sequential.
- **`title`** — short, evocative noun phrase. No generic "Pilot" / "Finale" unless it earns the irony.
- **`logline`** — one sentence; the question / image this episode opens with → resolves to.
- **`synopsis`** — 2–3 sentences. What *happens* in this episode at the arc level. Don't write scene blocking — keep it at the level a season planner needs.
- **`primaryCharacters`** — array of CAPS character names from the bible who carry the episode. Usually 1–3; never empty for a main character series.
- **`arcRole`** — single token describing the episode's structural job in this season. Pick one of: `pilot` / `complication` / `midpoint` / `b-plot` / `all-is-lost` / `climax` / `finale`. Used downstream to verify the season has balanced shape. The `climax` must precede a distinct later `finale`.
- **`lengthProfile`** — single token sizing this episode for downstream prose / script / video generation. Pick one of:
  - `teaser` — promo / cold-open / mini-issue (~8 pages comic / ~10 min episode). Use sparingly, mostly for B-plot or anthology beats.
  - `standard` — the working default (~22 pages / ~24 min). Use for most episodes.
  - `extended` — premiere / set-piece episodes (~32 pages / ~36 min). This is the preferred default for `arcRole: 'climax'`, giving the decisive confrontation room without forcing the denouement to share its issue.
  - `finale` — season-closing issue (~44 pages / ~48 min). Reserve for the actual `arcRole: 'finale'` episode (and occasionally `all-is-lost` if the budget allows). Don't apply to every episode — finale-length used everywhere becomes meaningless.

  Default `climax` to `extended`, `finale` to `finale`, and all other roles to `standard` when nothing argues for a different size.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no commentary:

```json
{
  "episodes": [
    {
      "number": 1,
      "title": "string",
      "logline": "string",
      "synopsis": "string",
      "primaryCharacters": ["NAME", "..."],
      "arcRole": "pilot",
      "lengthProfile": "standard"
    }
  ]
}
```
