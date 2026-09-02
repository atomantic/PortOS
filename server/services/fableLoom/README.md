# server/services/fableLoom

FableLoom — interactive video narratives. A loom holds ordered episodes; each episode is a
directed graph of scene nodes with intent-triggered transitions. Readers play
an episode through a chat conversation: the play stage matches their free-text
intent to a transition and moves them through the graph until an ending.

| Module | Purpose |
|---|---|
| `records.js` | Sanitizer + CRUD + peer LWW/tombstone merge for looms/episodes/nodes; transitions are addressable one at a time (`addNodeTransition` / `updateNodeTransition` / `deleteNodeTransition`) as well as replaceable as a whole array via the node patch; `attachNodeImage`, `attachNodeVideo`, and `attachNodePlaybackAsset` for media-job hooks. |
| `visualConditioning.js` | Compiles stable scene canon bindings into capability-budgeted prompts, typed reference assets, local character adapters, and durable render provenance. |
| `weave.js` | AI ops via `runStagedLLM`: `generateSeriesPlan` (full arc / plot-point / side-quest scaffold), `generateEpisodeOutline` + `validateEpisodeOutline` + `reviewEpisodeOutline` (log-line beat planning before teleplay expansion), `weaveEpisode` (single-camera-cut graph with automatic cuts and looping decisions), `branchNode` (grow paths), `feedbackEpisode` (apply a conversational sparse patch to one episode), `reviewEpisode` + `reviewSeriesTeleplay` (episode or complete-series critique with deterministic analysis), `playTurn` (reader intent → transition; tapped/automatic paths resolve with NO LLM call), `reformatEpisodeScenes` (rewrite ONE episode's scenes into another format; the loom's format pin lands only once every episode is converted). |
| `editorial.js` | Whole-series AI evaluate-and-remediate pass plus deterministic/AI playthrough review. Preserves episode/scene/path membership and IDs, validates generated outlines, rejects graph regressions, and applies story-aware convergence sources. |
| `editorialAutopilot.js` | User-triggered bounded editor/reviewer loop: remediate, exercise every bounded branch variation, judge story quality, then complete, pause on residuals/plateau, fail, or cancel cooperatively. |
| `editorialSelfImprove.js` | Opt-in, budget-gated post-mortem for paused/failed editorial-autopilot runs. Sends only content-free counters to a diagnostic stage and queues a deduplicated, approval-gated PortOS CoS task for confident workflow defects. |
| `formats.js` | Scene formats (`prose` / `teleplay`) and the prompt contracts each generative stage renders for them. |
| `hostedSession.js` | Scoped QR-hosted play session lifecycle, HTTPS readiness preflight, token hashing, live voice gate revalidation, half-duplex turn taking (#5383), and the expired-session sweeper armed from bootstrap (#5660). |
| `production.js` | Episodic production orchestration: batch planning, DAG generation, cancellable batch runs, and user-triggered episodic continuity review (#5384). |
| `falVideoAutomation.js` | User-triggered, serialized Playwright automation over the persistent PortOS CDP browser: uploads a scene still + full shot prompt to fal.ai H3 Max, downloads the finished MP4 into shared video history, and attaches it to the originating scene. |
| `store.js` | PostgreSQL/file backend facade (`fableloom_stories`; collectionStore escape hatch for tests). |
| `db.js` | PostgreSQL leaf I/O. |

Pure graph analysis (validation, BFS layering, prompt rendering) lives in
`server/lib/fableLoomGraph.js`. Federation uses the opt-in per-record
`fableLoom` category, conflict-journal recovery, and scene-media asset manifests.
