/**
 * Unified Story Builder — conductor service.
 *
 * The Story Builder is a thin *conductor* over the existing universe / series /
 * issue records. It owns ONE lightweight record (the "session") that tracks
 * per-step status + locks + integrity hashes plus two FKs (`universeId`,
 * `seriesId`). All real content lives in the universe and series records and is
 * mutated through their existing services — this service never duplicates it.
 *
 * Sessions are LOCAL-ONLY: they reference peer-syncable records by FK, but the
 * lock/integrity bookkeeping is a private workflow artifact. We deliberately do
 * NOT register a sync schema version, do NOT add the type to
 * RECORD_TYPE_CATEGORIES, and do NOT auto-subscribe peers on create — syncing a
 * session would create cross-install staleness false-positives. The
 * tombstone/origin/ephemeral fields are carried only for on-disk shape parity.
 *
 * Persisted to data/story-builder/{id}/index.json.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS } from '../lib/fileUtils.js';
import { createCollectionStore } from '../lib/collectionStore.js';
import { isStr, trimTo } from '../lib/storyBible.js';
import { sanitizeOrigin } from '../lib/sharingOrigin.js';
import { sanitizeSoftDeleteFields } from '../lib/syncWire.js';
import { runStagedLLM } from '../lib/stageRunner.js';
import {
  STEP_IDS, STEP_STATUSES, isValidStepId,
} from '../lib/storyBuilderSteps.js';
import { hashUpstream, computeStaleSteps } from '../lib/storyBuilderIntegrity.js';
import { createUniverse, deleteUniverse, getUniverse, updateUniverse } from './universeBuilder.js';
import { expandWorldTemplate } from './universeBuilderExpand.js';
import { refineWorldPrompts } from './universeBuilderRefine.js';
import { refineUniverseCharacter } from './universeCanon.js';
import {
  createSeries, getSeries, updateSeries, setArcFieldLock,
} from './pipeline/series.js';
import {
  generateArcOverview, generateArcFromSource, generateReaderMap, refineReaderMap, refineArc, commitSeasonsWithRemap, mergeArcWithLocks,
  collectIssueSourceText, generateSeasonEpisodes, commitEpisodesToIssues,
  ERR_VALIDATION as ARC_ERR_VALIDATION,
} from './pipeline/arcPlanner.js';

const TYPE_SCHEMA_VERSION = 1;

let _store = null;
const store = () => {
  if (_store && _store.dir === join(PATHS.data, 'story-builder')) return _store;
  _store = createCollectionStore({
    dir: join(PATHS.data, 'story-builder'),
    type: 'storyBuilder',
    schemaVersion: TYPE_SCHEMA_VERSION,
    sanitizeRecord: sanitizeSession,
    idPattern: /^stb-[A-Za-z0-9-]+$/,
  });
  return _store;
};
export const storyBuilderStore = () => store();

export const ERR_NOT_FOUND = 'STORY_BUILDER_NOT_FOUND';
export const ERR_VALIDATION = 'STORY_BUILDER_VALIDATION';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

const SESSION_ID_RE = /^stb-[A-Za-z0-9-]+$/;
export const TITLE_MAX = 200;
export const SEED_MAX = 4000;
export const INTAKE_MODES = Object.freeze(['seed', 'import']);

// The universe aesthetic step freezes these universe lock keys.
export const AESTHETIC_LOCK_FIELDS = Object.freeze([
  'logline', 'premise', 'styleNotes', 'influencesEmbrace', 'influencesAvoid',
]);

const nowIso = () => new Date().toISOString();

function sanitizeStepState(raw) {
  const status = STEP_STATUSES.includes(raw?.status) ? raw.status : 'pending';
  const locked = raw?.locked === true;
  return {
    status: locked ? 'locked' : status,
    locked,
    lockedAt: locked && isStr(raw?.lockedAt) ? raw.lockedAt : null,
    upstreamHash: locked && isStr(raw?.upstreamHash) ? raw.upstreamHash : null,
  };
}

function sanitizeIssueLocks(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [issueId, state] of Object.entries(raw)) {
    if (!isStr(issueId)) continue;
    if (state?.locked !== true) continue;
    out[issueId] = {
      locked: true,
      lockedAt: isStr(state.lockedAt) ? state.lockedAt : nowIso(),
      upstreamHash: isStr(state.upstreamHash) ? state.upstreamHash : null,
    };
  }
  return out;
}

function sanitizeSteps(raw) {
  const steps = {};
  for (const id of STEP_IDS) {
    steps[id] = sanitizeStepState(raw?.[id]);
  }
  // Per-issue locks ride on the `issues` step.
  const issueLocks = sanitizeIssueLocks(raw?.issues?.issueLocks);
  if (Object.keys(issueLocks).length > 0) steps.issues.issueLocks = issueLocks;
  return steps;
}

export function sanitizeSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isStr(raw.id) || !raw.id) return null;
  const title = trimTo(raw.title, TITLE_MAX);
  if (!title) return null;
  const intakeMode = INTAKE_MODES.includes(raw.intakeMode) ? raw.intakeMode : 'seed';
  const currentStep = isValidStepId(raw.currentStep) ? raw.currentStep : STEP_IDS[0];
  const llm = raw.llm && typeof raw.llm === 'object'
    ? { provider: trimTo(raw.llm.provider, 80) || null, model: trimTo(raw.llm.model, 200) || null }
    : { provider: null, model: null };
  const createdAt = isStr(raw.createdAt) ? raw.createdAt : nowIso();
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : createdAt;
  return {
    id: raw.id,
    title,
    intakeMode,
    seedIdea: trimTo(raw.seedIdea, SEED_MAX),
    universeId: trimTo(raw.universeId, 64) || null,
    seriesId: trimTo(raw.seriesId, 64) || null,
    currentStep,
    steps: sanitizeSteps(raw.steps),
    llm,
    origin: sanitizeOrigin(raw.origin),
    createdAt,
    updatedAt,
    ...sanitizeSoftDeleteFields(raw),
    ...(raw.ephemeral === true ? { ephemeral: true } : {}),
  };
}

// ── CRUD ────────────────────────────────────────────────────────────────

export async function listStorySessions({ includeDeleted = false } = {}) {
  const sessions = await store().loadAll();
  const filtered = includeDeleted ? sessions : sessions.filter((s) => !s.deleted);
  return [...filtered].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function getStorySession(id, { includeDeleted = false } = {}) {
  const found = await store().loadOne(id);
  if (!found) throw makeErr(`Story Builder session not found: ${id}`, ERR_NOT_FOUND);
  if (found.deleted && !includeDeleted) throw makeErr(`Story Builder session not found: ${id}`, ERR_NOT_FOUND);
  return found;
}

/**
 * Create a session. Seed mode mints fresh universe + series shells the
 * conductor will fill in step by step. Import mode expects the caller to have
 * already created/linked the universe + series (via the importer) and passes
 * their ids in.
 */
export async function createStorySession(input = {}) {
  const title = trimTo(input.title, TITLE_MAX);
  if (!title) throw makeErr(`Title is required (1..${TITLE_MAX} chars)`, ERR_VALIDATION);
  const intakeMode = INTAKE_MODES.includes(input.intakeMode) ? input.intakeMode : 'seed';
  const seedIdea = trimTo(input.seedIdea, SEED_MAX);

  let universeId = trimTo(input.universeId, 64) || null;
  let seriesId = trimTo(input.seriesId, 64) || null;

  if (intakeMode === 'seed') {
    // Mint the shells the wizard fills in. The universe name doubles as the
    // working title; the seed idea seeds the universe starter prompt.
    //
    // The universe is created first (and on creation fires peer auto-subscribe),
    // then the series. If `createSeries` throws, we'd otherwise leave an orphan
    // universe on disk with no session pointing at it. Track whether *we* minted
    // the universe in this call and tombstone it on a series failure — but never
    // touch a universe the caller passed in (`input.universeId`).
    let mintedUniverseId = null;
    if (!universeId) {
      const universe = await createUniverse({ name: title, starterPrompt: seedIdea || '' });
      universeId = universe.id;
      mintedUniverseId = universe.id;
    }
    if (!seriesId) {
      const series = await createSeries({ name: title, universeId, premise: seedIdea || '' }).catch(async (err) => {
        if (mintedUniverseId) {
          // Roll back the just-created universe so a failed session create
          // doesn't leave a stray (and already peer-subscribed) shell behind.
          await deleteUniverse(mintedUniverseId).catch((cleanupErr) => {
            console.error(`⚠️ Failed to roll back orphan universe ${mintedUniverseId} after series create failed: ${cleanupErr.message}`);
          });
        }
        throw err;
      });
      seriesId = series.id;
    }
  }

  const now = nowIso();
  const created = sanitizeSession({
    id: `stb-${randomUUID()}`,
    title,
    intakeMode,
    seedIdea,
    universeId,
    seriesId,
    currentStep: STEP_IDS[0],
    steps: {},
    llm: input.llm || null,
    createdAt: now,
    updatedAt: now,
    // Import mode pre-fills content before review — mark every step "ready" so
    // the user walks through reviewing + locking each, rather than generating.
    ...(intakeMode === 'import' ? { steps: Object.fromEntries(STEP_IDS.map((id) => [id, { status: 'ready' }])) } : {}),
  });
  await store().saveOne(created.id, created);
  return created;
}

export async function updateStorySession(id, patch = {}) {
  return store().queueRecordWrite(id, async () => {
    const cur = await store().loadOne(id);
    if (!cur || cur.deleted) throw makeErr(`Story Builder session not found: ${id}`, ERR_NOT_FOUND);
    const next = sanitizeSession({
      ...cur,
      ...('title' in patch ? { title: patch.title } : {}),
      ...('seedIdea' in patch ? { seedIdea: patch.seedIdea } : {}),
      ...('currentStep' in patch ? { currentStep: patch.currentStep } : {}),
      ...('llm' in patch ? { llm: { ...(cur.llm || {}), ...(patch.llm || {}) } } : {}),
      updatedAt: nowIso(),
    });
    if (!next) throw makeErr('Invalid session payload', ERR_VALIDATION);
    await store().saveOneNow(next.id, next);
    return next;
  });
}

export async function deleteStorySession(id) {
  return store().queueRecordWrite(id, async () => {
    const cur = await store().loadOne(id);
    if (!cur || cur.deleted) throw makeErr(`Story Builder session not found: ${id}`, ERR_NOT_FOUND);
    const now = nowIso();
    await store().saveOneNow(id, { ...cur, deleted: true, deletedAt: now, updatedAt: now });
    return { id };
  });
}

// ── Integrity (staleness) ─────────────────────────────────────────────────

// Project the whitelisted SEMANTIC upstream fields per step. Never include
// `updatedAt` or other churn — only fields whose change should invalidate a
// downstream lock.
function projectAesthetic(universe) {
  const inf = universe?.influences || {};
  return {
    logline: universe?.logline || '',
    premise: universe?.premise || '',
    styleNotes: universe?.styleNotes || '',
    influencesEmbrace: Array.isArray(inf.embrace) ? inf.embrace : [],
    influencesAvoid: Array.isArray(inf.avoid) ? inf.avoid : [],
  };
}
function projectArc(series) {
  const arc = series?.arc || {};
  return {
    logline: arc.logline || '',
    summary: arc.summary || '',
    protagonistArc: arc.protagonistArc || '',
    themes: Array.isArray(arc.themes) ? arc.themes : [],
    shape: arc.shape || null,
  };
}
function projectCast(universe) {
  return (Array.isArray(universe?.characters) ? universe.characters : [])
    .map((c) => ({ name: c?.name || '', descriptor: c?.descriptor ?? null }));
}

function buildUpstreamInputs(session, universe, series) {
  const aesthetic = projectAesthetic(universe);
  const arc = projectArc(series);
  const readerMap = series?.arc?.readerMap || null;
  const cast = projectCast(universe);
  // The idea step expands seedIdea into universe.starterPrompt + series
  // logline/premise. Those are non-deterministic LLM outputs, so seedIdea
  // alone is NOT a sufficient proxy for "idea-step content unchanged" — re-
  // running idea expand can produce a different starterPrompt with the same
  // seed, and downstream steps (aesthetic, plotArc) consume those outputs.
  // Including them in the downstream hashes flags those locked steps stale
  // when idea is regenerated.
  const ideaOutputs = {
    starterPrompt: universe?.starterPrompt || '',
    seriesLogline: series?.logline || '',
    seriesPremise: series?.premise || '',
  };
  return {
    idea: { intakeMode: session.intakeMode, seedIdea: session.seedIdea || '' },
    universeAesthetic: { seedIdea: session.seedIdea || '', ideaOutputs },
    plotArc: { aesthetic, seedIdea: session.seedIdea || '', ideaOutputs },
    readerMap: { arc },
    characters: { readerMap, arcSummary: arc.summary, aesthetic },
    issues: { arc, readerMap, cast },
    production: { arc, readerMap, cast },
  };
}

/**
 * Compute the current upstream hash for every step from the live universe +
 * series records. Pure-on-read — does not mutate the session.
 */
export async function computeCurrentHashes(session) {
  const universe = session.universeId ? await getUniverse(session.universeId).catch(() => null) : null;
  const series = session.seriesId ? await getSeries(session.seriesId).catch(() => null) : null;
  const inputs = buildUpstreamInputs(session, universe, series);
  const hashes = {};
  for (const id of STEP_IDS) hashes[id] = hashUpstream(id, inputs[id]);
  return { hashes, universe, series };
}

/**
 * Load a session augmented with the computed `staleSteps` array (the locked
 * steps whose upstream inputs have drifted since lock time). This is the shape
 * the route serves to the client.
 */
export async function getStorySessionView(id) {
  const session = await getStorySession(id);
  const { hashes, universe, series } = await computeCurrentHashes(session);
  const staleSteps = computeStaleSteps(session, hashes);
  return { session, staleSteps, universe, series };
}

// ── State machine: lock / unlock ──────────────────────────────────────────

// Apply (or release) the underlying record lock that backs a step, so the
// existing generate guards (locked-arc, locked-readerMap, locked-canon) take
// effect. Best-effort per step; the session lock is the source of truth for
// the wizard gate, the record lock is the enforcement at the generator.
async function applyUnderlyingLock(session, stepId, locked) {
  if (stepId === 'universeAesthetic' && session.universeId) {
    const universe = await getUniverse(session.universeId).catch(() => null);
    if (!universe) return;
    const nextLocked = { ...(universe.locked || {}) };
    for (const f of AESTHETIC_LOCK_FIELDS) {
      if (locked) nextLocked[f] = true;
      else delete nextLocked[f];
    }
    await updateUniverse(session.universeId, { locked: nextLocked });
  } else if (stepId === 'plotArc' && session.seriesId) {
    const series = await getSeries(session.seriesId).catch(() => null);
    if (!series) return;
    const nextLocked = { ...(series.locked || {}) };
    if (locked) nextLocked.arc = true;
    else delete nextLocked.arc;
    await updateSeries(session.seriesId, { locked: nextLocked });
  } else if (stepId === 'readerMap' && session.seriesId) {
    await setArcFieldLock(session.seriesId, 'readerMap', locked);
  }
  // NOTE: the 'characters' step deliberately has NO underlying record lock.
  // Universe canon is shared across series, and per-entry character locks are
  // user-managed (in the Universe Builder / via this step's per-entry Refine).
  // Blanket-toggling locked on every character would clobber those individual
  // locks and mutate a universe other series depend on. The session-level step
  // lock alone gates the wizard; the UI hides the per-character Refine when the
  // step is locked.
}

export async function lockStep(id, stepId) {
  if (!isValidStepId(stepId)) throw makeErr(`Unknown step: ${stepId}`, ERR_VALIDATION);
  const session = await getStorySession(id);
  const { hashes } = await computeCurrentHashes(session);
  await applyUnderlyingLock(session, stepId, true);
  return store().queueRecordWrite(id, async () => {
    const cur = await store().loadOne(id);
    if (!cur || cur.deleted) throw makeErr(`Story Builder session not found: ${id}`, ERR_NOT_FOUND);
    const steps = { ...cur.steps };
    steps[stepId] = {
      ...steps[stepId],
      status: 'locked',
      locked: true,
      lockedAt: nowIso(),
      upstreamHash: hashes[stepId],
    };
    const next = sanitizeSession({ ...cur, steps, updatedAt: nowIso() });
    await store().saveOneNow(next.id, next);
    return next;
  });
}

export async function unlockStep(id, stepId) {
  if (!isValidStepId(stepId)) throw makeErr(`Unknown step: ${stepId}`, ERR_VALIDATION);
  const session = await getStorySession(id);
  await applyUnderlyingLock(session, stepId, false);
  return store().queueRecordWrite(id, async () => {
    const cur = await store().loadOne(id);
    if (!cur || cur.deleted) throw makeErr(`Story Builder session not found: ${id}`, ERR_NOT_FOUND);
    const steps = { ...cur.steps };
    steps[stepId] = { status: 'ready', locked: false, lockedAt: null, upstreamHash: null };
    const next = sanitizeSession({ ...cur, steps, updatedAt: nowIso() });
    await store().saveOneNow(next.id, next);
    return next;
  });
}

/**
 * Set the wizard's current step.
 *
 * Advisory, not gated: a user may start from any point and work the steps out
 * of order (e.g. begin from a drafted comic script and backfill the idea / arc
 * afterward). The client surfaces "upstream not locked" / "stale" as warnings
 * (from the `staleSteps` array in the session view) rather than hard blocks.
 * The only enforcement that remains is at the generators themselves — a *locked*
 * underlying record (arc, readerMap, …) still refuses regeneration.
 */
export async function setCurrentStep(id, stepId) {
  if (!isValidStepId(stepId)) throw makeErr(`Unknown step: ${stepId}`, ERR_VALIDATION);
  return updateStorySession(id, { currentStep: stepId });
}

// ── Per-issue locks (issues step loop) ────────────────────────────────────

export async function setIssueLock(id, issueId, locked) {
  if (!isStr(issueId) || !issueId) throw makeErr('issueId is required', ERR_VALIDATION);
  return store().queueRecordWrite(id, async () => {
    const cur = await store().loadOne(id);
    if (!cur || cur.deleted) throw makeErr(`Story Builder session not found: ${id}`, ERR_NOT_FOUND);
    const steps = { ...cur.steps };
    const issueLocks = { ...(steps.issues?.issueLocks || {}) };
    if (locked) issueLocks[issueId] = { locked: true, lockedAt: nowIso(), upstreamHash: null };
    else delete issueLocks[issueId];
    steps.issues = { ...steps.issues, issueLocks };
    const next = sanitizeSession({ ...cur, steps, updatedAt: nowIso() });
    await store().saveOneNow(next.id, next);
    return next;
  });
}

// ── Seed issues from the arc (issues step) ─────────────────────────────────

/**
 * Generate the per-episode breakdown for the linked series' seasons and
 * persist one issue per episode — so the user doesn't have to leave the
 * builder for the Pipeline. Delegates to arcPlanner.generateSeasonEpisodes
 * (per season) + commitEpisodesToIssues, the same path the Pipeline's
 * season-episodes route uses.
 *
 * Provider/model resolution mirrors generateStep: an explicit override wins,
 * else the session's saved picker choice (session.llm).
 *
 * Batch semantics: generateSeasonEpisodes throws on a locked season or one
 * with no synopsis/logline. In a multi-season run one bad season must not
 * abort the rest, so each season is caught independently — the eligible
 * seasons still produce issues. A caught season reports `skipped: true` when
 * it was genuinely ineligible (ARC_ERR_VALIDATION) and `failed: true` for any
 * other (transient provider/LLM) error, so the client never frames an infra
 * failure as a config skip. Successful seasons carry `skipped: false,
 * failed: false`.
 *
 * `options.seasonId` scopes generation to a single season; omit to cover every
 * season on the arc.
 *
 * Deliberately does NOT run the Pipeline route's post-create continuity canon
 * extraction (extractCanonFromProse). In the builder, canon is owned by the
 * dedicated `characters` step where the user curates it against the universe;
 * episode synopses here are thin idea-stage seeds, so auto-extracting canon
 * from them would push low-signal entries the user then has to clean up. Issue
 * creation is the focused job of this action — the characters step handles
 * canon.
 */
export async function generateIssuesFromArc(id, options = {}) {
  const session = await getStorySession(id);
  if (!session.seriesId) throw makeErr('No series linked', ERR_VALIDATION);
  const series = await getSeries(session.seriesId);
  const seasons = Array.isArray(series?.seasons) ? series.seasons : [];
  if (seasons.length === 0) {
    throw makeErr('No seasons on the arc yet — generate the plot arc first', ERR_VALIDATION);
  }

  const targetSeasons = options.seasonId
    ? seasons.filter((s) => s.id === options.seasonId)
    : seasons;
  if (options.seasonId && targetSeasons.length === 0) {
    throw makeErr(`Season not found on series: ${options.seasonId}`, ERR_VALIDATION);
  }

  const reqProviderId = options.providerId || session.llm?.provider || undefined;
  const reqModel = options.model || session.llm?.model || undefined;

  const createdIssues = [];
  const seasonResults = [];
  for (const season of targetSeasons) {
    const label = season.title || `Volume ${season.number ?? '?'}`;
    const res = await generateSeasonEpisodes(session.seriesId, season.id, {
      providerOverride: reqProviderId,
      modelOverride: reqModel,
    }).catch((err) => ({ error: err }));
    if (res.error) {
      // generateSeasonEpisodes throws ARC_ERR_VALIDATION for genuinely
      // ineligible seasons (locked, or no synopsis/logline) — those are
      // `skipped` (expected config state). Any OTHER throw is a transient
      // failure (provider down, timeout, non-JSON) and is reported as
      // `failed` so the client never frames an infra error as "ineligible".
      // We still don't abort the batch — a blip on one season must not
      // discard issues already created for the others.
      const ineligible = res.error?.code === ARC_ERR_VALIDATION;
      const reason = res.error?.message || 'Failed to generate episodes';
      seasonResults.push({
        seasonId: season.id, title: label, created: 0,
        skipped: ineligible, failed: !ineligible, reason,
      });
      continue;
    }
    const issues = await commitEpisodesToIssues(session.seriesId, season.id, res.episodes, { preloadedSeries: series });
    createdIssues.push(...issues);
    seasonResults.push({ seasonId: season.id, title: label, created: issues.length, skipped: false, failed: false, runId: res.runId });
  }

  return { createdIssues, seasons: seasonResults };
}

// ── Backfill (generate upstream from downstream) ───────────────────────────

// ── Generate / refine delegation ──────────────────────────────────────────

// Each step's generate delegates to the existing service that owns its content,
// then persists into the universe/series record. Returns the LLM result so the
// route can surface runId / changes / rationale.
//
// `options.fromDownstream` flips a step from forward-generation to backfill:
// idea / plotArc synthesize themselves from the series' existing issue content
// instead of from their (possibly empty) conventional upstream.
export async function generateStep(id, stepId, options = {}) {
  const session = await getStorySession(id);
  // Provider/model resolution: an explicit per-call override wins, else fall
  // back to the session's saved picker choice (session.llm) so a single
  // selection at the top of the Story Builder drives every operation.
  const reqProviderId = options.providerId || session.llm?.provider || undefined;
  const reqModel = options.model || session.llm?.model || undefined;
  // Best-effort phase emitter for the SSE runner; a no-op on the synchronous
  // path (no onProgress passed) so this call stays byte-for-byte unchanged there.
  const emit = (label, phase) => options.onProgress?.({ label, phase });
  if (stepId === 'idea') {
    // Backfill: reverse-engineer the idea from existing issue content when the
    // user started downstream. Rendered only when present, so the forward path
    // (seed-only) is byte-for-byte unchanged.
    if (options.fromDownstream) emit('Reading existing issues…', 'collect');
    const sourceMaterial = options.fromDownstream ? await collectIssueSourceText(session.seriesId) : '';
    if (options.fromDownstream && !sourceMaterial) {
      throw makeErr(
        'No issue content to backfill the idea from — write a comic script, teleplay, or prose on at least one issue first',
        ERR_VALIDATION,
      );
    }
    emit('Expanding the idea…', 'generate');
    const { content, runId, providerId, model } = await runStagedLLM(
      'story-builder-idea-expand',
      { universeName: session.title, seedIdea: session.seedIdea || '', sourceMaterial },
      { providerOverride: reqProviderId, modelOverride: reqModel, returnsJson: true, source: 'story-builder-idea-expand' },
    );
    const expandedIdea = isStr(content?.expandedIdea) ? content.expandedIdea.trim() : '';
    const logline = isStr(content?.logline) ? content.logline.trim() : '';
    emit('Saving…', 'persist');
    // Seed the universe starter + series premise/logline from the expansion.
    // Honor downstream lock keys: locking the universeAesthetic step sets
    // universe.locked.{logline,...} via applyUnderlyingLock, but
    // updateUniverse doesn't enforce those locks on scalar writes — so a
    // re-run of the idea step would otherwise silently clobber a locked
    // logline. Skip any scalar field the user has explicitly locked.
    if (session.universeId && expandedIdea) {
      const universe = await getUniverse(session.universeId);
      const patch = { starterPrompt: expandedIdea };
      if (logline && !universe?.locked?.logline) patch.logline = logline;
      await updateUniverse(session.universeId, patch);
    }
    if (session.seriesId && (logline || expandedIdea)) {
      await updateSeries(session.seriesId, { ...(logline ? { logline } : {}), ...(expandedIdea ? { premise: expandedIdea } : {}) });
    }
    return { result: content, runId, providerId, model };
  }
  if (stepId === 'universeAesthetic') {
    if (!session.universeId) throw makeErr('No universe linked', ERR_VALIDATION);
    const universe = await getUniverse(session.universeId);
    emit('Expanding the aesthetic…', 'generate');
    const expanded = await expandWorldTemplate({
      starterPrompt: universe.starterPrompt || session.seedIdea || universe.name,
      influences: universe.influences,
      logline: universe.logline,
      premise: universe.premise,
      styleNotes: universe.styleNotes,
      locked: universe.locked,
      providerId: reqProviderId,
      model: reqModel,
    });
    emit('Saving…', 'persist');
    const updated = await updateUniverse(session.universeId, {
      logline: expanded.logline,
      premise: expanded.premise,
      styleNotes: expanded.styleNotes,
      ...(expanded.influences ? { influences: expanded.influences } : {}),
    });
    return { result: updated, providerId: expanded.providerId, model: expanded.model };
  }
  if (stepId === 'plotArc') {
    if (!session.seriesId) throw makeErr('No series linked', ERR_VALIDATION);
    let arcGenResult;
    if (options.fromDownstream) {
      // Backfill: extract the arc + seasons from the issues that already exist
      // (the user drafted scripts/prose first). Reuses the importer's
      // arc-extraction prompt via arcPlanner.generateArcFromSource.
      emit('Reading existing issues…', 'collect');
      const sourceText = await collectIssueSourceText(session.seriesId);
      if (!sourceText) {
        throw makeErr(
          'No issue content to backfill the arc from — write a comic script, teleplay, or prose on at least one issue first',
          ERR_VALIDATION,
        );
      }
      emit('Extracting the plot arc…', 'generate');
      arcGenResult = await generateArcFromSource(session.seriesId, {
        sourceText, providerOverride: reqProviderId, modelOverride: reqModel,
      });
    } else {
      emit('Planning the plot arc…', 'generate');
      arcGenResult = await generateArcOverview(session.seriesId, {
        providerOverride: reqProviderId, modelOverride: reqModel,
      });
    }
    const { arc, seasons, runId, providerId, model } = arcGenResult;
    // A null arc means the LLM returned nothing identifying — refuse rather
    // than wiping a previously-generated arc with `updateSeries({ arc: null })`.
    if (!arc) throw makeErr('LLM returned an empty arc — try regenerating', ERR_VALIDATION);
    // Route through commitSeasonsWithRemap so per-field arc locks, per-season
    // locks, and orphaned child issues are all honored — same path the Arc
    // Canvas's regenerate uses. A plain updateSeries({ arc, seasons }) would
    // bypass mergeArcWithLocks / mergeSeasonsWithLocks / buildSeasonRemap and
    // silently wipe locked seasons and orphan their issues.
    emit('Saving seasons…', 'persist');
    const series = await getSeries(session.seriesId);
    const { series: updated } = await commitSeasonsWithRemap(series, { arc, seasons });
    return { result: updated, runId, providerId, model };
  }
  if (stepId === 'readerMap') {
    if (!session.seriesId) throw makeErr('No series linked', ERR_VALIDATION);
    emit('Mapping reader emotion…', 'generate');
    const { readerMap, runId, providerId, model } = await generateReaderMap(session.seriesId, {
      providerOverride: reqProviderId, modelOverride: reqModel,
    });
    emit('Saving…', 'persist');
    const series = await getSeries(session.seriesId);
    const updated = await updateSeries(session.seriesId, { arc: { ...(series.arc || {}), readerMap } });
    return { result: updated, runId, providerId, model };
  }
  throw makeErr(`Generate is not supported for step "${stepId}"`, ERR_VALIDATION);
}

export async function refineStep(id, stepId, { feedback, entryId, providerId, model, onProgress } = {}) {
  const session = await getStorySession(id);
  // Same fallback as generateStep: explicit override → session picker choice.
  const reqProviderId = providerId || session.llm?.provider || undefined;
  const reqModel = model || session.llm?.model || undefined;
  const emit = (label, phase) => onProgress?.({ label, phase });
  if (stepId === 'universeAesthetic') {
    if (!session.universeId) throw makeErr('No universe linked', ERR_VALIDATION);
    const universe = await getUniverse(session.universeId);
    emit('Refining the aesthetic…', 'generate');
    const refined = await refineWorldPrompts({
      starterPrompt: universe.starterPrompt || universe.name,
      logline: universe.logline,
      premise: universe.premise,
      styleNotes: universe.styleNotes,
      influences: universe.influences,
      locked: universe.locked,
      feedback,
      providerId: reqProviderId,
      model: reqModel,
    });
    emit('Saving…', 'persist');
    const updated = await updateUniverse(session.universeId, {
      logline: refined.logline,
      premise: refined.premise,
      styleNotes: refined.styleNotes,
      ...(refined.influences ? { influences: refined.influences } : {}),
    });
    return { result: updated, changes: refined.changes || [], rationale: refined.rationale || '' };
  }
  if (stepId === 'plotArc') {
    if (!session.seriesId) throw makeErr('No series linked', ERR_VALIDATION);
    emit('Refining the plot arc…', 'generate');
    const { arc, changes, rationale, runId, providerId: usedProviderId, model: usedModel } = await refineArc(session.seriesId, feedback, { providerId: reqProviderId, model: reqModel });
    emit('Saving…', 'persist');
    // Persist arc-ONLY (never the season breakdown), so we deliberately do NOT
    // route through commitSeasonsWithRemap — passing a stale season snapshot as
    // the "proposed" set there could mis-remap/orphan a season edited during the
    // LLM call. Re-read the latest series, apply per-field arc locks via
    // mergeArcWithLocks (the same guard commitSeasonsWithRemap uses), and write
    // only `arc` — seasons are untouched.
    const latest = await getSeries(session.seriesId);
    // Re-check the whole-arc lock against the LATEST series, not just the
    // pre-LLM snapshot refineArc saw — commitSeasonsWithRemap does the same, and
    // dropping that re-check (this path bypasses it) would let a refine land if
    // the arc was locked while the LLM call was in flight.
    if (latest.locked?.arc === true) {
      throw makeErr('Arc is locked — unlock it on the Arc Canvas before refining', ARC_ERR_VALIDATION);
    }
    const mergedArc = mergeArcWithLocks(latest.arc, arc, latest.locked?.arcFields);
    const updated = await updateSeries(session.seriesId, { arc: mergedArc });
    return { result: updated, changes, rationale, runId, providerId: usedProviderId, model: usedModel };
  }
  if (stepId === 'readerMap') {
    if (!session.seriesId) throw makeErr('No series linked', ERR_VALIDATION);
    emit('Refining the reader map…', 'generate');
    const { readerMap, changes, rationale, runId, providerId: usedProviderId, model: usedModel } = await refineReaderMap(session.seriesId, feedback, { providerId: reqProviderId, model: reqModel });
    emit('Saving…', 'persist');
    const series = await getSeries(session.seriesId);
    const updated = await updateSeries(session.seriesId, { arc: { ...(series.arc || {}), readerMap } });
    return { result: updated, changes, rationale, runId, providerId: usedProviderId, model: usedModel };
  }
  if (stepId === 'characters') {
    if (!session.universeId) throw makeErr('No universe linked', ERR_VALIDATION);
    if (!isStr(entryId)) throw makeErr('entryId is required to refine a character', ERR_VALIDATION);
    emit('Refining the character…', 'generate');
    const out = await refineUniverseCharacter(session.universeId, entryId, { providerId: reqProviderId, model: reqModel });
    return { result: out.universe, changes: out.changes || [], rationale: out.rationale || '' };
  }
  throw makeErr(`Refine is not supported for step "${stepId}"`, ERR_VALIDATION);
}
