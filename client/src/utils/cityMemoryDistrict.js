// Pure, deterministic helpers for CyberCity's memory / knowledge district (roadmap 3.2):
// a quiet quarter in the northwest where the user's long-term memory graph crystallizes
// into the city. Each memory *category* becomes a cluster of glowing crystals — taller and
// brighter the more (and more important) the memories it holds — and edges that cross
// category boundaries arc between clusters as light bridges, so the shape of how knowledge
// connects is legible at a glance. No three.js / React imports so the topology is
// unit-testable (mirrors cityFederation.js / cityBackupVault.js).

import { hashString } from './hashString';
import { groupByFieldValue, scaleMetricToHeight } from './cityDistrictLayout';

export const MEMORY_DISTRICT = {
  // Northwest quadrant — mirrors the artifact cluster at NE (+44,-28), clear of the
  // productivity district (SW, -48,+28), the backup vault (W, -34,-10), and downtown.
  base: [-44, 0, -30],
  radius: 9, // clusters arrange on a ring of this radius around the district center
  maxCrystalsPerCluster: 7, // visual cap; overflow is summarized in the cluster label
  crystalSpacing: 1.4, // horizontal spread of crystals within a cluster
  minCrystalHeight: 1.2,
  maxCrystalHeight: 4.5,
  bridgeY: 2.2, // height the light bridges arc at
  maxClusters: 8, // most-populous categories rendered; the rest fold into "OTHER"
};

// Per-category crystal color. Reuses the PortOS neon palette feel; unknown/uncategorized
// memories fall back to slate so an unclassified cluster still reads as present-but-quiet.
const CATEGORY_COLORS = {
  personal: '#ec4899', // pink
  work: '#3b82f6', // port-accent blue
  technical: '#06b6d4', // cyan
  health: '#22c55e', // port-success green
  finance: '#f59e0b', // port-warning amber
  relationships: '#f43f5e', // rose
  preferences: '#a855f7', // violet
  ideas: '#8b5cf6', // purple
  other: '#64748b', // slate — fallback
};

// Deterministic color for any category string: known categories map to their token, unknown
// ones hash into the neon palette so two distinct unknown categories still look distinct.
const PALETTE = ['#ec4899', '#3b82f6', '#06b6d4', '#22c55e', '#f59e0b', '#f43f5e', '#a855f7', '#8b5cf6'];
export function categoryColor(category) {
  const key = String(category || 'other').toLowerCase();
  if (CATEGORY_COLORS[key]) return CATEGORY_COLORS[key];
  return PALETTE[hashString(key) % PALETTE.length];
}

// Normalize a raw graph node's category to a stable, lowercase bucket key. Missing/blank →
// 'other' so uncategorized memories collect into one cluster instead of vanishing.
export function categoryKey(node) {
  const raw = node?.category;
  if (typeof raw !== 'string' || raw.trim() === '') return 'other';
  return raw.trim().toLowerCase();
}

// Group graph nodes into per-category buckets, each carrying a node count and a summed
// importance (importance defaults to 1 when absent so every memory contributes some mass).
// Returns buckets sorted by count desc, then category asc for a stable order.
export function groupByCategory(nodes) {
  const nodeImportance = (node) => (Number.isFinite(node?.importance) ? node.importance : 1);
  return groupByFieldValue(nodes, categoryKey, { weightFn: nodeImportance }).map(
    ({ key, count, weight }) => ({ category: key, count, importance: weight }),
  );
}

// Place a cluster on the district ring. Angle is seeded by the category name (not the index)
// so a category keeps its spot as the graph grows, and index is a stable tiebreaker fan-out
// so two categories hashing near the same angle still separate.
export function placeCluster(category, index, total, opts = {}) {
  const base = opts.base || MEMORY_DISTRICT.base;
  const radius = opts.radius ?? MEMORY_DISTRICT.radius;
  const hashAngle = (hashString(category) % 360) * (Math.PI / 180);
  const fan = total > 0 ? (index / total) * Math.PI * 2 : 0;
  // Blend the hash angle with an even fan so clusters neither overlap nor drift on regrouping.
  const angle = hashAngle * 0.5 + fan * 0.5;
  return [
    base[0] + Math.cos(angle) * radius,
    base[1],
    base[2] + Math.sin(angle) * radius,
  ];
}

// Crystal height scales with the cluster's total importance, clamped to the configured band so
// a huge category doesn't dwarf the skyline and a tiny one is still visible.
export function clusterHeight(importance) {
  const { minCrystalHeight, maxCrystalHeight } = MEMORY_DISTRICT;
  return scaleMetricToHeight(importance, {
    min: minCrystalHeight,
    max: maxCrystalHeight,
    k: 0.7,
    base: minCrystalHeight,
  });
}

// Build the bridges between category clusters from the graph's cross-category edges. Each edge
// whose endpoints live in different categories increments that category-pair's weight; the
// result is a deduped, sorted list of { from, to, weight, count } the renderer arcs as light.
// `linked` edges count double vs `similar` so explicit links read as stronger connective tissue.
export function computeBridges(nodes, edges) {
  const catOf = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    catOf.set(node?.id, categoryKey(node));
  }
  const pairs = new Map();
  for (const edge of Array.isArray(edges) ? edges : []) {
    const a = catOf.get(edge?.source);
    const b = catOf.get(edge?.target);
    if (!a || !b || a === b) continue; // intra-cluster edges don't bridge
    const [from, to] = a < b ? [a, b] : [b, a];
    const key = `${from}|${to}`;
    const w = edge?.type === 'linked' ? 2 : 1;
    const entry = pairs.get(key) || { from, to, weight: 0, count: 0 };
    entry.weight += w;
    entry.count += 1;
    pairs.set(key, entry);
  }
  return [...pairs.values()].sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from));
}

// Full derived view-model for the component: positioned clusters (capped at maxClusters with the
// overflow folded into a single 'other'-style summary) plus the light bridges between them. Pure
// and deterministic — same graph in, same scene out — so the whole thing is testable headless.
export function computeMemoryDistrict(graph, opts = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const maxClusters = opts.maxClusters ?? MEMORY_DISTRICT.maxClusters;

  const grouped = groupByCategory(nodes);

  // Fold the long tail of small categories into one "+N more" overflow cluster so the district
  // stays readable; its mass is the sum of what it absorbs.
  let clustersData = grouped;
  let overflow = null;
  if (grouped.length > maxClusters) {
    clustersData = grouped.slice(0, maxClusters - 1);
    const rest = grouped.slice(maxClusters - 1);
    overflow = {
      category: 'other',
      count: rest.reduce((s, c) => s + c.count, 0),
      importance: rest.reduce((s, c) => s + c.importance, 0),
      overflowOf: rest.length,
    };
    clustersData = [...clustersData, overflow];
  }

  const total = clustersData.length;
  const clusters = clustersData.map((c, i) => ({
    category: c.category,
    label: c.overflowOf ? `+${c.overflowOf} MORE` : c.category.toUpperCase(),
    count: c.count,
    importance: c.importance,
    color: categoryColor(c.category),
    position: placeCluster(c.category, i, total, opts),
    height: clusterHeight(c.importance),
    crystals: Math.min(MEMORY_DISTRICT.maxCrystalsPerCluster, Math.max(1, c.count)),
    isOverflow: !!c.overflowOf,
  }));

  // Bridges reference category keys; resolve them to cluster positions, dropping any whose
  // endpoint folded into overflow (those edges are summarized away rather than mis-drawn).
  const posByCategory = new Map(clusters.map(c => [c.category, c.position]));
  const bridges = computeBridges(nodes, edges)
    .map(b => ({ ...b, fromPos: posByCategory.get(b.from), toPos: posByCategory.get(b.to) }))
    .filter(b => b.fromPos && b.toPos);

  return {
    base: opts.base || MEMORY_DISTRICT.base,
    clusters,
    bridges,
    totalMemories: nodes.length,
    empty: nodes.length === 0,
  };
}
