# server/services/fableLoom

FableLoom — interactive video narratives. A loom holds ordered episodes; each episode is a
directed graph of scene nodes with intent-triggered transitions. Readers play
an episode through a chat conversation: the play stage matches their free-text
intent to a transition and moves them through the graph until an ending.

| Module | Purpose |
|---|---|
| `records.js` | Sanitizer + CRUD + peer LWW/tombstone merge for looms/episodes/nodes; transitions are addressable one at a time (`addNodeTransition` / `updateNodeTransition` / `deleteNodeTransition`) as well as replaceable as a whole array via the node patch; `attachNodeImage`, `attachNodeVideo`, and `attachNodePlaybackAsset` for media-job hooks. |
| `visualConditioning.js` | Compiles stable scene canon bindings into capability-budgeted prompts, typed reference assets, local character adapters, and durable render provenance. |
| `weave.js` | AI ops via `runStagedLLM`: `generateSeriesPlan` (full arc / plot-point / side-quest scaffold), `weaveEpisode` (single-camera-cut graph with automatic cuts and looping decisions), `branchNode` (grow paths), `feedbackEpisode` (apply a conversational sparse patch to one episode), `reviewEpisode` (critique + deterministic analysis), `playTurn` (reader intent → transition; tapped/automatic paths resolve with NO LLM call), `reformatEpisodeScenes` (rewrite ONE episode's scenes into another format; the loom's format pin lands only once every episode is converted). |
| `formats.js` | Scene formats (`prose` / `teleplay`) and the prompt contracts each generative stage renders for them. |
| `hostedSession.js` | Scoped QR-hosted play session lifecycle, HTTPS readiness preflight, token hashing, live voice gate revalidation, and half-duplex turn taking (#5383). |
| `production.js` | Episodic production orchestration: batch planning, DAG generation, cancellable batch runs, and user-triggered episodic continuity review (#5384). |
| `store.js` | PostgreSQL/file backend facade (`fableloom_stories`; collectionStore escape hatch for tests). |
| `db.js` | PostgreSQL leaf I/O. |

Pure graph analysis (validation, BFS layering, prompt rendering) lives in
`server/lib/fableLoomGraph.js`. Federation uses the opt-in per-record
`fableLoom` category, conflict-journal recovery, and scene-media asset manifests.
