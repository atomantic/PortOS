/**
 * FableLoom record lifecycle — looms, episodes, scene nodes, and intent
 * transitions.
 *
 * A loom is a branching-narrative story: episodes hold a directed graph of
 * scene nodes; each node carries prose, an image prompt/render, and a list of
 * intent-triggered transitions the play LLM matches free-text reader input
 * against. All ids are server-minted. Every write funnels through
 * `mutateLoom` (per-record write queue + full re-sanitize), so a malformed
 * mutation can never persist.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { isStr, trimTo } from '../../lib/storyBible.js';
import { getUniverse } from '../universeBuilder.js';
import { getSeries } from '../pipeline/series.js';
import {
  deleteRaw,
  isValidLoomId,
  listRaw,
  queueLoomWrite,
  readRaw,
  writeRaw,
} from './store.js';
import { LOOM_LIMITS } from './limits.js';
import { asLoomFormat } from './formats.js';

export { LOOM_LIMITS };

const isSafeImageFilename = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpg|jpeg|webp)$/i.test(value);

const nullableRef = (value) => (isStr(value) && value.trim() ? value.trim().slice(0, LOOM_LIMITS.REF_ID_MAX) : null);

/**
 * The loom's pinned routing for the play stage — which provider/model/effort
 * turns a reader's free text into a path. Stored as a whole object so an
 * unset dimension stays unset (null = "fall through to the stage pin / active
 * provider"), rather than collapsing to an empty string that would read as a
 * deliberate choice downstream.
 */
const sanitizePlaySettings = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const pick = (value, max) => trimTo(value, max) || null;
  const settings = {
    providerId: pick(raw.providerId, LOOM_LIMITS.PROVIDER_ID_MAX),
    model: pick(raw.model, LOOM_LIMITS.MODEL_ID_MAX),
    effort: pick(raw.effort, LOOM_LIMITS.EFFORT_MAX),
  };
  return Object.values(settings).some(Boolean) ? settings : null;
};

const sanitizePos = (raw) => (raw && typeof raw === 'object'
  && Number.isFinite(raw.x) && Number.isFinite(raw.y)
  ? { x: Math.round(raw.x), y: Math.round(raw.y) }
  : null);

function sanitizeTransition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const intent = trimTo(raw.intent, LOOM_LIMITS.INTENT_MAX);
  const targetNodeId = isStr(raw.targetNodeId) ? raw.targetNodeId : '';
  if (!targetNodeId) return null;
  return {
    id: isStr(raw.id) && raw.id ? raw.id : `tr-${randomUUID()}`,
    targetNodeId,
    intent,
    triggers: (Array.isArray(raw.triggers) ? raw.triggers : [])
      .map((t) => trimTo(t, LOOM_LIMITS.TRIGGER_MAX))
      .filter(Boolean)
      .slice(0, LOOM_LIMITS.TRIGGERS_MAX),
    description: trimTo(raw.description, LOOM_LIMITS.TRANSITION_DESC_MAX),
  };
}

function sanitizeNode(raw) {
  if (!raw || typeof raw !== 'object' || !isStr(raw.id) || !raw.id) return null;
  return {
    id: raw.id,
    title: trimTo(raw.title, LOOM_LIMITS.NODE_TITLE_MAX),
    prose: trimTo(raw.prose, LOOM_LIMITS.PROSE_MAX),
    imagePrompt: trimTo(raw.imagePrompt, LOOM_LIMITS.IMAGE_PROMPT_MAX),
    image: isSafeImageFilename(raw.image) ? raw.image : null,
    imageJobId: isStr(raw.imageJobId) && raw.imageJobId ? raw.imageJobId.slice(0, 200) : null,
    isEnding: raw.isEnding === true,
    endingLabel: trimTo(raw.endingLabel, LOOM_LIMITS.ENDING_LABEL_MAX),
    transitions: (Array.isArray(raw.transitions) ? raw.transitions : [])
      .map(sanitizeTransition)
      .filter(Boolean)
      .slice(0, LOOM_LIMITS.TRANSITIONS_MAX),
    pos: sanitizePos(raw.pos),
  };
}

function sanitizeEpisode(raw) {
  if (!raw || typeof raw !== 'object' || !isStr(raw.id) || !raw.id) return null;
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : [])
    .map(sanitizeNode)
    .filter(Boolean)
    .slice(0, LOOM_LIMITS.NODES_MAX);
  const nodeIds = new Set(nodes.map((n) => n.id));
  // Dangling transitions (a target dropped by the node cap, or authored to a
  // since-deleted id) are deliberately KEPT — the graph validation surfaces
  // them as errors the author resolves, rather than silently rewriting edges.
  const now = new Date().toISOString();
  return {
    id: raw.id,
    number: Number.isFinite(raw.number) ? Math.max(1, Math.round(raw.number)) : 1,
    title: trimTo(raw.title, LOOM_LIMITS.EPISODE_TITLE_MAX),
    synopsis: trimTo(raw.synopsis, LOOM_LIMITS.SYNOPSIS_MAX),
    startNodeId: isStr(raw.startNodeId) && nodeIds.has(raw.startNodeId) ? raw.startNodeId : (nodes[0]?.id ?? null),
    nodes,
    createdAt: isStr(raw.createdAt) && raw.createdAt ? raw.createdAt : now,
    updatedAt: isStr(raw.updatedAt) && raw.updatedAt ? raw.updatedAt : now,
  };
}

export function sanitizeLoom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isStr(raw.id) || !raw.id) return null;
  const name = trimTo(raw.name, LOOM_LIMITS.NAME_MAX);
  if (!name) return null;
  const now = new Date().toISOString();
  return {
    id: raw.id,
    schemaVersion: 1,
    name,
    logline: trimTo(raw.logline, LOOM_LIMITS.LOGLINE_MAX),
    premise: trimTo(raw.premise, LOOM_LIMITS.PREMISE_MAX),
    styleNotes: trimTo(raw.styleNotes, LOOM_LIMITS.STYLE_NOTES_MAX),
    format: asLoomFormat(raw.format),
    playSettings: sanitizePlaySettings(raw.playSettings),
    universeId: nullableRef(raw.universeId),
    seriesId: nullableRef(raw.seriesId),
    episodes: (Array.isArray(raw.episodes) ? raw.episodes : [])
      .map(sanitizeEpisode)
      .filter(Boolean)
      .slice(0, LOOM_LIMITS.EPISODES_MAX)
      .sort((a, b) => a.number - b.number || a.createdAt.localeCompare(b.createdAt)),
    createdAt: isStr(raw.createdAt) && raw.createdAt ? raw.createdAt : now,
    updatedAt: isStr(raw.updatedAt) && raw.updatedAt ? raw.updatedAt : now,
  };
}

const notFound = (what = 'Loom') => new ServerError(`${what} not found`, { status: 404, code: 'NOT_FOUND' });

// Soft refs are validated at write time (against the trimmed value that will
// actually persist) so a typo'd id fails loudly here rather than silently
// producing an empty canon digest at weave time. Lives in the service — not
// the route — because createLoom/updateLoom are public barrel exports any
// non-HTTP caller can reach (games' requireApp precedent).
async function assertRefsExist({ universeId, seriesId } = {}) {
  const [universe, series] = await Promise.all([
    universeId ? getUniverse(universeId).catch(() => null) : null,
    seriesId ? getSeries(seriesId).catch(() => null) : null,
  ]);
  if (universeId && !universe) {
    throw new ServerError('Linked universe not found', { status: 400, code: 'INVALID_UNIVERSE' });
  }
  if (seriesId && !series) {
    throw new ServerError('Linked series not found', { status: 400, code: 'INVALID_SERIES' });
  }
}

const requireLoomRaw = async (id) => {
  if (!isValidLoomId(id)) throw notFound();
  const loom = sanitizeLoom(await readRaw(id));
  if (!loom) throw notFound();
  return loom;
};

export async function listLooms() {
  const records = (await listRaw()).map(sanitizeLoom).filter(Boolean);
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
}

/**
 * Index-page projection: everything the list UI shows, WITHOUT the episode
 * graphs — a woven episode carries up to 20k chars of prose per node, so the
 * full records would make the index multi-MB to render three counts.
 */
export async function listLoomSummaries() {
  return (await listLooms()).map(({ id, name, logline, format, universeId, seriesId, createdAt, updatedAt, episodes }) => ({
    id,
    name,
    logline,
    format,
    universeId,
    seriesId,
    createdAt,
    updatedAt,
    episodeCount: episodes.length,
    sceneCount: episodes.reduce((sum, e) => sum + e.nodes.length, 0),
    endingCount: episodes.reduce((sum, e) => sum + e.nodes.filter((n) => n.isEnding).length, 0),
  }));
}

export async function getLoom(id) {
  if (!isValidLoomId(id)) return null;
  return sanitizeLoom(await readRaw(id));
}

export async function createLoom({ name, logline, premise, styleNotes, format, universeId, seriesId } = {}) {
  const now = new Date().toISOString();
  await assertRefsExist({ universeId: nullableRef(universeId), seriesId: nullableRef(seriesId) });
  const loom = sanitizeLoom({
    id: `loom-${randomUUID()}`,
    name,
    logline,
    premise,
    styleNotes,
    format,
    universeId,
    seriesId,
    episodes: [],
    createdAt: now,
    updatedAt: now,
  });
  if (!loom) throw new ServerError('Loom needs a name', { status: 400, code: 'VALIDATION_ERROR' });
  await writeRaw(loom.id, loom);
  return loom;
}

/**
 * Serialized read-modify-write. `mutator(current)` returns the changed record
 * (or a falsy value to skip the write). The result is re-sanitized before
 * persisting so a mutation can never store a malformed record.
 */
export function mutateLoom(id, mutator) {
  if (!isValidLoomId(id)) throw notFound();
  return queueLoomWrite(id, async () => {
    const current = await requireLoomRaw(id);
    const changed = await mutator(current);
    if (!changed) return current;
    const next = sanitizeLoom({ ...changed, id, updatedAt: new Date().toISOString() });
    if (!next) throw new ServerError('Invalid loom record', { status: 400, code: 'VALIDATION_ERROR' });
    await writeRaw(id, next);
    return next;
  });
}

const PATCH_FIELDS = ['name', 'logline', 'premise', 'styleNotes', 'format', 'playSettings', 'universeId', 'seriesId'];

export async function updateLoom(id, patch = {}) {
  await assertRefsExist({
    universeId: 'universeId' in patch ? nullableRef(patch.universeId) : null,
    seriesId: 'seriesId' in patch ? nullableRef(patch.seriesId) : null,
  });
  return mutateLoom(id, (loom) => {
    const next = { ...loom };
    for (const key of PATCH_FIELDS) {
      if (key in patch) next[key] = patch[key];
    }
    return next;
  });
}

export async function deleteLoom(id) {
  await requireLoomRaw(id);
  await deleteRaw(id);
}

// --- Episodes ---------------------------------------------------------------

export const findEpisode = (loom, episodeId) => {
  const episode = loom.episodes.find((e) => e.id === episodeId);
  if (!episode) throw notFound('Episode');
  return episode;
};

export const findNode = (episode, nodeId) => {
  const node = episode.nodes.find((n) => n.id === nodeId);
  if (!node) throw notFound('Scene');
  return node;
};

export function addEpisode(loomId, { title, synopsis } = {}) {
  return mutateLoom(loomId, (loom) => {
    if (loom.episodes.length >= LOOM_LIMITS.EPISODES_MAX) {
      throw new ServerError('Episode limit reached', { status: 400, code: 'LIMIT_REACHED' });
    }
    const now = new Date().toISOString();
    const number = loom.episodes.reduce((max, e) => Math.max(max, e.number), 0) + 1;
    loom.episodes.push({
      id: `ep-${randomUUID()}`,
      number,
      title,
      synopsis,
      startNodeId: null,
      nodes: [],
      createdAt: now,
      updatedAt: now,
    });
    return loom;
  });
}

export function updateEpisode(loomId, episodeId, patch = {}) {
  return mutateLoom(loomId, (loom) => {
    const episode = findEpisode(loom, episodeId);
    for (const key of ['title', 'synopsis', 'number', 'startNodeId']) {
      if (key in patch) episode[key] = patch[key];
    }
    episode.updatedAt = new Date().toISOString();
    return loom;
  });
}

export function deleteEpisode(loomId, episodeId) {
  return mutateLoom(loomId, (loom) => {
    findEpisode(loom, episodeId);
    loom.episodes = loom.episodes.filter((e) => e.id !== episodeId);
    return loom;
  });
}

// --- Nodes & transitions ----------------------------------------------------

const NODE_PATCH_FIELDS = ['title', 'prose', 'imagePrompt', 'isEnding', 'endingLabel', 'pos', 'transitions'];

export function addNode(loomId, episodeId, fields = {}) {
  return mutateLoom(loomId, (loom) => {
    const episode = findEpisode(loom, episodeId);
    if (episode.nodes.length >= LOOM_LIMITS.NODES_MAX) {
      throw new ServerError('Scene limit reached', { status: 400, code: 'LIMIT_REACHED' });
    }
    const node = { id: `node-${randomUUID()}`, ...fields };
    episode.nodes.push(node);
    if (!episode.startNodeId) episode.startNodeId = node.id;
    // Optionally wire the new node in as a branch of an existing one. The
    // sanitizer mints the transition id and fills triggers/description.
    if (isStr(fields.fromNodeId)) {
      const from = episode.nodes.find((n) => n.id === fields.fromNodeId);
      if (from) {
        from.transitions = [...(from.transitions || []), { targetNodeId: node.id, intent: fields.fromIntent }];
      }
    }
    episode.updatedAt = new Date().toISOString();
    return loom;
  });
}

export function updateNode(loomId, episodeId, nodeId, patch = {}) {
  return mutateLoom(loomId, (loom) => {
    const episode = findEpisode(loom, episodeId);
    const node = findNode(episode, nodeId);
    for (const key of NODE_PATCH_FIELDS) {
      if (key in patch) node[key] = patch[key];
    }
    episode.updatedAt = new Date().toISOString();
    return loom;
  });
}

export function deleteNode(loomId, episodeId, nodeId) {
  return mutateLoom(loomId, (loom) => {
    const episode = findEpisode(loom, episodeId);
    if (!episode.nodes.some((n) => n.id === nodeId)) throw notFound('Scene');
    episode.nodes = episode.nodes.filter((n) => n.id !== nodeId);
    // Strip inbound edges so deleting a scene never leaves dangling paths.
    for (const node of episode.nodes) {
      node.transitions = (node.transitions || []).filter((t) => t.targetNodeId !== nodeId);
    }
    if (episode.startNodeId === nodeId) episode.startNodeId = episode.nodes[0]?.id ?? null;
    episode.updatedAt = new Date().toISOString();
    return loom;
  });
}

/**
 * Durable image attach for the media-job completion hook: files a finished
 * render onto its node, even when the editor unmounted mid-render. Returns the
 * updated node (or null when the loom/episode/node has since been deleted —
 * the hook logs and moves on rather than erroring).
 */
export async function attachNodeImage(loomId, episodeId, nodeId, { filename, jobId }) {
  if (!isValidLoomId(loomId) || !isSafeImageFilename(filename)) return null;
  const updated = await mutateLoom(loomId, (loom) => {
    const episode = loom.episodes.find((e) => e.id === episodeId);
    const node = episode?.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    node.image = filename;
    node.imageJobId = isStr(jobId) ? jobId : null;
    episode.updatedAt = new Date().toISOString();
    return loom;
  }).catch(() => null);
  return updated?.episodes.find((e) => e.id === episodeId)?.nodes.find((n) => n.id === nodeId) ?? null;
}
