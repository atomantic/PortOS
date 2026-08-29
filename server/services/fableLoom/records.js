/**
 * FableLoom record lifecycle — looms, episodes, scene nodes, and intent
 * transitions.
 *
 * A loom is a branching-narrative story: episodes hold a directed graph of
 * scene nodes; each node carries prose, image and single-clip video prompts,
 * camera direction, rendered media, and a list of intent-triggered transitions
 * the play LLM matches against free-text reader input. Legacy nodes without a
 * video prompt still render from scene text. All ids are server-minted. Every
 * write funnels through `mutateLoom` (per-record write queue + full re-sanitize),
 * so a malformed mutation can never persist.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { isStr, trimTo } from '../../lib/storyBible.js';
import { sanitizeLlmRoutePin } from '../../lib/llmRoutePin.js';
import { compareNewerWins } from '../../lib/lwwTimestamp.js';
import { sanitizeSoftDeleteFields } from '../../lib/syncWire.js';
import {
  contentHashForRecord,
  deleteSyncBaseHash,
  flushBaseHashes,
  maybeJournalBeforeOverwrite,
  setSyncBaseHash,
  withBaseHashFlushBatch,
} from '../../lib/conflictJournal.js';
import { getUniverse } from '../universeBuilder.js';
import { getSeries } from '../pipeline/series.js';
import {
  autoSubscribeRecordToAllPeers,
  emitRecordDeleted,
  emitRecordUpdated,
} from '../sharing/recordEvents.js';
import {
  deleteRaw,
  isValidLoomId,
  listRaw,
  queueLoomWrite,
  readRaw,
  writeRaw,
} from './store.js';
import { LOOM_LIMITS } from './limits.js';
import { asLoomFormat, isLoomFormat } from './formats.js';
import {
  asFableLoomPlaybackMode,
  isSafeVideoHistoryId,
  sanitizeInteractionWindow,
  sanitizePlaybackAssets,
} from '../../lib/fableLoomPlayback.js';
import {
  FABLELOOM_LEGACY_PARTICIPATION_MODE,
  asFableLoomAudienceConnection,
  asFableLoomParticipationMode,
} from '../../lib/fableLoomParticipation.js';
import { normalizeFableLoomCameraMovement } from '../../lib/fableLoomCameraMovements.js';

export { LOOM_LIMITS };

const isSafeImageFilename = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpg|jpeg|webp)$/i.test(value);

const nullableRef = (value) => (isStr(value) && value.trim() ? value.trim().slice(0, LOOM_LIMITS.REF_ID_MAX) : null);

const sanitizePos = (raw) => (raw && typeof raw === 'object'
  && Number.isFinite(raw.x) && Number.isFinite(raw.y)
  ? { x: Math.round(raw.x), y: Math.round(raw.y) }
  : null);

const sanitizeVisualConditioning = (raw) => {
  if (!raw || typeof raw !== 'object' || raw.version !== 1) return null;
  const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);
  const capability = raw.capability && typeof raw.capability === 'object' ? raw.capability : {};
  const bindings = raw.bindings && typeof raw.bindings === 'object' ? raw.bindings : {};
  return {
    version: 1,
    compilerVersion: trimTo(raw.compilerVersion, 40),
    status: ['locked', 'draft', 'degraded'].includes(raw.status) ? raw.status : 'degraded',
    universeId: nullableRef(raw.universeId),
    capability: {
      version: Number.isInteger(capability.version) ? capability.version : 1,
      kind: capability.kind === 'video' ? 'video' : 'image',
      backend: trimTo(capability.backend, 40),
      modelId: nullableRef(capability.modelId),
      referenceRoles: list(capability.referenceRoles, 24)
        .map((item) => trimTo(item, 64)).filter(Boolean),
      referenceBudget: Number.isInteger(capability.referenceBudget)
        ? Math.max(0, Math.min(24, capability.referenceBudget)) : 0,
      supportsLora: capability.supportsLora === true,
      loraCompatKey: nullableRef(capability.loraCompatKey),
      loraBudget: Number.isInteger(capability.loraBudget)
        ? Math.max(0, Math.min(8, capability.loraBudget)) : 0,
      multiCharacterPreservation: capability.multiCharacterPreservation === true,
      ...(capability.kind === 'video' ? {
        firstFrame: capability.firstFrame === true,
        lastFrame: capability.lastFrame === true,
        extension: capability.extension === true,
      } : {}),
    },
    bindings: {
      inferred: bindings.inferred === true,
      characterAppearances: list(bindings.characterAppearances, LOOM_LIMITS.VISUAL_BINDINGS_MAX)
        .filter((item) => item && typeof item === 'object' && nullableRef(item.characterId))
        .map((item) => ({
          characterId: nullableRef(item.characterId),
          wardrobeId: nullableRef(item.wardrobeId),
          expression: trimTo(item.expression, LOOM_LIMITS.VISUAL_NOTE_MAX),
          continuityNotes: trimTo(item.continuityNotes, LOOM_LIMITS.VISUAL_NOTE_MAX),
        })),
      placeId: nullableRef(bindings.placeId),
      objectIds: list(bindings.objectIds, LOOM_LIMITS.VISUAL_BINDINGS_MAX)
        .map(nullableRef).filter(Boolean),
    },
    assets: list(raw.assets, LOOM_LIMITS.VISUAL_PROVENANCE_ASSETS_MAX)
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        role: trimTo(item.role, 64), bindingId: nullableRef(item.bindingId),
        required: item.required === true, filename: trimTo(item.filename, 256),
      })),
    adapters: list(raw.adapters, 8)
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        characterId: nullableRef(item.characterId), filename: trimTo(item.filename, 256),
        scale: Number.isFinite(item.scale) ? Math.max(0, Math.min(2, item.scale)) : 1,
        sha256: typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(item.sha256) ? item.sha256 : null,
      })),
    omitted: list(raw.omitted, LOOM_LIMITS.VISUAL_PROVENANCE_MESSAGES_MAX)
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        role: trimTo(item.role, 64), bindingId: nullableRef(item.bindingId),
        reason: trimTo(item.reason, 80),
        ...(item.filename ? { filename: trimTo(item.filename, 256) } : {}),
      })),
    warnings: (Array.isArray(raw.warnings) ? raw.warnings : [])
      .map((item) => trimTo(item, LOOM_LIMITS.VISUAL_NOTE_MAX)).filter(Boolean)
      .slice(0, LOOM_LIMITS.VISUAL_PROVENANCE_MESSAGES_MAX),
    temporalSourceNodeId: nullableRef(raw.temporalSourceNodeId),
    compiledAt: isStr(raw.compiledAt) ? raw.compiledAt : null,
  };
};

const sanitizeVisualCanon = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const appearances = (Array.isArray(raw.characterAppearances) ? raw.characterAppearances : [])
    .filter((item) => item && typeof item === 'object' && nullableRef(item.characterId))
    .slice(0, LOOM_LIMITS.VISUAL_BINDINGS_MAX)
    .map((item) => ({
      characterId: nullableRef(item.characterId),
      wardrobeId: nullableRef(item.wardrobeId),
      expression: trimTo(item.expression, LOOM_LIMITS.VISUAL_NOTE_MAX),
      continuityNotes: trimTo(item.continuityNotes, LOOM_LIMITS.VISUAL_NOTE_MAX),
    }));
  return {
    mode: raw.mode === 'draft' ? 'draft' : 'locked',
    characterAppearances: appearances,
    placeId: nullableRef(raw.placeId),
    objectIds: (Array.isArray(raw.objectIds) ? raw.objectIds : [])
      .map(nullableRef).filter(Boolean).slice(0, LOOM_LIMITS.VISUAL_BINDINGS_MAX),
    continuitySourceNodeId: nullableRef(raw.continuitySourceNodeId),
    shotNotes: trimTo(raw.shotNotes, LOOM_LIMITS.VISUAL_NOTE_MAX),
    storyboardImageApproved: raw.storyboardImageApproved === true,
  };
};

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
    videoPrompt: trimTo(raw.videoPrompt, LOOM_LIMITS.VIDEO_PROMPT_MAX),
    cameraMovement: trimTo(normalizeFableLoomCameraMovement(raw.cameraMovement), LOOM_LIMITS.CAMERA_MOVEMENT_MAX),
    visualCanon: sanitizeVisualCanon(raw.visualCanon),
    visualConditioning: sanitizeVisualConditioning(raw.visualConditioning),
    playbackMode: asFableLoomPlaybackMode(raw.playbackMode),
    audienceConnection: asFableLoomAudienceConnection(raw.audienceConnection),
    videoHistoryId: isSafeVideoHistoryId(raw.videoHistoryId) ? raw.videoHistoryId : null,
    playbackAssets: sanitizePlaybackAssets(raw.playbackAssets),
    interactionWindow: sanitizeInteractionWindow(raw.interactionWindow),
    isEnding: raw.isEnding === true,
    // The format this scene's text is actually WRITTEN in — server-set, not
    // patchable. `null` means unknown (authored before the field existed, or
    // by hand), which a reformat treats as "needs converting". Without it a
    // rewrite that stopped at the per-request ceiling would re-send the scenes
    // it already converted and never reach the ones it didn't.
    format: isLoomFormat(raw.format) ? raw.format : null,
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

const planItemId = (prefix, value, seenIds) => {
  const candidate = isStr(value) && value.trim() ? value.trim().slice(0, 80) : '';
  const id = candidate && !seenIds.has(candidate) ? candidate : `${prefix}-${randomUUID()}`;
  seenIds.add(id);
  return id;
};

const planEpisodeRef = (value, episodeIds) => (
  isStr(value) && episodeIds.has(value) ? value : null
);

function sanitizeSeriesPlan(raw, episodes) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const episodeIds = new Set(episodes.map((episode) => episode.id));
  const plotIds = new Set();
  const questIds = new Set();
  return {
    storyArc: trimTo(source.storyArc, LOOM_LIMITS.STORY_ARC_MAX),
    plotPoints: (Array.isArray(source.plotPoints) ? source.plotPoints : [])
      .filter((item) => item && typeof item === 'object')
      .slice(0, LOOM_LIMITS.PLAN_ITEMS_MAX)
      .map((item) => ({
        id: planItemId('plot', item.id, plotIds),
        title: trimTo(item.title, LOOM_LIMITS.PLAN_ITEM_TITLE_MAX),
        description: trimTo(item.description, LOOM_LIMITS.PLAN_ITEM_DESCRIPTION_MAX),
        episodeId: planEpisodeRef(item.episodeId, episodeIds),
      })),
    sideQuests: (Array.isArray(source.sideQuests) ? source.sideQuests : [])
      .filter((item) => item && typeof item === 'object')
      .slice(0, LOOM_LIMITS.PLAN_ITEMS_MAX)
      .map((item) => ({
        id: planItemId('quest', item.id, questIds),
        title: trimTo(item.title, LOOM_LIMITS.PLAN_ITEM_TITLE_MAX),
        description: trimTo(item.description, LOOM_LIMITS.PLAN_ITEM_DESCRIPTION_MAX),
        status: ['idea', 'planned', 'active', 'resolved'].includes(item.status) ? item.status : 'idea',
        startEpisodeId: planEpisodeRef(item.startEpisodeId, episodeIds),
        endEpisodeId: planEpisodeRef(item.endEpisodeId, episodeIds),
      })),
  };
}

export function sanitizeLoom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isStr(raw.id) || !raw.id) return null;
  const name = trimTo(raw.name, LOOM_LIMITS.NAME_MAX);
  if (!name) return null;
  const now = new Date().toISOString();
  const { deleted, deletedAt } = sanitizeSoftDeleteFields(raw);
  const episodes = (Array.isArray(raw.episodes) ? raw.episodes : [])
    .map(sanitizeEpisode)
    .filter(Boolean)
    .slice(0, LOOM_LIMITS.EPISODES_MAX)
    .sort((a, b) => a.number - b.number || a.createdAt.localeCompare(b.createdAt));
  return {
    id: raw.id,
    schemaVersion: 2,
    name,
    logline: trimTo(raw.logline, LOOM_LIMITS.LOGLINE_MAX),
    premise: trimTo(raw.premise, LOOM_LIMITS.PREMISE_MAX),
    styleNotes: trimTo(raw.styleNotes, LOOM_LIMITS.STYLE_NOTES_MAX),
    participationMode: asFableLoomParticipationMode(raw.participationMode),
    audienceCommunicationMedium: trimTo(
      raw.audienceCommunicationMedium,
      LOOM_LIMITS.AUDIENCE_COMMUNICATION_MEDIUM_MAX,
    ),
    format: asLoomFormat(raw.format),
    // The loom's route pin for the play stage — which provider/model/effort
    // turns a reader's free text into a path. An unset dimension stays null
    // ('fall through to the stage pin / active provider').
    playSettings: sanitizeLlmRoutePin(raw.playSettings),
    universeId: nullableRef(raw.universeId),
    seriesId: nullableRef(raw.seriesId),
    seriesPlan: sanitizeSeriesPlan(raw.seriesPlan, episodes),
    episodes,
    createdAt: isStr(raw.createdAt) && raw.createdAt ? raw.createdAt : now,
    updatedAt: isStr(raw.updatedAt) && raw.updatedAt ? raw.updatedAt : now,
    deleted,
    deletedAt,
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
  if (!loom || loom.deleted) throw notFound();
  return loom;
};

export async function listLooms({ includeDeleted = false } = {}) {
  const records = (await listRaw()).map(sanitizeLoom).filter(Boolean);
  const visible = includeDeleted ? records : records.filter((loom) => !loom.deleted);
  return visible.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
}

/**
 * Index-page projection: everything the list UI shows, WITHOUT the episode
 * graphs — a woven episode carries up to 20k chars of prose per node, so the
 * full records would make the index multi-MB to render three counts.
 *
 * `seriesId` scopes the list to one pipeline series' linked looms. The link is
 * a soft ref, so a series that no longer exists simply matches nothing — this
 * never throws on a dangling id.
 */
export async function listLoomSummaries({ seriesId: scopeSeriesId } = {}) {
  const looms = await listLooms();
  const scoped = scopeSeriesId ? looms.filter((loom) => loom.seriesId === scopeSeriesId) : looms;
  return scoped.map(({
    id, name, logline, format, participationMode, audienceCommunicationMedium,
    universeId, seriesId, createdAt, updatedAt, episodes,
  }) => ({
    id,
    name,
    logline,
    format,
    participationMode,
    audienceCommunicationMedium,
    universeId,
    seriesId,
    createdAt,
    updatedAt,
    episodeCount: episodes.length,
    sceneCount: episodes.reduce((sum, e) => sum + e.nodes.length, 0),
    endingCount: episodes.reduce((sum, e) => sum + e.nodes.filter((n) => n.isEnding).length, 0),
  }));
}

export async function getLoom(id, { includeDeleted = false } = {}) {
  if (!isValidLoomId(id)) return null;
  const loom = sanitizeLoom(await readRaw(id));
  return loom && (includeDeleted || !loom.deleted) ? loom : null;
}

const assertParticipationConfigured = ({ participationMode, audienceCommunicationMedium }) => {
  if (asFableLoomParticipationMode(participationMode) === 'helper'
    && !trimTo(audienceCommunicationMedium, LOOM_LIMITS.AUDIENCE_COMMUNICATION_MEDIUM_MAX)) {
    throw new ServerError('Helper stories need an audience communication medium', {
      status: 400,
      code: 'AUDIENCE_MEDIUM_REQUIRED',
    });
  }
};

export async function createLoom({
  name, logline, premise, styleNotes, format, playSettings, seriesPlan,
  participationMode = FABLELOOM_LEGACY_PARTICIPATION_MODE,
  audienceCommunicationMedium, universeId, seriesId,
} = {}) {
  const now = new Date().toISOString();
  assertParticipationConfigured({ participationMode, audienceCommunicationMedium });
  await assertRefsExist({ universeId: nullableRef(universeId), seriesId: nullableRef(seriesId) });
  const loom = sanitizeLoom({
    id: `loom-${randomUUID()}`,
    name,
    logline,
    premise,
    styleNotes,
    participationMode,
    audienceCommunicationMedium,
    format,
    playSettings,
    seriesPlan,
    universeId,
    seriesId,
    episodes: [],
    createdAt: now,
    updatedAt: now,
  });
  if (!loom) throw new ServerError('Loom needs a name', { status: 400, code: 'VALIDATION_ERROR' });
  await writeRaw(loom.id, loom);
  emitRecordUpdated('fableLoom', loom.id);
  autoSubscribeRecordToAllPeers('fableLoom', loom.id).catch(() => {});
  return loom;
}

/**
 * Serialized read-modify-write. `mutator(current)` returns the changed record
 * (or a falsy value to skip the write). The result is re-sanitized before
 * persisting so a mutation can never store a malformed record.
 */
export async function mutateLoom(id, mutator) {
  if (!isValidLoomId(id)) throw notFound();
  const result = await queueLoomWrite(id, async () => {
    const current = await requireLoomRaw(id);
    const changed = await mutator(current);
    if (!changed) return { loom: current, changed: false };
    const next = sanitizeLoom({ ...changed, id, updatedAt: new Date().toISOString() });
    if (!next) throw new ServerError('Invalid loom record', { status: 400, code: 'VALIDATION_ERROR' });
    await writeRaw(id, next);
    return { loom: next, changed: true };
  });
  if (result.changed) emitRecordUpdated('fableLoom', id);
  return result.loom;
}

const PATCH_FIELDS = [
  'name', 'logline', 'premise', 'styleNotes', 'format', 'playSettings', 'seriesPlan',
  'participationMode', 'audienceCommunicationMedium', 'universeId', 'seriesId',
];

const RESTORABLE_FIELDS = [
  'name', 'logline', 'premise', 'styleNotes', 'format', 'playSettings', 'seriesPlan',
  'participationMode', 'audienceCommunicationMedium', 'episodes',
];

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
    assertParticipationConfigured(next);
    return next;
  });
}

/** Reapply a conflict snapshot through the normal mutation/push lifecycle. */
export function restoreLoom(id, patch = {}) {
  return mutateLoom(id, (loom) => {
    const next = { ...loom };
    for (const key of RESTORABLE_FIELDS) {
      if (key in patch) next[key] = patch[key];
    }
    assertParticipationConfigured(next);
    return next;
  });
}

export async function deleteLoom(id) {
  if (!isValidLoomId(id)) throw notFound();
  await queueLoomWrite(id, async () => {
    const current = await requireLoomRaw(id);
    const now = new Date().toISOString();
    await writeRaw(id, sanitizeLoom({
      ...current,
      deleted: true,
      deletedAt: now,
      updatedAt: now,
    }));
  });
  emitRecordDeleted('fableLoom', id);
}

// A v1 peer cannot represent the v2 scene production fields. When that older
// peer wins whole-record LWW after an unrelated edit, retain the local fields
// on nodes that still exist instead of letting its unaware sanitizer clear
// them. A v2 sender's present null remains an intentional clear.
const preserveLegacyVisualProduction = (remote, local, senderVersion) => {
  if (!local || senderVersion >= 2) return remote;
  const localEpisodes = new Map(local.episodes.map((episode) => [episode.id, episode]));
  return {
    ...remote,
    episodes: remote.episodes.map((episode) => {
      const localNodes = new Map((localEpisodes.get(episode.id)?.nodes || []).map((node) => [node.id, node]));
      return {
        ...episode,
        nodes: episode.nodes.map((node) => {
          const localNode = localNodes.get(node.id);
          return localNode ? {
            ...node,
            visualCanon: localNode.visualCanon,
            visualConditioning: localNode.visualConditioning,
          } : node;
        }),
      };
    }),
  };
};

/**
 * Merge FableLoom records received from a federated peer. Records are
 * sanitized before persistence, unioned by id, and resolved by whole-record
 * LWW on `updatedAt`; tombstones travel through the same path.
 */
export async function mergeLoomsFromSync(
  remoteLooms,
  {
    source = { via: 'sync', peerId: null },
    senderSchemaVersions = { fableLoom: 2 },
  } = {},
) {
  if (!Array.isArray(remoteLooms)) return { applied: false, count: 0 };
  const byId = new Map();
  for (const raw of remoteLooms) {
    const remote = sanitizeLoom(raw);
    if (!remote || !isValidLoomId(remote.id) || byId.has(remote.id)) continue;
    byId.set(remote.id, remote);
  }
  let changed = 0;
  for (const remote of byId.values()) {
    const applied = await queueLoomWrite(remote.id, async () => {
      const local = sanitizeLoom(await readRaw(remote.id));
      if (local && !compareNewerWins(remote.updatedAt, local.updatedAt)) return false;
      const merged = preserveLegacyVisualProduction(
        remote,
        local,
        Number(senderSchemaVersions?.fableLoom) || 0,
      );
      if (local) {
        await maybeJournalBeforeOverwrite({
          kind: 'fableLoom', id: remote.id, local, remote: merged, source,
        });
      } else {
        await setSyncBaseHash(
          'fableLoom',
          merged.id,
          contentHashForRecord('fableLoom', merged),
        );
      }
      await writeRaw(merged.id, merged);
      return true;
    });
    if (applied) changed += 1;
  }
  await flushBaseHashes();
  if (changed > 0) console.log(`🧶 FableLoom sync: merged ${changed} loom(s)`);
  return { applied: changed > 0, count: changed };
}

/** Hard-prune tombstones only after the shared federation GC computes a safe cutoff. */
export async function pruneTombstonedLooms(olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return { pruned: 0 };
  const candidates = (await listLooms({ includeDeleted: true }))
    .filter((loom) => loom.deleted && Number.isFinite(Date.parse(loom.deletedAt))
      && Date.parse(loom.deletedAt) < olderThanMs);
  let pruned = 0;
  await withBaseHashFlushBatch(async () => {
    for (const candidate of candidates) {
      const removed = await queueLoomWrite(candidate.id, async () => {
        const current = sanitizeLoom(await readRaw(candidate.id));
        const deletedAtMs = Date.parse(current?.deletedAt || '');
        if (!current?.deleted || !Number.isFinite(deletedAtMs) || deletedAtMs >= olderThanMs) return false;
        await deleteRaw(candidate.id);
        await deleteSyncBaseHash('fableLoom', candidate.id);
        return true;
      });
      if (removed) pruned += 1;
    }
  });
  return { pruned };
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

export const findTransition = (node, transitionId) => {
  const transition = (node.transitions || []).find((t) => t.id === transitionId);
  if (!transition) throw notFound('Path');
  return transition;
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

const NODE_PATCH_FIELDS = [
  'title', 'prose', 'imagePrompt', 'videoPrompt', 'cameraMovement', 'playbackMode',
  'audienceConnection', 'visualCanon', 'videoHistoryId', 'playbackAssets', 'interactionWindow',
  'isEnding', 'endingLabel', 'pos', 'transitions',
];

export function addNode(loomId, episodeId, fields = {}) {
  return mutateLoom(loomId, (loom) => {
    const episode = findEpisode(loom, episodeId);
    if (episode.nodes.length >= LOOM_LIMITS.NODES_MAX) {
      throw new ServerError('Scene limit reached', { status: 400, code: 'LIMIT_REACHED' });
    }
    const node = { id: `node-${randomUUID()}`, ...fields };
    if (asFableLoomParticipationMode(loom.participationMode) === 'helper'
      && asFableLoomAudienceConnection(fields.audienceConnection) !== 'connected'
      && !('playbackMode' in fields)) {
      node.playbackMode = 'cut';
    }
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

// --- Transitions as sub-resources -------------------------------------------
//
// The whole-array `transitions` key on the node PATCH still works (the
// sanitizer owns it, and an older client or a peer on a previous version keeps
// using it). These three add/edit/drop ONE edge, so a second writer — a voice
// action, a CoS agent, the AI branch lane — no longer has to replay the whole
// array off a snapshot that may already be stale.

const TRANSITION_PATCH_FIELDS = ['targetNodeId', 'intent', 'triggers', 'description'];

// The sanitizer re-runs on every write, so the row that comes back out is the
// one that actually persisted (id, trimmed fields, capped triggers) — not the
// input echoed back.
const readTransition = (loom, episodeId, nodeId, transitionId) =>
  loom.episodes.find((e) => e.id === episodeId)
    ?.nodes.find((n) => n.id === nodeId)
    ?.transitions.find((t) => t.id === transitionId) ?? null;

/**
 * Add one path out of a scene. The id is minted here rather than inside the
 * sanitizer so the caller can read the stored row back out by it — that is the
 * whole point of the sub-resource: the client knows the id at create time and
 * never has to reconcile server-minted ids into locally-added rows.
 */
export async function addNodeTransition(loomId, episodeId, nodeId, fields = {}) {
  const id = `tr-${randomUUID()}`;
  const loom = await mutateLoom(loomId, (record) => {
    const episode = findEpisode(record, episodeId);
    const node = findNode(episode, nodeId);
    if ((node.transitions || []).length >= LOOM_LIMITS.TRANSITIONS_MAX) {
      throw new ServerError('Path limit reached', { status: 400, code: 'LIMIT_REACHED' });
    }
    node.transitions = [...(node.transitions || []), { ...fields, id }];
    episode.updatedAt = new Date().toISOString();
    return record;
  });
  return { loom, transition: readTransition(loom, episodeId, nodeId, id) };
}

export function updateNodeTransition(loomId, episodeId, nodeId, transitionId, patch = {}) {
  return mutateLoom(loomId, (record) => {
    const episode = findEpisode(record, episodeId);
    const transition = findTransition(findNode(episode, nodeId), transitionId);
    for (const key of TRANSITION_PATCH_FIELDS) {
      if (key in patch) transition[key] = patch[key];
    }
    episode.updatedAt = new Date().toISOString();
    return record;
  });
}

export function deleteNodeTransition(loomId, episodeId, nodeId, transitionId) {
  return mutateLoom(loomId, (record) => {
    const episode = findEpisode(record, episodeId);
    const node = findNode(episode, nodeId);
    findTransition(node, transitionId);
    node.transitions = node.transitions.filter((t) => t.id !== transitionId);
    episode.updatedAt = new Date().toISOString();
    return record;
  });
}

/**
 * Durable image attach for the media-job completion hook: files a finished
 * render onto its node, even when the editor unmounted mid-render. Returns the
 * updated node (or null when the loom/episode/node has since been deleted —
 * the hook logs and moves on rather than erroring).
 */
export async function attachNodeImage(loomId, episodeId, nodeId, { filename, jobId, visualConditioning = null }) {
  if (!isValidLoomId(loomId) || !isSafeImageFilename(filename)) return null;
  const updated = await mutateLoom(loomId, (loom) => {
    const episode = loom.episodes.find((e) => e.id === episodeId);
    const node = episode?.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    node.image = filename;
    node.imageJobId = isStr(jobId) ? jobId : null;
    node.visualConditioning = visualConditioning;
    if (node.visualCanon) node.visualCanon.storyboardImageApproved = false;
    episode.updatedAt = new Date().toISOString();
    return loom;
  }).catch(() => null);
  return updated?.episodes.find((e) => e.id === episodeId)?.nodes.find((n) => n.id === nodeId) ?? null;
}

/**
 * Durable video attach for the media-job completion hook. Video history ids
 * are also the generated filenames under data/videos, but are kept as ids so
 * the node can use the same history/media conventions as other video surfaces.
 */
export async function attachNodeVideo(loomId, episodeId, nodeId, { videoHistoryId, visualConditioning = null }) {
  if (!isValidLoomId(loomId) || !isSafeVideoHistoryId(videoHistoryId)) return null;
  const updated = await mutateLoom(loomId, (loom) => {
    const episode = loom.episodes.find((e) => e.id === episodeId);
    const node = episode?.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    node.videoHistoryId = videoHistoryId;
    node.visualConditioning = visualConditioning;
    episode.updatedAt = new Date().toISOString();
    return loom;
  }).catch(() => null);
  return updated?.episodes.find((e) => e.id === episodeId)?.nodes.find((n) => n.id === nodeId) ?? null;
}

/**
 * Attach a typed playback asset (entry clip, hold loop, or transition exit) onto
 * a node with optional audio occupancy manifest and provenance.
 */
export async function attachNodePlaybackAsset(loomId, episodeId, nodeId, {
  role = 'entry',
  videoHistoryId,
  transitionId = null,
  audioOccupancy = null,
  provenance = null,
} = {}) {
  if (!isValidLoomId(loomId) || !isSafeVideoHistoryId(videoHistoryId)) return null;
  const updated = await mutateLoom(loomId, (loom) => {
    const episode = loom.episodes.find((e) => e.id === episodeId);
    const node = episode?.nodes.find((n) => n.id === nodeId);
    if (!node) return null;

    const currentAssets = node.playbackAssets || {
      entryVideoHistoryId: null,
      holdLoopVideoHistoryIds: [],
      exitByTransition: {},
      audioOccupancy: {},
    };

    const nextAssets = {
      ...currentAssets,
      exitByTransition: { ...(currentAssets.exitByTransition || {}) },
      audioOccupancy: { ...(currentAssets.audioOccupancy || {}) },
      holdLoopVideoHistoryIds: [...(currentAssets.holdLoopVideoHistoryIds || [])],
    };

    if (role === 'entry') {
      nextAssets.entryVideoHistoryId = videoHistoryId;
      node.videoHistoryId = videoHistoryId;
    } else if (role === 'hold') {
      if (!nextAssets.holdLoopVideoHistoryIds.includes(videoHistoryId)) {
        nextAssets.holdLoopVideoHistoryIds.push(videoHistoryId);
      }
      if (!node.videoHistoryId) node.videoHistoryId = videoHistoryId;
    } else if (role === 'exit' && isStr(transitionId)) {
      nextAssets.exitByTransition[transitionId] = videoHistoryId;
    }

    if (audioOccupancy) {
      nextAssets.audioOccupancy[videoHistoryId] = audioOccupancy;
    }
    if (provenance) {
      nextAssets.provenance = provenance;
    }

    node.playbackAssets = nextAssets;
    episode.updatedAt = new Date().toISOString();
    return loom;
  }).catch(() => null);

  return updated?.episodes.find((e) => e.id === episodeId)?.nodes.find((n) => n.id === nodeId) ?? null;
}

