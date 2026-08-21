# FableLoom — Branching Narratives

FableLoom is the Create-section workspace for branching narratives: stories a
reader plays through by *chatting their intent* rather than picking from a
fixed menu. A loom holds one or more episodes (like a series holds episodes);
each episode is a directed graph of scene nodes with multiple endings. Every
transition out of a scene is labeled with a reader **intent** ("sneak past the
guard") plus example phrasings — at read time an LLM matches the reader's
free-text message against those intents and moves them through the graph, or
answers in-world without leaving the scene when nothing matches.

## Concepts

| Term | Meaning |
|---|---|
| **Loom** | A branching-narrative story (`loom-*`): name/logline/premise, scene `format`, optional `playSettings` pin, optional `universeId` + `seriesId` links, episodes. |
| **Episode** | One playable graph (`ep-*`): title, synopsis (feeds generation), `startNodeId`, nodes. |
| **Scene node** | One story beat (`node-*`): prose, image prompt + rendered image, ending flag/label, transitions. |
| **Transition** | An intent-labeled edge (`tr-*`): `intent`, `triggers` (example phrasings), spoiler-safe `description`, `targetNodeId`. |

## Surfaces

- **`/fableloom`** — index: create/delete looms, link a universe (canon +
  style for AI) and optionally a pipeline series.
- **`/fableloom/:loomId/:episodeId/:nodeId?`** — the visual editor: an SVG
  scene-graph canvas (BFS-layered; drag to reposition, positions persist),
  a scene editor rail (prose, endings, intent paths, scene image), and a
  structure/review rail when nothing is selected. `?play=1` opens the reader
  drawer.
- **Play drawer** — the reader chat. Sessions are client-side state
  (restart is free; nothing persists server-side).
- **Story settings drawer** — scene format (plus the rewrite pass), and the
  narrator's provider/model/effort pin.

## Scene format

A loom is written either as **narrated prose** (second-person interactive
fiction) or as a **teleplay** (sluglines, action lines, character cues). The
choice lives on the record as `format` and is rendered into every generative
stage's prompt by `server/services/fableLoom/formats.js` — so weave, branch,
and play-turn narration all follow it, and the reader-facing scene cards
render a teleplay monospaced.

Changing the setting steers *new* generation only. **Story settings → Rewrite
all N scenes** runs `fableloom-reformat-scenes` over every scene of every
episode (in chunks, persisted as each chunk lands, so a mid-run failure keeps
what already succeeded) and re-pins the loom. It rewrites text only: ids,
transitions, endings, and image prompts are untouched.

## Playing: what costs an LLM call

`POST …/play` takes EITHER `message` (free text the play stage matches to a
path) or `transitionId` (a path the reader named outright). The second lane
resolves straight off the authored graph — no provider call, no wait — and
answers `resolvedBy: 'choice'`. Tapping a chip in the play drawer sends that
lane, so the common case of "the reader picked one of the offered paths" costs
nothing; only typed free text reaches `fableloom-play-turn`.

Which provider maps typed input is the loom's own `playSettings`
(`{ providerId, model, effort }`, set in Story settings). It beats the stage
pin — the author chose that narrator for that story — and a per-call override
in the request body beats both.

## AI lanes (all direct user actions; stage prompts in `data/prompts/stages/`)

| Stage | What it does |
|---|---|
| `fableloom-weave-episode` | Generates a full episode graph (scenes, intents, triggers, endings) from the loom premise + episode synopsis + linked-universe canon. |
| `fableloom-branch-node` | Grows N new intent-labeled branches out of one scene. |
| `fableloom-play-turn` | Resolves one reader message: `move` through a matched transition or `stay` with in-world narration. |
| `fableloom-review` | Story-editor critique (intent clarity, branch coherence, ending payoff) layered over the deterministic checks. |
| `fableloom-reformat-scenes` | Rewrites existing scenes into the loom's other format (prose ⇄ teleplay), preserving every beat and decision point. |

Deterministic graph validation (no LLM) lives in
`server/lib/fableLoomGraph.js` — reachability from the opening scene, dead
ends, dangling transitions, unreachable endings, duplicate/empty intents —
and renders in the editor's Structure panel via
`GET /api/fableloom/:id/episodes/:episodeId/validate`.

## Scene images

Each node carries an `imagePrompt`; **Generate** posts to the shared
`/api/image-gen/generate` queue with a `fableLoom: { loomId, episodeId,
nodeId }` destination tag. The completion hook
(`server/services/fableLoomSceneImageHook.js`) files the finished render onto
the node durably — even if the editor unmounted mid-render — with
newest-render-wins per node. The loom's `styleNotes` are appended to the
prompt for a consistent look.

## Storage

`fableloom_stories` (db-primary; one row per loom, full record in `data`
JSONB, `universe_id`/`series_id` mirrored as soft refs). **Machine-local — no
federation**: no dataSync category, no sync cursor, hard deletes (same posture
as Games / Writers Room). Service: `server/services/fableLoom/` (records /
weave / store / db); routes: `server/routes/fableLoom.js` (`/api/fableloom`).

## Relationship to the series pipeline

A loom can *link* to a pipeline series (`seriesId`) but is its own record
type — branching narratives don't run the linear issue/stage pipeline
(manuscript formats, autopilot, federation semantics don't apply to a graph).
Deeper integration (a branching series type surfaced inside series
management) is deliberately deferred.
