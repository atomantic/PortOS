/**
 * Brain Graph Data Service
 *
 * Computes a graph of brain entities with edges derived from:
 * - Semantic similarity (via CoS memory embeddings through the bridge)
 * - Shared tags (Jaccard similarity)
 * - Explicit CoS memory links (through the bridge)
 *
 * Bounded by design: the full graph at scale (~1500 nodes, >1M shared-tag
 * pairs) crashes the browser, so this service never returns the whole graph.
 * Callers either fetch the lightweight search index (`getBrainGraphSearchIndex`),
 * a bounded overview of the most-connected nodes (`getBrainGraphOverview`), or
 * one node's neighborhood (`getBrainGraphNeighborhood`). Shared-tag edges are
 * only ever computed *among a bounded node set* and capped per node, so the
 * O(n²) tag explosion can't happen.
 */

import * as brainStorage from './brainStorage.js';
import * as memoryBackend from './memoryBackend.js';
import { loadBridgeMap, bridgeKey } from './brainMemoryBridge.js';

const ENTITY_TYPES = ['people', 'projects', 'ideas', 'admin', 'memories'];

// Edges shown per node are capped so a densely-tagged hub can't reintroduce the
// combinatorial blow-up inside a bounded view.
const SHARED_TAG_CAP_PER_NODE = 8;
const SHARED_TAG_MIN_JACCARD = 0.3;
const OVERVIEW_DEFAULT_LIMIT = 100;
const NEIGHBORHOOD_DEFAULT_LIMIT = 80;
const MAX_LIMIT = 250;

function jaccardSimilarity(tagsA, tagsB) {
  if (!tagsA?.length || !tagsB?.length) return 0;
  const setA = new Set(tagsA);
  const setB = new Set(tagsB);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const clampLimit = (limit, fallback) => {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_LIMIT);
};

// Load all non-archived brain entities as graph nodes (no edges).
async function loadNodes() {
  const nodes = [];
  for (const type of ENTITY_TYPES) {
    const records = await brainStorage.getAll(type);
    for (const record of records) {
      if (record.archived) continue;
      nodes.push({
        id: record.id,
        brainType: type,
        label: record.name || record.title || '(untitled)',
        summary: record.context || record.oneLiner || record.notes || record.content || '',
        tags: record.tags || [],
        importance: 0.6,
        status: record.status
      });
    }
  }
  return nodes;
}

// Lightweight index for the client-side search box — every node, no edges.
export async function getBrainGraphSearchIndex() {
  const nodes = await loadNodes();
  return { nodes: nodes.map(n => ({ id: n.id, label: n.label, brainType: n.brainType })) };
}

// Build the shared graph context once: nodes + tag index + remapped
// similar/linked edges (from CoS memory, capped per node already) + adjacency.
// This deliberately omits shared-tag edges — those are computed per bounded set.
async function loadGraphContext() {
  const nodes = await loadNodes();
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const brainIdSet = new Set(nodeById.keys());

  // tag → array of node ids
  const tagIndex = new Map();
  for (const n of nodes) {
    for (const tag of n.tags || []) {
      if (!tagIndex.has(tag)) tagIndex.set(tag, []);
      tagIndex.get(tag).push(n.id);
    }
  }

  // Reverse bridge: memoryId → brainId
  const bridgeMap = await loadBridgeMap();
  const reverseBridge = {};
  for (const [bKey, memId] of Object.entries(bridgeMap)) {
    reverseBridge[memId] = bKey.split(':')[1];
  }

  // Remap CoS similar/linked edges to brain ids. ~3 similar/node + links — not
  // the explosion (that's shared_tag, computed per bounded set below).
  const remappedEdges = [];
  const seen = new Set();
  let hasEmbeddings = false;
  const cosGraph = await memoryBackend.getGraphData().catch(() => null);
  if (cosGraph) {
    for (const edge of cosGraph.edges) {
      const source = reverseBridge[edge.source];
      const target = reverseBridge[edge.target];
      if (!source || !target || source === target) continue;
      if (!brainIdSet.has(source) || !brainIdSet.has(target)) continue;
      const key = [source, target].sort().join('-');
      if (seen.has(key)) continue;
      seen.add(key);
      const type = edge.type === 'linked' ? 'linked' : 'similar';
      if (type === 'similar') hasEmbeddings = true;
      remappedEdges.push({ source, target, type, weight: edge.weight });
    }
  }

  // adjacency: id → array of { otherId, type, weight }
  const adjacency = new Map();
  const addAdj = (a, b, type, weight) => {
    if (!adjacency.has(a)) adjacency.set(a, []);
    adjacency.get(a).push({ otherId: b, type, weight });
  };
  for (const e of remappedEdges) {
    addAdj(e.source, e.target, e.type, e.weight);
    addAdj(e.target, e.source, e.type, e.weight);
  }

  return { nodes, nodeById, tagIndex, remappedEdges, adjacency, hasEmbeddings };
}

// Shared-tag edges among a bounded set of node ids, Jaccard-gated and capped per
// node (union of each endpoint's top-K) so a hub can't dominate the view.
function sharedTagEdgesAmong(ids, nodeById) {
  const idSet = new Set(ids);
  // Collect candidate weighted pairs.
  const perNode = new Map(); // id → array of { other, weight }
  for (let i = 0; i < ids.length; i++) {
    const a = nodeById.get(ids[i]);
    if (!a?.tags?.length) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const b = nodeById.get(ids[j]);
      if (!b?.tags?.length) continue;
      const w = jaccardSimilarity(a.tags, b.tags);
      if (w < SHARED_TAG_MIN_JACCARD) continue;
      if (!perNode.has(a.id)) perNode.set(a.id, []);
      if (!perNode.has(b.id)) perNode.set(b.id, []);
      perNode.get(a.id).push({ other: b.id, weight: w });
      perNode.get(b.id).push({ other: a.id, weight: w });
    }
  }
  // Keep an edge if it survives the top-K cap on *either* endpoint.
  const kept = new Set();
  for (const [, list] of perNode) {
    list.sort((x, y) => y.weight - x.weight);
  }
  const edges = [];
  for (const [id, list] of perNode) {
    for (const { other, weight } of list.slice(0, SHARED_TAG_CAP_PER_NODE)) {
      if (!idSet.has(other)) continue;
      const key = [id, other].sort().join('-');
      if (kept.has(key)) continue;
      kept.add(key);
      const [source, target] = [id, other].sort();
      edges.push({ source, target, type: 'shared_tag', weight });
    }
  }
  return edges;
}

// Edges induced among a bounded node set: explicit/semantic first, then capped
// shared-tag for pairs not already connected.
function inducedEdges(idSet, ctx) {
  const ids = [...idSet];
  const edges = [];
  const seen = new Set();
  for (const e of ctx.remappedEdges) {
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
    const key = [e.source, e.target].sort().join('-');
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(e);
  }
  for (const e of sharedTagEdgesAmong(ids, ctx.nodeById)) {
    const key = [e.source, e.target].sort().join('-');
    if (seen.has(key)) continue; // an explicit/semantic edge already connects them
    seen.add(key);
    edges.push(e);
  }
  return edges;
}

// Cheap connectivity proxy for ranking the overview: degree in the
// similar/linked graph (weighted higher) plus a bounded co-tag participation
// score derived from tag-bucket sizes — neither enumerates all pairs.
function connectivityScores(ctx) {
  const score = new Map();
  for (const n of ctx.nodes) score.set(n.id, 0);
  for (const [id, neighbors] of ctx.adjacency) {
    score.set(id, (score.get(id) || 0) + neighbors.length * 2);
  }
  for (const [, ids] of ctx.tagIndex) {
    const inc = Math.min(ids.length - 1, 5); // cap a giant bucket's contribution
    if (inc <= 0) continue;
    for (const id of ids) score.set(id, (score.get(id) || 0) + inc);
  }
  return score;
}

export async function getBrainGraphOverview({ limit } = {}) {
  const cap = clampLimit(limit, OVERVIEW_DEFAULT_LIMIT);
  const ctx = await loadGraphContext();
  if (!ctx.nodes.length) {
    return { nodes: [], edges: [], hasEmbeddings: false, mode: 'overview' };
  }
  const score = connectivityScores(ctx);
  const topIds = [...ctx.nodes]
    .sort((a, b) => (score.get(b.id) || 0) - (score.get(a.id) || 0))
    .slice(0, cap)
    .map(n => n.id);
  const idSet = new Set(topIds);
  const edges = inducedEdges(idSet, ctx);
  const nodes = topIds.map(id => ctx.nodeById.get(id));
  return { nodes, edges, hasEmbeddings: ctx.hasEmbeddings, mode: 'overview' };
}

export async function getBrainGraphNeighborhood({ focusId, limit } = {}) {
  const cap = clampLimit(limit, NEIGHBORHOOD_DEFAULT_LIMIT);
  const ctx = await loadGraphContext();
  const focus = ctx.nodeById.get(focusId);
  if (!focus) {
    return { nodes: [], edges: [], hasEmbeddings: ctx.hasEmbeddings, mode: 'neighborhood', focusId, notFound: true };
  }

  // Gather neighbor candidates with a priority weight: linked > similar > tag.
  const candidates = new Map(); // otherId → { type, weight, priority }
  const consider = (otherId, type, weight) => {
    if (otherId === focusId || !ctx.nodeById.has(otherId)) return;
    const priority = type === 'linked' ? 2 : type === 'similar' ? 1 : 0;
    const existing = candidates.get(otherId);
    if (!existing || priority > existing.priority || (priority === existing.priority && weight > existing.weight)) {
      candidates.set(otherId, { type, weight, priority });
    }
  };
  for (const { otherId, type, weight } of ctx.adjacency.get(focusId) || []) {
    consider(otherId, type, weight);
  }
  // Shared-tag neighbors of the focus (bounded by the focus's own tag buckets).
  const tagCandidateIds = new Set();
  for (const tag of focus.tags || []) {
    for (const id of ctx.tagIndex.get(tag) || []) tagCandidateIds.add(id);
  }
  for (const id of tagCandidateIds) {
    if (id === focusId) continue;
    const w = jaccardSimilarity(focus.tags, ctx.nodeById.get(id)?.tags);
    if (w >= SHARED_TAG_MIN_JACCARD) consider(id, 'shared_tag', w);
  }

  // Rank candidates and take the top `cap` neighbors.
  const neighborIds = [...candidates.entries()]
    .sort((a, b) => (b[1].priority - a[1].priority) || (b[1].weight - a[1].weight))
    .slice(0, cap)
    .map(([id]) => id);

  const idSet = new Set([focusId, ...neighborIds]);

  // Always include the focus↔neighbor edge for every selected neighbor (so none
  // are orphaned by the shared-tag cap), then add neighbor↔neighbor context.
  const edges = [];
  const seen = new Set();
  for (const id of neighborIds) {
    const c = candidates.get(id);
    const [source, target] = [focusId, id].sort();
    const key = `${source}-${target}`;
    seen.add(key);
    edges.push({ source, target, type: c.type, weight: c.weight });
  }
  for (const e of inducedEdges(idSet, ctx)) {
    const key = [e.source, e.target].sort().join('-');
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(e);
  }

  const nodes = [...idSet].map(id => ctx.nodeById.get(id));
  return { nodes, edges, hasEmbeddings: ctx.hasEmbeddings, mode: 'neighborhood', focusId };
}
