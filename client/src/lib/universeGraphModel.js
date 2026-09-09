/**
 * Vocabulary + derivations for the Universe Builder's Graph tab.
 *
 * The server hands back `{ nodes, edges, series, issues, totalIssues, appear }`
 * (see `server/services/universeGraph.js`); everything the view needs on top of
 * that — the palette, an adjacency index, and the "gaps & enrichment" findings
 * — is derived here so it stays pure and testable.
 *
 * Every gap is a DERIVATION over records the user already authored: no LLM call
 * is made to produce one, and the "suggestion" category only points at a pair
 * the data already links by co-appearance.
 */

import { EVOLUTION_STAGES, EVOLUTION_STAGE_LABELS } from './characterEvolution.js';

export { EVOLUTION_STAGES, EVOLUTION_STAGE_LABELS };

// Node kinds in draw + legend order. `ring` places the kind on a radial-layout
// ring; `radius` is its base canvas radius before degree scaling.
export const GRAPH_KINDS = Object.freeze({
  character: { label: 'Characters', singular: 'Character', color: '#3b82f6', ring: 0, radius: 8 },
  place: { label: 'Places', singular: 'Place', color: '#22c55e', ring: 1, radius: 6.5 },
  object: { label: 'Objects', singular: 'Object', color: '#f59e0b', ring: 1, radius: 5.5 },
  series: { label: 'Series', singular: 'Series', color: '#ec4899', ring: 2, radius: 9 },
  issue: { label: 'Issues', singular: 'Issue', color: '#fb7185', ring: 3, radius: 4 },
  image: { label: 'Images', singular: 'Image', color: '#14b8a6', ring: 3, radius: 3.5 },
  composite: { label: 'Composite sheets', singular: 'Composite sheet', color: '#06b6d4', ring: 3, radius: 4.5 },
  moodboard: { label: 'Mood board', singular: 'Mood board', color: '#eab308', ring: 3, radius: 4.5 },
});
export const GRAPH_KIND_ORDER = Object.freeze(Object.keys(GRAPH_KINDS));

// The three canon trunks — the only kinds a gap can be reported against.
const CANON_KINDS = Object.freeze(['character', 'place', 'object']);

// Edge types keyed by the `type` the server emits. The seven relationship
// values mirror `RELATIONSHIP_LINK_TYPES`; the rest are the derived groups.
export const GRAPH_EDGE_TYPES = Object.freeze({
  ally: { label: 'Ally', color: '#22c55e', group: 'relationship' },
  antagonist: { label: 'Antagonist', color: '#ef4444', group: 'relationship' },
  rival: { label: 'Rival', color: '#f97316', group: 'relationship' },
  mentor: { label: 'Mentor', color: '#3b82f6', group: 'relationship' },
  'love-interest': { label: 'Love interest', color: '#ec4899', group: 'relationship' },
  family: { label: 'Family', color: '#eab308', group: 'relationship' },
  custom: { label: 'Custom', color: '#9ca3af', group: 'relationship' },
  attachment: { label: 'Attachment', color: '#a855f7', group: 'attachment' },
  appearance: { label: 'Appears in', color: '#6b7280', group: 'appearance', dashed: true },
  membership: { label: 'Series membership', color: '#ec4899', group: 'membership' },
  imageref: { label: 'Image reference', color: '#14b8a6', group: 'imageref' },
});

export const GRAPH_EDGE_GROUPS = Object.freeze([
  { id: 'relationship', label: 'Typed relationships' },
  { id: 'attachment', label: 'Attachments' },
  { id: 'appearance', label: 'Appearances' },
  { id: 'membership', label: 'Series membership' },
  { id: 'imageref', label: 'Image references' },
]);

// An unknown type (older/newer peer, hand-edited record) still has to draw, so
// resolve through `custom` rather than dereferencing undefined.
export const edgeDef = (type) => GRAPH_EDGE_TYPES[type] || GRAPH_EDGE_TYPES.custom;
export const kindDef = (kind) => GRAPH_KINDS[kind] || GRAPH_KINDS.object;

// Up to two initials for the node avatar. Honorifics and articles carry no
// identity, so they're dropped before the first two words are taken.
const HONORIFICS = /^(the|old|aunt|uncle|brother|sister|father|mother|doctor|dr\.?|captain|magistrate|lord|lady|sir)\s+/i;
export const nodeInitials = (name) => String(name || '?')
  .replace(HONORIFICS, '')
  .split(/[\s-]+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((word) => word[0])
  .join('')
  .toUpperCase() || '?';

export const hexToRgba = (hex, alpha) => {
  const n = parseInt(String(hex).slice(1), 16);
  if (!Number.isFinite(n)) return `rgba(148,163,184,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};

/**
 * Index a graph payload for lookup: node-by-id, per-node adjacency, and a
 * story degree that ignores the bookkeeping edges (image references and series
 * membership) so "isolated" means narratively isolated, not unrendered.
 */
export function indexGraph(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = new Map(nodes.map((n) => [n.id, []]));
  const resolved = [];
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const withEnds = { ...edge, sourceNode: source, targetNode: target };
    resolved.push(withEnds);
    adjacency.get(edge.source).push(withEnds);
    adjacency.get(edge.target).push(withEnds);
  }
  const degree = new Map();
  const storyDegree = new Map();
  for (const node of nodes) {
    const links = adjacency.get(node.id);
    degree.set(node.id, links.filter((e) => e.type !== 'imageref').length);
    storyDegree.set(node.id, links.filter((e) => e.type !== 'imageref' && e.type !== 'membership').length);
  }
  return {
    nodes,
    edges: resolved,
    byId,
    adjacency,
    degree,
    storyDegree,
    appear: graph?.appear || {},
    issues: Array.isArray(graph?.issues) ? graph.issues : [],
    series: Array.isArray(graph?.series) ? graph.series : [],
    totalIssues: graph?.totalIssues || 0,
    name: graph?.name || '',
  };
}

export const GAP_CATEGORIES = Object.freeze([
  { id: 'all', label: 'All' },
  { id: 'isolated', label: 'Isolated' },
  { id: 'places', label: 'Empty places' },
  { id: 'oneway', label: 'One-directional' },
  { id: 'noimage', label: 'No render' },
  { id: 'suggest', label: 'Suggestions' },
]);

const GAP_COLORS = Object.freeze({
  isolated: '#ef4444',
  places: '#22c55e',
  oneway: '#f97316',
  noimage: '#14b8a6',
  suggest: '#a855f7',
});

// A pair has to share this many issues before "they co-appear but have no
// typed relationship" is worth surfacing — below it, a shared issue is as
// likely to be two matches in unrelated scenes.
const CO_APPEARANCE_SUGGEST_MIN = 4;
// Appearances a character needs before an unauthored evolution lens reads as a
// gap rather than a walk-on with nothing to evolve through.
const LENS_SUGGEST_MIN_APPEARANCES = 5;

/**
 * Derive the gaps & enrichment list from an indexed graph.
 *
 * @param {ReturnType<typeof indexGraph>} index
 * @returns {Array<{cat,color,nodeId,otherId?,title,detail,action}>}
 */
export function computeUniverseGaps(index) {
  const gaps = [];
  const { nodes, edges, storyDegree, appear } = index;

  for (const node of nodes) {
    if (!CANON_KINDS.includes(node.kind)) continue;
    if (storyDegree.get(node.id) === 0) {
      gaps.push({
        cat: 'isolated',
        color: GAP_COLORS.isolated,
        nodeId: node.id,
        title: `${node.name} is isolated`,
        detail: `${kindDef(node.kind).singular} with no relationships, attachments or appearances.`,
        action: 'Link it or cut it',
      });
    }
    if (!node.hasImage) {
      gaps.push({
        cat: 'noimage',
        color: GAP_COLORS.noimage,
        nodeId: node.id,
        title: `${node.name} has no render`,
        detail: 'Canon entry without a reference image.',
        action: 'Render a reference',
      });
    }
  }

  // A place "has no cast" when no character is matched in any issue it appears
  // in — the only character↔place signal the records actually carry.
  const issuesOf = (id) => new Set(appear[id] || []);
  const castIssues = new Set();
  for (const node of nodes) {
    if (node.kind !== 'character') continue;
    for (const index of appear[node.id] || []) castIssues.add(index);
  }
  for (const node of nodes) {
    if (node.kind !== 'place') continue;
    const own = issuesOf(node.id);
    if (own.size === 0) continue; // already reported as isolated
    if ([...own].some((i) => castIssues.has(i))) continue;
    gaps.push({
      cat: 'places',
      color: GAP_COLORS.places,
      nodeId: node.id,
      title: `${node.name} has no cast`,
      detail: 'No character appears in any issue this place appears in.',
      action: 'Put someone here',
    });
  }

  const directed = new Set(edges.filter((e) => e.directed).map((e) => `${e.source}>${e.target}`));
  for (const edge of edges) {
    if (!edge.directed) continue;
    if (directed.has(`${edge.target}>${edge.source}`)) continue;
    gaps.push({
      cat: 'oneway',
      color: GAP_COLORS.oneway,
      nodeId: edge.source,
      otherId: edge.target,
      title: `${edge.sourceNode.name} → ${edge.targetNode.name} is one-directional`,
      detail: `${edge.sourceNode.name} calls ${edge.targetNode.name} "${edgeDef(edge.type).label.toLowerCase()}" but ${edge.targetNode.name} has no link back.`,
      action: 'Author the reverse link',
    });
  }

  const characters = nodes.filter((n) => n.kind === 'character');
  for (let i = 0; i < characters.length; i++) {
    const a = characters[i];
    const mine = issuesOf(a.id);
    for (let j = i + 1; j < characters.length; j++) {
      const b = characters[j];
      if (directed.has(`${a.id}>${b.id}`) || directed.has(`${b.id}>${a.id}`)) continue;
      const shared = (appear[b.id] || []).filter((x) => mine.has(x)).length;
      if (shared < CO_APPEARANCE_SUGGEST_MIN) continue;
      gaps.push({
        cat: 'suggest',
        color: GAP_COLORS.suggest,
        nodeId: a.id,
        otherId: b.id,
        title: `Define ${a.name} ↔ ${b.name}`,
        detail: `They share ${shared} issues but have no typed relationship.`,
        action: 'Add a relationship link',
      });
    }
  }
  for (const node of characters) {
    const count = (appear[node.id] || []).length;
    if (node.evolution || count < LENS_SUGGEST_MIN_APPEARANCES) continue;
    gaps.push({
      cat: 'suggest',
      color: GAP_COLORS.suggest,
      nodeId: node.id,
      title: `${node.name} has no evolution lens`,
      detail: `Appears in ${count} issues with no five-stage arc authored.`,
      action: 'Author the lens',
    });
  }

  // Stable ordering so the list doesn't reshuffle between renders: severity
  // first (the order GAP_CATEGORIES declares), then by title.
  const rank = new Map(GAP_CATEGORIES.map((c, i) => [c.id, i]));
  return gaps.sort((a, b) => (rank.get(a.cat) - rank.get(b.cat)) || a.title.localeCompare(b.title));
}

/**
 * The five canonical stages of a character's lens, marked with whether the
 * author has written each one. The stored lens is sparse (only authored stages
 * are persisted), so an unauthored stage is an absence, not an empty record.
 */
export function evolutionStageRows(evolution) {
  const authored = new Map((evolution?.stages || []).map((s) => [s.stageId, s]));
  return EVOLUTION_STAGES.map((stageId) => ({
    stageId,
    label: EVOLUTION_STAGE_LABELS[stageId] || stageId,
    authored: authored.has(stageId),
    stage: authored.get(stageId) || null,
  }));
}

// `adjacency` neighbours of one node, as ids (the focus + highlight set).
export function neighbourIds(index, nodeId) {
  const links = index.adjacency.get(nodeId) || [];
  return new Set([nodeId, ...links.map((e) => (e.source === nodeId ? e.target : e.source))]);
}
