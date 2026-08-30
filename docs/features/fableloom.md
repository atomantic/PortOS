# FableLoom — Branching Narratives

FableLoom is the Create-section workspace for interactive video narratives.
A loom progresses from a text teleplay, through storyboard stills, to rendered
video clips without changing its graph. Each node is one comic-panel-like
camera cut and one eventual video file. Automatic cuts play once and continue;
decision nodes loop while the viewer chooses a path or gives free-text
feedback—when that story's audience role permits it. A loom holds one or more ordered episodes, and the Play surface can
rehearse the same experience at any of those three production stages.

## Concepts

| Term | Meaning |
|---|---|
| **Loom** | A branching-narrative story (`loom-*`): name/logline/premise, scene `format`, audience `participationMode`, helper `audienceCommunicationMedium`, optional canonical Universe protagonist/wardrobe pin, optional `playSettings` pin, optional `universeId` + `seriesId` links, episodes. |
| **Episode** | One playable graph (`ep-*`): title, synopsis (feeds generation), an optional validated `storyOutline` of log-line beats, `startNodeId`, nodes. |
| **Scene node** | One camera cut (`node-*`): teleplay/prose, image prompt/render, single-clip video prompt/render, camera movement, `playbackMode`, `audienceConnection`, `protagonistPresence`, ending state, transitions. |
| **Transition** | An intent-labeled edge (`tr-*`): `intent`, `triggers` (example phrasings), spoiler-safe `description`, `targetNodeId`. |

## Playback contract

`playbackMode` is the explicit difference between editing a graph and playing
an interactive video:

| Mode | Graph contract | Runtime behavior | Video direction |
|---|---|---|---|
| **`cut`** | Exactly one outgoing `Continue` transition unless it is an ending. | Video plays once and follows that transition automatically. Text/image previews expose **Next cut** because they have no media duration. | One irreversible setup/action/reaction beat is fine; the clip ends where the next camera setup begins. |
| **`decision`** | One or more intent paths (or an ending). | Video loops while path chips and free-text input remain available. | The visible situation must loop seamlessly and remain unresolved: pacing, watching, waiting, searching, holding position—not an action that completes once. |

For example, `A → B → C`: A and B are automatic setup cuts. C is a decision
node showing a guard pacing a hallway in a repeatable loop while the viewer
tells the unseen character when to cross. The response resolves one of C's
transitions, playback leaves the loop, and automatic cuts can resume.

The deterministic validator rejects an automatic cut without exactly one next
path. Legacy nodes default to `decision`; an upgrade therefore never starts
auto-advancing an existing choice story without an author edit or reweave.

## Audience participation

Every loom chooses one of two roles:

- **Helper (the new-story default and primary experience).** The protagonist
  has independent agency. The audience enters the fiction as themselves and
  advises the protagonist through a configured medium such as a radio,
  telepathic link, magic device, or phone.
- **Protagonist.** The audience directly chooses the protagonist's actions,
  preserving classic choose-your-own-adventure behavior. Looms created before
  this setting existed read as protagonist mode for compatibility.

Helper stories annotate every scene with `audienceConnection`. The opening is
passive canon (`disconnected`) until the story visibly activates the configured
medium close to the beginning and invites the audience to participate. Only a
`connected` scene may wait at a decision loop or accept typed input. If the
medium is lost, stolen, broken, or jammed, disconnected scenes continue through
their single automatic canon path until a later scene restores the connection.
The graph validator flags helper episodes that never connect, connect too late,
or expose a decision while disconnected.

Story settings also pin the canonical protagonist to one Universe character and
optionally one locked wardrobe. The scene editor shows the character's sheet
and approved identity-pack readiness, offers a one-click visual-cast binding,
and lets each scene choose on-screen or off-screen presence. An off-screen
connected decision is the side-device conversation: its decision image omits
the protagonist while the loop remains visible to the host. The server-side
visual compiler applies the canonical wardrobe to every on-screen protagonist
binding and records the presence decision in render provenance, so stale
scene-local clothes cannot silently reappear between episodes.

## Surfaces

- **`/fableloom`** — index: create/delete looms, link a universe (canon +
  style for AI) and optionally a pipeline series.
- **`/fableloom/:loomId/:episodeId/:nodeId?`** — the visual editor: an SVG
  scene-graph canvas (BFS-layered; orthogonal port-fanned edges; drag to
  reposition on desktop, positions persist). Below the editor-rail
  breakpoint the graph flips top-to-bottom (and ignores persisted `pos`) so
  it scrolls instead of pan-clipping. A scene editor rail (prose, endings,
  intent paths, scene image) sits beside the canvas on large screens and
  below it on small ones, with a path strip for inbound/outbound intents
  when the graph is stacked. `?play=1` opens the reader drawer.
- **`/fableloom/:loomId/:episodeId/outline`** — a text-first episode outline:
  the saved beat outline appears first, followed by reachable teleplay scenes in
  story order with their authored prose, endings, and reader paths. Unreachable
  scenes remain visible in a separate section, and path destinations return to
  the matching scene in the visual editor.
- **Episode setup → Story beats → teleplay** — the production gate: draft one
  concise log-line per eventual camera cut, edit paths and audience-channel
  states, run the deterministic validator, and optionally ask the AI story
  editor to review the arc. Teleplay expansion is blocked until every episode
  in the series has a valid beat outline and any configured voicemail/finale
  teaser handoffs have authored text.
- **Play drawer** — an interactive production preview with **Text**,
  **Storyboard images**, and **Rendered video** modes. All three traverse the
  same graph. Rendered automatic cuts advance on the video's `ended` event;
  rendered decision nodes loop. At an episode ending the player continues to
  the next ordered episode, allowing a full loom/series read-through. Sessions
  are client-side state (restart is free; nothing persists server-side).
- **Story settings drawer** — audience role and communication medium, scene
  format (plus the rewrite pass), and the narrator's provider/model/effort pin.
- **Series detail page** (`/pipeline/series/:seriesId`) — a "Branching
  narratives" card lists the looms linked to that series (counts + a link into
  the editor) and spawns a new one pre-linked to the series and its universe.
  The series index badges each row with its loom count.

## Editing paths

A transition is its own sub-resource under its scene, so any writer — the
editor rail, a voice action, a CoS agent — adds or edits ONE edge per call
and never replays the array off a snapshot another writer has already moved:

| Route | Answers with |
|---|---|
| `POST   /api/fableloom/:id/episodes/:episodeId/nodes/:nodeId/transitions` | `{ loom, transition }` — the server mints the `tr-*` id |
| `PATCH  …/transitions/:transitionId` | the loom |
| `DELETE …/transitions/:transitionId` | the loom |

The node PATCH still accepts a whole `transitions` array for a bulk replace
(unchanged, and what a client from before these routes uses). The editor rail
creates a path server-side first, so every row it holds already carries its
id and nothing has to be reconciled back after a save.

## Scene format

A loom is written either as **narrated prose** (second-person interactive
fiction) or as a **teleplay** (sluglines, action lines, character cues). The
choice lives on the record as `format` and is rendered into every generative
stage's prompt by `server/services/fableLoom/formats.js` — so weave, branch,
and play-turn narration all follow it, and the reader-facing scene cards
render a teleplay monospaced.

Changing the setting steers *new* generation only. **Story settings → Rewrite
N scenes** runs `fableloom-reformat-scenes` over the scenes not already in the
target format. It rewrites text only: ids, transitions, endings, and image
prompts are untouched.

The rewrite is **one request per episode** —
`POST /api/fableloom/:id/episodes/:episodeId/reformat`, with the drawer walking
the episodes that still have work and naming the one in flight. A whole-loom
rewrite used to run every provider call behind a single held request (227s on a
13-scene loom, and tens of minutes on a large one), long enough for a proxy or
fetch timeout to kill the response while the server kept writing. Each request
is capped at 20 scenes; a response that stopped there says `capped: true` and
the drawer asks the same episode again, so a long episode is several bounded
requests rather than one open-ended one.

Two properties survive that split:

- **Resumability.** Each chunk of 5 scenes is persisted as it lands and stamped
  with the format it was written in, so a mid-run failure keeps what already
  succeeded and re-running rewrites only what is left.
- **No half-and-half loom.** The loom's `format` pin is written by the *server*,
  and only once no episode has an unconverted scene left — so a browser closed
  mid-walk can't leave the loom claiming a format half its story isn't in.
  Until then the run reports what remains and the drawer says to run it again.

## Playing: traversal and LLM cost

`POST …/play` takes EITHER `message` (free text the play stage matches to a
path) or `transitionId` (a path the reader named outright). The second lane
resolves straight off the authored graph — no provider call, no wait — and
answers `resolvedBy: 'choice'`. Tapping a chip and automatic cut advancement
both send that cheap lane, so neither costs an LLM call. Only typed free text
at an available decision loop reaches `fableloom-play-turn`. Automatic nodes
and disconnected helper scenes do not expose
the text box: their one path is production sequencing, not a viewer decision.

Which provider maps typed input is the loom's own `playSettings`
(`{ providerId, model, effort }`, set in Story settings). It beats the stage
pin — the author chose that narrator for that story — and a per-call override
in the request body beats both.

## AI lanes (all direct user actions; stage prompts in `data/prompts/stages/`)

| Stage | What it does |
|---|---|
| `fableloom-generate-series-plan` | Drafts the full series arc, ordered plot points, and side quests from the loom metadata, linked-universe canon, and episode outline. |
| `fableloom-outline-episode` | Drafts one episode as concise camera-cut log-lines, viewer paths, audience-channel states, and distinct endings without writing teleplay or media prompts. |
| `fableloom-weave-episode` | Generates or reweaves a full episode as single-camera-cut nodes. The story writer/creative director chooses node and ending counts, establishes the configured audience role/medium near the opening, tracks connection availability, marks automatic cuts vs decision loops, and assigns camera/video direction. A reweave sees and preserves the existing story graph while splitting multi-cut scenes. |
| `fableloom-branch-node` | Grows N new intent-labeled single-cut branches with playback and camera direction. |
| `fableloom-play-turn` | Resolves one reader message: `move` through a matched transition or `stay` with in-world narration. |
| `fableloom-review` | Story-editor critique (intent clarity, branch coherence, ending payoff) layered over the deterministic checks. |
| `fableloom-review-episode-outline` | Story-editor review of one episode's pre-teleplay arc, branch consequences, canon continuity, audience contract, endings, and handoff. |
| `fableloom-review-series-teleplay` | Story-editor review of every expanded episode as one complete interactive teleplay series, including continuity, escalation, endings, visual beats, and delivery handoffs. |
| `fableloom-reformat-scenes` | Rewrites existing scenes into the loom's other format (prose ⇄ teleplay), preserving every beat and decision point. |

Deterministic graph validation (no LLM) lives in
`server/lib/fableLoomGraph.js` — reachability from the opening scene, dead
ends, dangling transitions, unreachable endings, duplicate/empty intents,
audience-connection availability, and the exactly-one-next-path contract for automatic cuts —
and renders in the editor's Structure panel via
`GET /api/fableloom/:id/episodes/:episodeId/validate`.

Beat-outline validation is a separate deterministic gate. The per-episode
result is persisted on `episode.storyOutline.validation`; the series result is
available at `GET /api/fableloom/:id/outlines/validate`. Expansion rechecks
both results server-side, so a stale client cannot bypass the story-first
workflow. Scene-level and batch media controls mirror that readiness state in
the UI: storyboard generation stays disabled until the ordered beat arc and
any configured delivery handoffs are ready, preventing image spend on an
unreviewed or out-of-order teleplay.

Reweaving preserves story events and path meanings, but it replaces node ids;
existing rendered stills and clips are therefore dropped. The setup drawer
warns about that production cost before the author starts the reweave.

## Scene media

Each node carries an `imagePrompt`; **Generate** posts to the shared
`/api/image-gen/generate` queue with a `fableLoom: { loomId, episodeId,
nodeId }` destination tag. The completion hook
(`server/services/fableLoomSceneImageHook.js`) files the finished render onto
the node durably — even if the editor unmounted mid-render — with
newest-render-wins per node. The loom's `styleNotes` are appended to the
prompt for a consistent look. The browser sends no untyped continuity images:
`visualConditioning.js` resolves the current node, linked Universe, stable
character/wardrobe/location/object ids, approved identity assets, compatible
local character LoRAs, and graph predecessor on the server after the effective
backend/model is known. A locked convergence uses an explicitly selected
incoming node; without one it reports the ambiguity instead of guessing.
Openings never inherit a loop-back shot.

The scene editor's **Universe canon** section chooses locked or explicitly
degraded-draft behavior. Locked image renders fail before enqueue if an
identity package is incomplete, a required reference is unavailable or over
budget, or the backend does not declare multi-character preservation. Draft
renders remain usable but record every omitted input and warning. Each render
stores a versioned `visualConditioning` manifest with bindings, backend
capabilities, selected asset basenames, adapter SHA-256/scales, compiler
version, temporal source, and omissions; machine-local paths never enter the
loom or Universe record.

The compiler treats an off-screen protagonist as an intentional omission, not
as a missing reference: any stale protagonist binding is listed as omitted with
reason `protagonist-offscreen`, and the manifest still records the canonical
character, wardrobe, and presence for auditability.

**Generate video** prefers the node's dedicated single-clip `videoPrompt`, adds
the selected movement's production direction from the shared camera registry,
and falls back to scene text for legacy nodes. The registry includes dolly,
truck, pan/tilt, crane, orbit, tracking, handheld, drone, focus, roll, parallax,
body-mounted, bullet-time, hyperlapse, and locked-off setups. If the node has a
rendered image, a locked scene also requires the author to approve that exact
storyboard as the first-frame contract; replacing the still clears approval.
Text-to-video and stale/unapproved first frames can render only as explicit
draft/degraded work. The completion hook
(`server/services/fableLoomSceneVideoHook.js`) files the finished
`videoHistoryId` onto the node durably, with newest-render-wins per node.
Decision videos are authored as seamless loops; automatic-cut videos land on
a final beat that hands cleanly to the next node.

### Episodic production and continuity

The **Production & Continuity** panel plans a whole episode before it queues
provider work. It enumerates reachable scenes and typed assets (still,
entry/hold/exit clips, and live-dialogue readiness), orders them by their
dependencies, and exposes the selected image/video provider, model, and effort
controls. Starting a batch is an explicit author action; it can be canceled,
polled, and resumed after a failed or canceled asset. Dialogue is kept as a
hosted interaction route rather than silently generating an offline audio
batch.

Each queued render records its effective provider, model/revision, parameters,
canon bindings, references, adapters, omissions, warnings, and temporal source
alongside the scene asset. **Repeat exact inputs** checks those recorded
manifests and refuses missing assets, local model revisions, or changed
compiled conditioning instead of falling back to a newer local default.

**Run Continuity Review** is also explicit and deterministic. It reports
wrong or missing character/wardrobe/place/object bindings, ambiguous graph
convergence, voice/profile and pronunciation drift, unsafe hold-loop audio,
clipping, and hosted-interaction readiness. Findings include scene links and
remediation text; the review never mutates canon or promotes a replacement
asset.

The character/environment canon-reference design and rationale is specified in
[`docs/plans/2026-08-29-fableloom-visual-continuity.md`](../plans/2026-08-29-fableloom-visual-continuity.md).
The character voice, production provenance, playback-asset, QR join, and
two-device hosted-mode contracts are specified in
[`docs/plans/2026-08-29-fableloom-character-voice-hosted-production.md`](../plans/2026-08-29-fableloom-character-voice-hosted-production.md).
Implementation is tracked under
[epic #5377](https://github.com/atomantic/PortOS/issues/5377).

## Storage

`fableloom_stories` (db-primary; one row per loom, full record in `data`
JSONB, `universe_id`/`series_id` mirrored as soft refs). The opt-in
**FableLoom** sharing category uses per-record peer subscriptions rather than
the snapshot loop: creates auto-subscribe to eligible peers, edits push the
whole sanitized loom under LWW, and deletes travel as tombstones. Scene image
and video bytes ride hashed asset manifests; true three-way story conflicts
archive the losing local version for restore from Sharing > Conflicts. Service:
`server/services/fableLoom/` (records / weave / store / db); routes:
`server/routes/fableLoom.js` (`/api/fableloom`).

## Relationship to the series pipeline

A loom can *link* to a pipeline series (`seriesId`) but is its own record
type — branching narratives don't run the linear issue/stage pipeline
(manuscript formats and linear-stage autopilot don't apply to a graph).
There is deliberately **no `seriesType: 'branching'` enum** on
`pipeline_series`: a scene graph has no linear stage chain, and a type enum
would force a special case into every pipeline surface. The integration is a
soft ref surfaced at the presentation layer instead (#4785) — the same posture
as Games / Creative Director:

- `GET /api/fableloom?seriesId=<id>` scopes the index to one series' looms. A
  blank value means "no filter"; a dangling id simply matches nothing.
- The series detail page renders those looms and can spawn a new pre-linked
  one; the series index badges each row with its count.
- The link is soft in both directions — deleting a series is never blocked by a
  loom pointing at it, and the loom editor's series backlink renders **no chip**
  (rather than a dead link) once the series is gone.
