# Brain Graph: confirm refresh-embeddings + bounded focus/navigation rendering

## Context

The Brain → Graph tab (`client/src/components/brain/tabs/BrainGraph.jsx`) crashes the
browser tab within ~1 minute at the user's scale: **1505 nodes · 1,090,055 edges**.

Two root causes, plus a UX gap:

1. **Edge explosion (server bug).** `server/services/brainGraph.js:89-117` computes
   `shared_tag` edges all-pairs within each tag bucket at a permissive Jaccard ≥ 0.3
   with **no per-node cap**. Semantic edges are already capped (top-3/node ≥ 0.8 in
   `memoryDB.js:792-805`) and linked edges are tiny — so essentially all ~1.08M edges
   are `shared_tag` noise.
2. **Synchronous O(N²) force layout + full-graph render.** `buildGraph()`
   (`client/src/lib/graphSimulation.js`) runs the force sim synchronously on the main
   thread over every node and edge, and `BrainGraph.jsx` renders one `<mesh>` per node +
   a 1M-segment `<lineSegments>`. The endpoint (`GET /api/brain/graph`) has no
   filtering/pagination and dumps the entire graph.
3. **No confirmation** on the expensive **Refresh embeddings** button, which re-embeds
   every record (tens of minutes at this scale).

**Goal:** never load or render the whole graph. Land on a bounded **overview** of the
most-connected memories, **search** to jump to any memory, and **click a node to
re-focus** on its neighborhood (replacing the view, with a back trail). Bound the loaded
set so the existing force sim/three.js renderer stays fast. Add an inline confirmation to
the refresh button.

UX decisions (confirmed with user): default view = **overview of top ~100 memories**;
node click = **re-focus (replace view)** with a back/history trail.

## Part 1 — Refresh-embeddings confirmation (small)

In `BrainGraph.jsx`, gate `handleSync({ refresh: true })` behind an inline confirm.

- Reuse **`client/src/components/ui/InlineConfirmRow.jsx`** (matches the user's stated
  preference for inline confirm rows over the two-click-arm pattern — see memory
  `feedback_confirmation_ux`). Do **not** add a `window.confirm`.
- New state `confirmingRefresh`. The "Refresh embeddings" button sets it true; render an
  `InlineConfirmRow` in the controls area: question ≈ *"Re-embed all N brain records?
  This can take several minutes."* (N from `graphData`/search-index count), tone
  `warning`, confirm "Refresh", cancel "Cancel". `onConfirm` → existing
  `handleSync({ refresh: true })`; `onCancel` clears the flag.
- Keep the persistent `toast.loading` already added. The plain **Sync Now** (new-records)
  path stays un-gated — it's cheap and only appears when there are no embeddings.

## Part 2 — Bounded focus/neighborhood graph (core)

### Server

**`server/services/brainGraph.js`** — refactor `getBrainGraphData()` into bounded modes.
Extract the node-loading + tag-index build into a shared internal helper (cheap: iterates
records, no edge enumeration). Then:

- `getBrainGraphSearchIndex()` → `{ nodes: [{ id, label, brainType }] }` for all
  non-archived records, **no edges**. Powers the search box. Lightweight (~1505 small
  objects).
- `getBrainGraphOverview({ limit = 100 })` → rank all nodes by a **cheap connectivity
  proxy** (linked-degree from `memory_links` + semantic top-K degree + co-tag degree
  derived from the tag-index bucket sizes — none of which enumerate all pairs), take the
  top `limit`, then compute the **induced subgraph** (all three edge types restricted to
  that node set — O(limit²) ≈ 10K max). Return `{ nodes, edges, hasEmbeddings, mode:'overview' }`.
- `getBrainGraphNeighborhood({ focusId, limit = 80 })` → collect the focus node's direct
  neighbors: linked (memory_links for the focus's bridged memory id), semantic
  (single-node pgvector KNN — reuse the `<=>` LATERAL pattern from `memoryDB.js:792`
  scoped to one `a.id`; add a `getNeighbors(memoryId, k)` to `memoryDB.js` /
  `memoryBackend.js` near the existing `getRelated`), and shared_tag (tag-index entries
  sharing ≥ 0.3 with focus, top-K by weight). Cap to `limit`, then return focus + neighbors
  with the **induced edges among that set** so neighbor↔neighbor links show.
  `{ nodes, edges, hasEmbeddings, focusId, mode:'neighborhood' }`.
- **Per-node `shared_tag` cap (fixes the explosion at the source):** wherever shared_tag
  edges are produced, keep only each node's top-K (≈ 8) strongest by weight. Apply in the
  induced-subgraph builder so even a worst-case bucket can't reproduce the blow-up.

**`server/routes/brain.js`** (currently `GET /graph` at ~925) — replace the single dump:
- `GET /api/brain/graph` → `?focus=<id>` present ⇒ neighborhood; absent ⇒ overview.
  Optional `?limit=`. Validate query params with a Zod schema in
  `server/lib/validation.js` (coerced ints, bounded; `focus` optional string).
- `GET /api/brain/graph/search-index` → search index.
- Confirm `BrainGraph.jsx` is the only consumer of the old payload before changing shape
  (the explore found `getBrainGraph` used only there); update accordingly.

No on-disk format change → **no migration**. This is a read-only endpoint, so no
`schemaVersions` gate is needed; other installs simply get the improved endpoint
(distribution-model safe).

### Client

**`client/src/services/apiBrain.js`** (and re-export rules per the catalog):
- `getBrainGraph({ focus, limit } = {})` → builds `URLSearchParams` (follow the
  `getBrainProjects`/`getBrainLinks` param pattern in the same file).
- `getBrainGraphSearchIndex()` → `/brain/graph/search-index`.

**`client/src/components/brain/tabs/BrainGraph.jsx`** — introduce focus state:
- State: `focusId` (null = overview), `focusTrail` (array of `{ id, label }` for back
  nav), `searchIndex`. On mount: fetch search index + overview in parallel.
- **Search box:** reuse **`client/src/components/EntityCombobox.jsx`** over `searchIndex`
  (map to `{ id, name: label, subtitle: brainType }`); `onPick` → `focusNode(id)`.
- **Re-focus action** (keeps the cheap in-view selection separate from the expensive
  refetch): single click still **selects** a node (detail panel + neighbor highlight
  within the loaded set — current behavior, including the Esc / "Clear selection" exit
  just added). Add an explicit **"Explore connections"** button in the detail panel and a
  **double-click** handler that call `focusNode(node.id)`: push the current focus onto
  `focusTrail`, fetch that node's neighborhood, replace the view, and select the new
  focus. Connection rows in the detail panel that point outside the loaded set also
  trigger `focusNode`.
- **Trail / reset UI:** a compact breadcrumb ("Overview › A › B") with a Back control and
  a "Back to overview" reset (clears `focusId`, reloads overview). Place near the controls
  bar or as a canvas overlay next to the existing "Clear selection" button.
- Type filters + label search keep filtering **within the loaded subgraph** (current
  client-side `filteredData` logic is retained, now operating on ≤ ~150 nodes).
- Because every mode is bounded (≤ ~150 nodes, few hundred edges), the existing
  synchronous `buildGraph` force sim and per-node-mesh rendering are fine — **no web
  worker or instancedMesh rewrite needed** (note both as deferred options if counts ever
  grow).

### Optional follow-up (defer, capture in PLAN.md if skipped)
- Web-worker / async force sim and `<instancedMesh>` node rendering — only if a single
  neighborhood ever needs to exceed a few hundred nodes.
- Short-lived server cache for the overview ranking if recompute-per-request shows latency.
- Multi-hop (`depth=2`) neighborhood expansion.

## Critical files

- `server/services/brainGraph.js` — modes + per-node shared_tag cap (core change)
- `server/services/memoryDB.js` / `server/services/memoryBackend.js` — add single-node
  `getNeighbors(memoryId, k)` (reuse the existing `<=>` KNN query)
- `server/routes/brain.js` — `GET /graph` (focus/overview) + `/graph/search-index`
- `server/lib/validation.js` — Zod query schema for the graph route
- `client/src/services/apiBrain.js` — `getBrainGraph(params)` + `getBrainGraphSearchIndex`
- `client/src/components/brain/tabs/BrainGraph.jsx` — focus state, trail, search, confirm
- Reused as-is: `client/src/components/ui/InlineConfirmRow.jsx`,
  `client/src/components/EntityCombobox.jsx`

## Verification

- **Server tests:** add/extend `server/services/brainGraph.test.js` — mock `brainStorage`
  + `memoryBackend`; assert overview returns ≤ limit nodes with an induced edge set,
  neighborhood returns focus + capped neighbors, and the per-node shared_tag cap holds
  (feed a pathological all-same-tag fixture → bounded edge count, not C(N,2)). Run
  `cd server && npm test`.
- **Client:** extract the focus-trail transition into a small pure helper and unit-test it
  (`cd client && npm test`); BrainGraph itself has no harness (R3F canvas).
- **Manual (`npm run dev`, Brain → Graph):** overview loads fast with ~100 nodes (no
  freeze); search jumps to a memory; double-click / "Explore connections" re-centers and
  the trail + Back work; Esc / "Clear selection" still un-isolates; "Refresh embeddings"
  shows the inline confirm, then the persistent loading toast on confirm. Confirm the tab
  no longer crashes at full scale.
- Run `/simplify` on the diff before committing (per project workflow).
