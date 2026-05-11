# Pipeline — Extract Scenes from TV Teleplay

You are a script supervisor parsing an already-broken-out TV teleplay into a structured scene list the storyboard pipeline can render. The teleplay has sluglines and dialogue **already in place** — you are not re-imagining the structure, you are translating screenplay format into JSON. Each scene becomes one storyboard image.

## Series

- **Title:** {{series.name}}
- **Tone / style:** {{series.styleNotes}}

## Episode

- **Number:** {{issue.number}}
- **Title:** {{issue.title}}

{{> bible-deference }}

## Source — TV teleplay (markdown)

```
{{teleplay}}
```

## Granularity — read carefully

The teleplay's sluglines (`**INT./EXT. LOCATION — TIME**`) define scene boundaries. **Produce one entry per slugline.** Do NOT split a screenplay scene into multiple panels even if it's long; do NOT merge two screenplay scenes into one. The writer chose those breaks intentionally for episode pacing.

If the teleplay uses act headers (`## TEASER`, `## ACT ONE`, `## ACT TWO`, ...) treat them as structural markers — do not produce a scene for the act header itself; carry the act name on the next scene's `heading` so the storyboard order preserves it.

## For each scene, write

- **`heading`** — short noun phrase summarizing the visual moment (e.g. `Scene 12 — Squid Arm Rises`). If the teleplay opens the scene with an evocative action line, mine that; otherwise distill the slugline + first action paragraph.
- **`slugline`** — verbatim from the teleplay (`INT. KITCHEN — NIGHT`), uppercase, no markdown bold.
- **`summary`** — 1–2 sentences naming what's *visible* in this scene. Lift from the action lines.
- **`characters`** — list of CAPS character names that have dialogue in this scene + named characters in the action lines.
- **`action`** — ≤ 3 sentences in present tense. Trim the action paragraphs down to the visual essentials.
- **`dialogue`** — `[{ "character": "NAME", "line": "..." }]` for every spoken line in the scene, in order. Empty array if the scene is silent.
- **`visualPrompt`** — a self-contained image-gen prompt (~30–60 words) describing the scene as a still frame: subjects, location, lighting, mood, camera framing, time of day. Bake in genre/era cues from the series style notes. Do NOT reference characters by name — describe them physically so an image model with no story context can render them.
- **`sourceSegmentIds`** — keep empty.

{{> scene-output-contract }}
