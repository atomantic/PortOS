# server/services/fableLoom

FableLoom — branching narratives. A loom holds episodes; each episode is a
directed graph of scene nodes with intent-triggered transitions. Readers play
an episode through a chat conversation: the play stage matches their free-text
intent to a transition and moves them through the graph until an ending.

| Module | Purpose |
|---|---|
| `records.js` | Sanitizer + CRUD for looms/episodes/nodes/transitions; `attachNodeImage` for the media-job hook. |
| `weave.js` | AI ops via `runStagedLLM`: `weaveEpisode` (full graph), `branchNode` (grow paths), `reviewEpisode` (critique + deterministic analysis), `playTurn` (reader intent → transition; a tapped path resolves off the graph with NO LLM call), `reformatLoom` (rewrite every scene into another format). |
| `formats.js` | Scene formats (`prose` / `teleplay`) and the prompt contracts each generative stage renders for them. |
| `store.js` | PostgreSQL/file backend facade (`fableloom_stories`; collectionStore escape hatch for tests). |
| `db.js` | PostgreSQL leaf I/O. |

Pure graph analysis (validation, BFS layering, prompt rendering) lives in
`server/lib/fableLoomGraph.js`. Machine-local — no federation.
