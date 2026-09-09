/**
 * Universe relationship graph — the read model behind the Universe Builder's
 * Graph tab.
 *
 * Pure aggregation over records that already exist: the universe's canon
 * arrays (characters / places / objects), the structured links authored on
 * them (`relationshipLinks`, object `attachments`), the prose cross-reference
 * `canonUsage` already computes, and the rendered references each entry
 * carries. No writes, no LLM calls — every node and edge is something the user
 * authored or the matcher already derived.
 *
 * Node ids are namespaced by kind (`character:<entryId>`) so a place and a
 * character that share a canon id can never collide in the same graph.
 */

import { getUniverse, ERR_NOT_FOUND } from './universeBuilder.js';
import { getUniverseCanonUsage } from './canonUsage.js';
import { listSeries } from './pipeline/series.js';
import { listAllIssues } from './pipeline/issues.js';
import {
  matchCharactersInText, matchPlacesInText, matchObjectsInText,
} from '../lib/scenePrompt.js';
import { ServerError } from '../lib/errorHandler.js';

// Rendered references per canon entry that become their own `image` node. An
// entry can hold up to BIBLE_LIMITS.IMAGE_REFS_PER_ENTRY_MAX of them; past a
// handful they say nothing new about the graph's shape and drown the layout.
export const IMAGE_NODES_PER_ENTRY_MAX = 3;

// Canon trunks, in the order their nodes are emitted. `kind` is the canon-array
// key on the universe; `node` is the graph node kind.
const TRUNKS = Object.freeze([
  { key: 'characters', node: 'character', match: matchCharactersInText },
  { key: 'places', node: 'place', match: matchPlacesInText },
  { key: 'objects', node: 'object', match: matchObjectsInText },
]);

const nodeId = (kind, id) => `${kind}:${id}`;
const list = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === 'string' ? value.trim() : '');

// A canon entry's one-line subtitle. Each trunk carries its descriptive text
// under a different key, and an entry with none still needs a label the
// inspector and the poster can print.
const roleFor = (kind, entry, name) => {
  if (kind === 'character') return text(entry.role) || text(entry.coreTheme) || 'Character';
  if (kind === 'place') {
    // A place with no name displays under its slugline, so repeating it as the
    // subtitle would print the same string twice.
    const slugline = text(entry.slugline);
    return (slugline === name ? '' : slugline) || text(entry.era) || 'Place';
  }
  return text(entry.significance) || 'Object';
};

// The Three Sliders round-trip as an always-present object whose unrated axes
// are null. Only hand the client an object when at least one axis is rated —
// `null` is the "never rated" signal the inspector renders as absent.
const slidersFor = (entry) => {
  const raw = entry.sliders;
  if (!raw || typeof raw !== 'object') return null;
  const rated = ['proactivity', 'likability', 'competence']
    .filter((axis) => Number.isInteger(raw[axis]));
  if (!rated.length) return null;
  return Object.fromEntries(rated.map((axis) => [axis, raw[axis]]));
};

// Ghost → Wound → Lie → Need → Want. Null when the author has written none of
// it, so the inspector shows the empty state instead of five blank rows.
const frameworkFor = (entry) => {
  const out = {};
  for (const field of ['ghost', 'wound', 'lie', 'need', 'want']) {
    const value = text(entry[field]);
    if (value) out[field] = value;
  }
  return Object.keys(out).length ? out : null;
};

/**
 * Build the graph payload for one universe.
 *
 * @param {string} universeId
 * @returns {Promise<object>} `{ universeId, name, nodes, edges, series, issues,
 *   totalIssues, appear }` — `appear` maps a node id to the ascending issue
 *   indices it appears in, which is what the timeline scrubber and the
 *   co-appearance suggestions read.
 */
export async function buildUniverseGraph(universeId) {
  const universe = await getUniverse(universeId).catch((err) => {
    if (err?.code === ERR_NOT_FOUND) {
      throw new ServerError('Universe not found', { status: 404, code: 'UNIVERSE_NOT_FOUND' });
    }
    throw err;
  });

  // The cross-reference owns the prose scan (the expensive part, run once).
  // It re-reads the series + issue rows this function also needs, which is the
  // deliberate trade: the alternative is duplicating its matcher orchestration
  // here, where it would drift. Both reads are indexed and history-free.
  const usage = await getUniverseCanonUsage(universeId);
  const allSeries = await listSeries();
  const linked = allSeries.filter((s) => s.universeId === universeId);
  const linkedIds = linked.map((s) => s.id);
  const rawIssues = linkedIds.length
    ? await listAllIssues({ seriesIds: linkedIds, withHistory: false })
    : [];

  // Timeline order is a single global issue index: series ordered by their
  // earliest issue, issues by number within a series. Every `since` / anchor /
  // firstIssue in the payload is an index into this one list.
  const issuesBySeries = new Map(linkedIds.map((id) => [id, []]));
  for (const issue of rawIssues) {
    if (issuesBySeries.has(issue.seriesId)) issuesBySeries.get(issue.seriesId).push(issue);
  }
  for (const bucket of issuesBySeries.values()) {
    bucket.sort((a, b) => (a.number || 0) - (b.number || 0));
  }
  const orderedSeries = linked
    .slice()
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.name.localeCompare(b.name));

  // Built in GRAPH-id space (`issue:<recordId>` / `series:<recordId>`) with the
  // record id kept alongside, so no field ever holds a raw id under a name
  // whose sibling holds a namespaced one. `issueIndexById` stays keyed by
  // RECORD id — that is what the canon-usage rows carry.
  const issues = [];
  const issueIndexById = new Map();
  for (const series of orderedSeries) {
    for (const issue of issuesBySeries.get(series.id) || []) {
      const index = issues.length;
      issueIndexById.set(issue.id, index);
      issues.push({
        id: nodeId('issue', issue.id),
        recordId: issue.id,
        index,
        name: `${series.name} #${issue.number ?? index + 1}`,
        title: text(issue.title),
        seriesId: nodeId('series', series.id),
      });
    }
  }
  const totalIssues = issues.length;

  const nodes = [];
  const edges = [];
  const appear = {};
  const push = (node) => { nodes.push(node); return node; };
  const link = (edge) => { edges.push(edge); return edge; };

  // ---- series + issue nodes ----
  const seriesFirstIssue = new Map();
  for (const issue of issues) {
    if (!seriesFirstIssue.has(issue.seriesId)) seriesFirstIssue.set(issue.seriesId, issue.index);
  }
  for (const series of orderedSeries) {
    const count = (issuesBySeries.get(series.id) || []).length;
    push({
      id: nodeId('series', series.id),
      kind: 'series',
      name: series.name,
      role: `${count} issue${count === 1 ? '' : 's'}`,
      recordId: series.id,
      hasImage: false,
      firstIssue: seriesFirstIssue.get(nodeId('series', series.id)) ?? 0,
    });
  }
  for (const issue of issues) {
    push({
      id: issue.id,
      kind: 'issue',
      name: issue.name,
      role: issue.title || `Issue ${issue.index + 1}`,
      recordId: issue.recordId,
      seriesId: issue.seriesId,
      index: issue.index,
      hasImage: false,
      firstIssue: issue.index,
    });
    link({ source: issue.id, target: issue.seriesId, type: 'membership', since: issue.index });
  }

  // ---- canon entries, their appearances, and their rendered references ----
  const entryNodeByTrunk = { characters: new Map(), places: new Map(), objects: new Map() };
  let imageSeq = 0;
  for (const trunk of TRUNKS) {
    for (const entry of list(universe[trunk.key])) {
      if (!entry || typeof entry !== 'object' || !entry.id) continue;
      const imageRefs = list(entry.imageRefs);
      const primary = text(entry.primaryImageRef) || imageRefs[0] || null;
      const id = nodeId(trunk.node, entry.id);
      const usageRows = list(usage[trunk.key]?.[entry.id]);
      const indices = [...new Set(
        usageRows.flatMap((row) => list(row.issueIds).map((issueId) => issueIndexById.get(issueId))),
      )].filter((i) => Number.isInteger(i)).sort((a, b) => a - b);
      if (indices.length) appear[id] = indices;

      const name = text(entry.name) || text(entry.slugline) || 'Untitled';
      const node = push({
        id,
        kind: trunk.node,
        name,
        role: roleFor(trunk.node, entry, name),
        recordId: entry.id,
        hasImage: imageRefs.length > 0,
        primaryImageRef: primary,
        locked: entry.locked !== false,
        firstIssue: indices.length ? indices[0] : 0,
        ...(trunk.node === 'character'
          ? {
            arcType: text(entry.arcType) || null,
            sliders: slidersFor(entry),
            framework: frameworkFor(entry),
            evolution: entry.evolution || null,
          }
          : {}),
      });
      entryNodeByTrunk[trunk.key].set(entry.id, { node, entry });

      for (const index of indices) {
        link({ source: id, target: issues[index].id, type: 'appearance', since: index });
      }
      for (const row of usageRows) {
        if (!issuesBySeries.has(row.seriesId)) continue;
        link({
          source: id,
          target: nodeId('series', row.seriesId),
          type: 'membership',
          since: indices.length ? indices[0] : 0,
        });
      }
      imageRefs.slice(0, IMAGE_NODES_PER_ENTRY_MAX).forEach((ref) => {
        const imgId = nodeId('image', `${imageSeq++}`);
        push({
          id: imgId,
          kind: 'image',
          name: ref,
          role: ref === primary ? 'Primary reference' : 'Rendered reference',
          hasImage: true,
          imageRef: ref,
          primary: ref === primary,
          firstIssue: node.firstIssue,
        });
        link({ source: imgId, target: id, type: 'imageref', since: node.firstIssue });
      });
    }
  }

  // ---- authored relationship links (character → character, directed) ----
  for (const { node, entry } of entryNodeByTrunk.characters.values()) {
    for (const relLink of list(entry.relationshipLinks)) {
      const target = entryNodeByTrunk.characters.get(relLink?.targetCharacterId);
      if (!target || target.node.id === node.id) continue;
      link({
        source: node.id,
        target: target.node.id,
        type: relLink.type || 'custom',
        directed: true,
        label: text(relLink.description) || null,
        since: Math.max(node.firstIssue, target.node.firstIssue),
      });
    }
  }

  // ---- authored object ↔ character attachments ----
  for (const { node, entry } of entryNodeByTrunk.objects.values()) {
    for (const attachment of list(entry.attachments)) {
      const target = entryNodeByTrunk.characters.get(attachment?.characterId);
      if (!target) continue;
      link({
        source: node.id,
        target: target.node.id,
        type: 'attachment',
        label: attachment.role || 'custom',
        since: Math.max(node.firstIssue, target.node.firstIssue),
      });
    }
  }

  // ---- composite sheets + the linked mood board ----
  const sheets = list(universe.compositeSheets);
  const canonByTrunk = sheets.length
    ? Object.fromEntries(TRUNKS.map((t) => [t.key, list(universe[t.key]).filter((e) => e?.id)]))
    : {};
  for (const sheet of sheets) {
    if (!sheet?.id) continue;
    const id = nodeId('composite', sheet.id);
    push({
      id,
      kind: 'composite',
      name: sheet.label,
      role: (sheet.kind || 'reference_sheet').replace(/_/g, ' '),
      recordId: sheet.id,
      hasImage: list(sheet.imageRefs).length > 0,
      primaryImageRef: list(sheet.imageRefs).at(-1) || null,
      firstIssue: 0,
    });
    // Which canon a sheet is *about* is not stored — the same prose matcher the
    // cross-reference uses reads it back out of the sheet's own prompt.
    const corpus = `${sheet.label}\n${sheet.prompt}`;
    for (const trunk of TRUNKS) {
      for (const matched of trunk.match(corpus, canonByTrunk[trunk.key])) {
        const target = entryNodeByTrunk[trunk.key].get(matched.id);
        if (target) link({ source: id, target: target.node.id, type: 'imageref', since: 0 });
      }
    }
  }
  if (universe.moodBoardId) {
    push({
      id: nodeId('moodboard', universe.moodBoardId),
      kind: 'moodboard',
      name: 'Linked mood board',
      role: 'Style source for this universe',
      recordId: universe.moodBoardId,
      hasImage: true,
      firstIssue: 0,
    });
  }

  return {
    universeId,
    name: universe.name,
    nodes,
    edges,
    series: orderedSeries.map((s) => ({ id: nodeId('series', s.id), recordId: s.id, name: s.name })),
    issues,
    totalIssues,
    appear,
  };
}
