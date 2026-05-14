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

- **5-act season** — pilot, complication, midpoint pivot, all-is-lost, finale.
- **8-episode arc** — pilot, complication, complication, midpoint, complication, complication, all-is-lost, finale.
- **12+** — add B-plot episodes between the structural beats; don't waste the count on filler.

For each episode write:

- **`number`** — 1-indexed within this season (NOT cumulative across the whole series). Sequential.
- **`title`** — short, evocative noun phrase. No generic "Pilot" / "Finale" unless it earns the irony.
- **`logline`** — one sentence; the question / image this episode opens with → resolves to.
- **`synopsis`** — 2–3 sentences. What *happens* in this episode at the arc level. Don't write scene blocking — keep it at the level a season planner needs.
- **`primaryCharacters`** — array of CAPS character names from the bible who carry the episode. Usually 1–3; never empty for a main character series.
- **`arcRole`** — single token describing the episode's structural job in this season. Pick one of: `pilot` / `complication` / `midpoint` / `b-plot` / `all-is-lost` / `finale`. Used downstream to verify the season has balanced shape.
- **`lengthProfile`** — single token sizing this episode for downstream prose / script / video generation. Pick one of:
  - `teaser` — promo / cold-open / mini-issue (~8 pages comic / ~10 min episode). Use sparingly, mostly for B-plot or anthology beats.
  - `standard` — the working default (~22 pages / ~24 min). Use for most episodes.
  - `extended` — premiere / set-piece episodes (~32 pages / ~36 min). Use for pilots that have to establish a lot of world, or mid-season turning points that earn extra runtime.
  - `finale` — season climax (~44 pages / ~48 min). Reserve for the actual `arcRole: 'finale'` episode (and occasionally `all-is-lost` if the budget allows). Don't apply to every episode — finale-length used everywhere becomes meaningless.

  Default to `standard` when nothing argues for a different size.

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
