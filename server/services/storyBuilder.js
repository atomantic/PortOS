/**
 * Unified Story Builder — conductor service.
 *
 * The Story Builder is a thin *conductor* over the existing universe / series /
 * issue records. It owns ONE lightweight record (the "session") that tracks
 * per-step status + locks + integrity hashes plus two FKs (`universeId`,
 * `seriesId`). All real content lives in the universe and series records and is
 * mutated through their existing services — this service never duplicates it.
 *
 * Sessions are LOCAL-ONLY BY DEFAULT: they reference peer-syncable records by
 * FK, but the lock/integrity bookkeeping is a private workflow artifact. A
 * session opts into cross-machine resume by flipping `sync: true` (#730). The
 * wire/push integration itself (peer push schema, manifest kind, importer
 * apply) is a later slice; what ships here is the OPT-IN flag plus the
 * sync-safe staleness model that makes enabling it later non-corrupting.
 *
 * Sync-safe staleness (#730). The default (local-only) staleness model
 * live-diffs each locked step's frozen `upstreamHash` against the CURRENT hash
 * recomputed from the live universe/series records — so any out-of-band edit
 * (#731), including a peer's universe edit that arrived via universe sync, flags
 * the locked step stale. That is correct within one install but wrong for a
 * synced session: once the session travels to another machine, that machine's
 * live records legitimately differ, so a live recompute would false-positive
 * EVERY locked step stale. So a `sync: true` session instead keys staleness on a
 * content hash CARRIED IN THE SESSION (`syncedHashes`) — the upstream hashes the
 * session last reconciled with on whatever machine touched it. A peer's record
 * edit moves the live records but NOT `syncedHashes`, so it can't false-positive
 * a synced session; the user re-snapshots the baseline explicitly via reconcile.
 *
 * The tombstone/origin/ephemeral fields are carried only for on-disk shape
 * parity (and forward-compat with the eventual sync wire integration).
 *
 * Storage: one row per session in PostgreSQL (`story_builder_sessions`) as of
 * #1016 (legacy on-disk shape was data/story-builder/{id}/index.json). The
 * storyBuilderStore facade is a drop-in for the collectionStore surface this
 * service calls, so only the `store()` factory below changed.
 */

import { randomUUID } from 'crypto';
import { isStr, trimTo, pickPromptFields, BIBLE_KIND } from '../lib/storyBible.js';
import { sanitizeOrigin } from '../lib/sharingOrigin.js';
import { sanitizeSoftDeleteFields } from '../lib/syncWire.js';
import { runStagedLLM } from '../lib/stageRunner.js';
import {
  STEP_IDS, STEP_STATUSES, isValidStepId,
} from '../lib/storyBuilderSteps.js';
import { hashUpstream, computeStaleSteps, computeSyncDrift } from '../lib/storyBuilderIntegrity.js';
import { getStoryBuilderStore } from './storyBuilderStore/store.js';
import { linkIngredientsToSeries, resolveIngredientsByIds } from './catalogDB.js';
import { getActiveCatalogType, payloadSnippet } from '../lib/catalogTypes.js';
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

// Storage backend dispatcher (#1016): the facade is a drop-in for the
// collectionStore surface this service used to call directly, so every method
// below keeps calling `store().loadAll()`, `store().queueRecordWrite(...)`, etc.
// unchanged — only the backend (PostgreSQL vs the file escape hatch) moved.
const store = () => getStoryBuilderStore(sanitizeSession);
export const storyBuilderStore = () => store();

export const ERR_NOT_FOUND = 'STORY_BUILDER_NOT_FOUND';
export const ERR_VALIDATION = 'STORY_BUILDER_VALIDATION';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

const SESSION_ID_RE = /^stb-[A-Za-z0-9-]+$/;
export const TITLE_MAX = 200;
export const SEED_MAX = 4000;
export const INTAKE_MODES = Object.freeze(['seed', 'import']);

// Group → header label for the composed fallback seed. Prefer the ACTIVE
// registry's canonical label (getActiveCatalogType covers user-defined types
// too, so idea/scene/concept + custom types get proper plurals and match the
// client's prefill), naive-pluralizing an unknown type's id as a fallback.
// Mirrors `seedGroupHeading` in client StoryBuilder.jsx.
function seedGroupHeading(type) {
  const label = getActiveCatalogType(type)?.label;
  const base = label || (isStr(type) && type ? `${type.charAt(0).toUpperCase()}${type.slice(1)}` : 'Other');
  return base.endsWith('s') ? base : `${base}s`;
}

// Compose a fallback seed string from resolved catalog ingredients (#1761),
// used when the user supplies ingredients but no seedIdea so the minted
// universe/series shells aren't empty. Groups by type with a header line per
// group and one `- {name}: {summary}` bullet per ingredient (summary via
// payloadSnippet — the type's snippetFallbackKeys, ~120 chars; omitted, with
// the `: `, when empty). Capped at SEED_MAX with a trailing ellipsis on overflow.
function composeSeedFromIngredients(ingredients) {
  const byType = new Map();
  for (const ing of ingredients) {
    const list = byType.get(ing.type) || [];
    list.push(ing);
    byType.set(ing.type, list);
  }
  const lines = [];
  for (const [type, list] of byType) {
    lines.push(`${seedGroupHeading(type)}:`);
    for (const ing of list) {
      // payloadSnippet follows the type's snippetFallbackKeys (getActiveCatalogType
      // resolves user-defined types too), so a character's body text — under
      // `physicalDescription`, not `description` — is included.
      const summary = payloadSnippet(ing.payload, ing.type, 120, getActiveCatalogType);
      lines.push(summary ? `- ${ing.name}: ${summary}` : `- ${ing.name}`);
    }
  }
  const composed = lines.join('\n');
  if (composed.length <= SEED_MAX) return composed;
  return `${composed.slice(0, SEED_MAX - 1)}…`;
}

// Resolve the selected catalog ingredient ids to live ingredient records
// (de-duped, pick-order-preserving, soft-deleted excluded). Delegates to the
// shared catalogDB resolver (#1808) so Story Builder and Creative Director share
// one implementation instead of each carrying its own copy.
const resolveCatalogIngredients = (ids) => resolveIngredientsByIds(ids);

// Steps the importer actually pre-fills, so they open "ready" for review on an
// import-mode session. `idea` (universe + series exist), `plotArc` (arc +
// seasons), `characters` (extracted canon), and `issues` (the issue split) are
// populated by `analyzeImport` → `commitImport`. Steps NOT listed here —
// `universeAesthetic` (logline/premise/styleNotes/influences are never written
// on import), `readerMap` (no reader-map extraction pass), and `production`
// (the downstream render step) — fall through to the default "pending" status
// so they don't show an empty step under a misleading "Ready" badge (#728).
export const IMPORT_READY_STEPS = Object.freeze(['idea', 'plotArc', 'characters', 'issues']);

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

// The content-hash baseline a `sync: true` session carries (#730): one
// sha256 hex digest per step id, the upstream hash the session last reconciled
// with. Drops unknown ids and non-hex values so a hand-edited / peer-sourced
// record can't smuggle a bogus baseline that would mis-flag staleness.
const HASH_RE = /^[0-9a-f]{64}$/;
function sanitizeSyncedHashes(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const id of STEP_IDS) {
    const h = raw[id];
    if (isStr(h) && HASH_RE.test(h)) out[id] = h;
  }
  return out;
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
    // Cross-machine resume is OPT-IN (#730): local-only is the default. When
    // off, `syncedHashes` is irrelevant (staleness live-diffs against records)
    // so we drop it to keep the record minimal.
    sync: raw.sync === true,
    ...(raw.sync === true ? { syncedHashes: sanitizeSyncedHashes(raw.syncedHashes) } : {}),
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
  // Seed used to mint the shells: the user's seedIdea, or — when they picked
  // Catalog ingredients but typed no seed — a fallback composed from those
  // ingredients (#1761). In the normal (no-ingredients) case this equals
  // seedIdea, so the create path is byte-for-byte unchanged.
  let effectiveSeed = seedIdea;
  // Resolved catalog ingredients (#1761), hoisted to function scope so the
  // series links can be created AFTER the session is saved (best-effort —
  // see below). Stays empty in import mode and the no-ingredients case.
  let remixIngredients = [];

  if (intakeMode === 'seed') {
    // Resolve any selected catalog ingredients up front: they feed both the
    // fallback seed (so the minted shells aren't empty) and the series links
    // created once the session is saved. Missing/deleted ids are skipped.
    remixIngredients = await resolveCatalogIngredients(input.catalogIngredientIds);
    if (!effectiveSeed && remixIngredients.length > 0) {
      effectiveSeed = composeSeedFromIngredients(remixIngredients);
    }

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
      const universe = await createUniverse({ name: title, starterPrompt: effectiveSeed || '' });
      universeId = universe.id;
      mintedUniverseId = universe.id;
    }
    if (!seriesId) {
      const series = await createSeries({ name: title, universeId, premise: effectiveSeed || '' }).catch(async (err) => {
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
    // Import mode pre-fills SOME content before review — mark only the steps the
    // importer actually populates "ready" so the user reviews + locks those. The
    // importer (`analyzeImport` → `commitImport`) fills: the idea (universe +
    // series exist), the plot arc + seasons, the cast (canon characters), and the
    // issue split. It does NOT extract a universe aesthetic
    // (logline/premise/styleNotes/influences are never written) nor a reader map,
    // and production is the downstream render step. Those start "pending" so the
    // user generates them — leaving them "ready" showed an empty step under a
    // misleading "Ready" badge (issue #728). The default-pending fall-through in
    // sanitizeSteps covers every step omitted here.
    ...(intakeMode === 'import'
      ? { steps: Object.fromEntries(IMPORT_READY_STEPS.map((id) => [id, { status: 'ready' }])) }
      : {}),
  });
  await store().saveOne(created.id, created);

  // Link the selected catalog ingredients to the new series via
  // catalog_ingredient_refs — the convergence contract's single data model.
  // Deliberately AFTER the session is saved and best-effort: the story is the
  // primary artifact, so a transient ref-insert failure must not reject the
  // create and orphan the just-minted universe/series (the link is recoverable
  // by re-picking ingredients). Role maps from type; unknown types → 'mentioned'.
  if (remixIngredients.length > 0) {
    await linkIngredientsToSeries(seriesId, remixIngredients)
      .then((linked) => console.log(`🔗 StoryBuilder: linked ${linked.length} catalog ingredient(s) to series ${seriesId}`))
      .catch((err) => console.error(`⚠️ StoryBuilder: failed to link catalog ingredients to series ${seriesId}: ${err.message}`));
  }
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

// ── Cross-machine sync (#730) ─────────────────────────────────────────────
//
// Sessions are LOCAL-ONLY by default and excluded from peer sync entirely.
// Only a session with `sync: true` participates — it rides the dedicated
// `storyBuilder` snapshot category (dataSync.js), union-merged by id with LWW
// on `updatedAt`. Sessions carry no assets and no child records, so they don't
// need the per-record push pipeline / asset-manifest / reverse-subscribe
// machinery the universe/series kinds use; the 60s snapshot loop's LWW merge
// is the whole transport.
//
// The carried `syncedHashes` baseline is exactly what makes this safe: a peer's
// universe/series edit moves the live records but NOT `syncedHashes`, so a
// session that traveled across machines doesn't false-positive-stale (the whole
// point of the #861 staleness model). The FKs (`universeId`, `seriesId`)
// reference records that sync through their own categories; if the peer hasn't
// received them yet, the session view degrades gracefully (computeCurrentHashes
// reads them best-effort and a missing record just yields empty hashes).

/**
 * Wire-safe projection of a single session for the peer snapshot. Re-runs the
 * sanitizer (canonical key order + field whitelist) and strips the local-only
 * `ephemeral` marker so a synced session can't smuggle a peer-local flag and so
 * the byte-stable checksum matches across machines. Returns null for a session
 * that isn't sync-enabled — local-only sessions must NEVER cross the wire.
 *
 * Tombstones (deleted=true) still cross: a session that was synced, then
 * deleted, needs its tombstone to converge on peers that hold the live copy.
 */
export function sanitizeSessionForWire(raw) {
  const s = sanitizeSession(raw);
  if (!s) return null;
  if (s.sync !== true) return null;
  // `ephemeral` is a peer-local "don't sync" marker analogous to the
  // universe/series flag (and #727's `importDraft`). A live ephemeral session
  // is local-only and never crosses the wire; a tombstone still does so the
  // delete converges on peers that hold the live copy.
  if (s.ephemeral === true && s.deleted !== true) return null;
  // Strip the local-only marker so the wire form is byte-stable against peers
  // that predate the flag (sanitizeSession only adds it when raw.ephemeral).
  const { ephemeral: _ephemeral, ...rest } = s; // eslint-disable-line no-unused-vars
  return rest;
}

/**
 * Every sync-enabled session in wire form, sorted by id for a deterministic
 * (checksum-stable) snapshot. Includes tombstones so deletes propagate.
 */
export async function listSyncableSessionsForWire() {
  const sessions = await store().loadAll();
  return sessions
    .map(sanitizeSessionForWire)
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Merge a peer's sync-enabled sessions into local state. Union by id, LWW on
 * `updatedAt`. Mirrors the bundled-record merge contract:
 *   - sanitize-first: every remote row goes through `sanitizeSession` before it
 *     can touch disk (drops bogus baselines, malformed steps, missing title).
 *   - first-wins dedup: a duplicate id within the same batch keeps the first.
 *   - throw-on-unreadable: a per-record load failure aborts (the store's
 *     queueRecordWrite rejects), surfacing rather than silently dropping.
 *   - local-only guard: a remote session that isn't sync-enabled is refused
 *     (the sender only ships sync:true, but a malformed/hostile payload can't
 *     plant a local-only session as synced).
 *   - sync-flag preservation: a remote payload can't flip a LOCAL session's
 *     `sync` off (or on) — sync mode is a per-machine gesture. We only ever
 *     create/update sessions the remote marked sync:true; a local-only session
 *     of the same id is left untouched (its `sync:false` keeps it out of the
 *     wire on its own machine).
 */
export async function mergeStorySessionsFromSync(remoteSessions) {
  if (!Array.isArray(remoteSessions)) return { applied: false, count: 0 };
  // First-wins dedup within the batch (mirrors the monolithic-reader contract).
  const byId = new Map();
  for (const raw of remoteSessions) {
    const s = sanitizeSessionForWire(raw);
    if (!s || byId.has(s.id)) continue;
    byId.set(s.id, s);
  }
  let changed = 0;
  for (const remote of byId.values()) {
    const applied = await store().queueRecordWrite(remote.id, async () => {
      const local = await store().loadOne(remote.id);
      if (!local) {
        // No local counterpart — adopt the remote session verbatim. It's
        // already sync:true (sanitizeSessionForWire enforced it), so it stays
        // syncable on this machine too.
        await store().saveOneNow(remote.id, remote);
        return true;
      }
      // Don't resurrect / re-sync a session the LOCAL user opted out of. If the
      // local copy is local-only (sync:false), the user explicitly turned sync
      // off here — honor that and leave it alone rather than letting a stale
      // peer push flip it back on.
      if (local.sync !== true) return false;
      const localTs = local.updatedAt || '';
      const remoteTs = remote.updatedAt || '';
      if (remoteTs <= localTs) return false; // local wins (or tie — no churn)
      await store().saveOneNow(remote.id, remote);
      return true;
    });
    if (applied) changed += 1;
  }
  if (changed === 0) return { applied: false, count: 0 };
  console.log(`🔄 StoryBuilder sync: merged ${changed} session(s)`);
  return { applied: true, count: changed };
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
// Project the SEMANTIC content of each canon character — the same prompt-field
// whitelist the bible extractor / evaluator use (`physicalDescription`,
// `personality`, `role`, etc.), which excludes ids/timestamps/source churn by
// construction. A bare `{ name, descriptor }` would only change on add / remove
// / rename — canon characters carry no `descriptor` field, so editing a locked
// character's body fields out-of-band (the #731 case) would never flag stale.
function projectCast(universe) {
  return (Array.isArray(universe?.characters) ? universe.characters : [])
    .map((c) => pickPromptFields(BIBLE_KIND.CHARACTER, c));
}
// The plotArc step generates AND persists the season breakdown, so a locked
// plotArc must fingerprint the seasons' editorial content alongside the arc
// core — editing a season title/logline/synopsis/episode-count out-of-band
// otherwise leaves the lock un-flagged. Excludes render slots (cover/backCover)
// and operational churn (id/status/timestamps) — only the editorial fields the
// step produces and the user reviews.
function projectSeasons(series) {
  return (Array.isArray(series?.seasons) ? series.seasons : []).map((s) => ({
    number: s?.number ?? 0,
    title: s?.title || '',
    logline: s?.logline || '',
    synopsis: s?.synopsis || '',
    episodeCountTarget: s?.episodeCountTarget ?? 0,
    themes: Array.isArray(s?.themes) ? s.themes : [],
    endingHook: s?.endingHook || '',
  }));
}

function buildUpstreamInputs(session, universe, series) {
  const aesthetic = projectAesthetic(universe);
  const arc = projectArc(series);
  const seasons = projectSeasons(series);
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
  // Each step's hash folds in its OWN outputs (`ownOutputs`) alongside its
  // upstream inputs. The session lock only gates the wizard UI — the underlying
  // universe/series records stay editable in Universe Builder, Arc Planner, etc.
  // Fingerprinting a step's own output means an out-of-band edit to that content
  // (e.g. changing universe.logline directly while the aesthetic step is locked)
  // flags the locked step stale, not just edits to an earlier step's inputs
  // (#731). The `issues`/`production` steps carry no `ownOutputs` — their output
  // lives in large child-record collections already covered by their upstream
  // inputs, and hashing every child issue/page would be needless churn.
  return {
    idea: { intakeMode: session.intakeMode, seedIdea: session.seedIdea || '', ownOutputs: ideaOutputs },
    universeAesthetic: { seedIdea: session.seedIdea || '', ideaOutputs, ownOutputs: aesthetic },
    plotArc: { aesthetic, seedIdea: session.seedIdea || '', ideaOutputs, ownOutputs: { arc, seasons } },
    readerMap: { arc, ownOutputs: readerMap },
    characters: { readerMap, arcSummary: arc.summary, aesthetic, ownOutputs: cast },
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
 *
 * Staleness baseline depends on the sync mode (#730):
 *  - local-only (default): compare each locked step's frozen `upstreamHash`
 *    against the LIVE recompute, so any out-of-band record edit flags stale
 *    (#731). Correct within one install.
 *  - sync (`session.sync === true`): compare against the session-carried
 *    `syncedHashes` baseline instead of live records. The baseline travels with
 *    the session, so a peer's universe edit that hasn't been reconciled can't
 *    false-positive-stale a session that synced across machines. The user
 *    re-snapshots the baseline to live via `reconcileStorySession`.
 */
export async function getStorySessionView(id) {
  const session = await getStorySession(id);
  const { hashes, universe, series } = await computeCurrentHashes(session);
  const baseline = session.sync === true ? (session.syncedHashes || {}) : hashes;
  const staleSteps = computeStaleSteps(session, baseline);
  // For a synced session, also report whether THIS machine's live records have
  // drifted from the carried baseline — the "reconcile would adopt new state"
  // signal the UI shows next to the reconcile action (#730). Always false for
  // local-only sessions (their staleness already live-diffs).
  const syncDrift = session.sync === true
    ? computeSyncDrift(session, hashes, session.syncedHashes || {})
    : false;
  return { session, staleSteps, syncDrift, universe, series };
}

// Persist sync mode + (when enabled) a fresh live-hash baseline. Both
// reconcile and sync-enable do exactly this — snapshot the current live hashes
// as the carried staleness baseline; disabling drops the baseline entirely.
// `hashes` is computed by the caller (outside the write queue) so disabling
// skips the universe/series read it doesn't need.
async function writeSyncState(id, enabled, hashes) {
  return store().queueRecordWrite(id, async () => {
    const cur = await store().loadOne(id);
    if (!cur || cur.deleted) throw makeErr(`Story Builder session not found: ${id}`, ERR_NOT_FOUND);
    const next = sanitizeSession({
      ...cur,
      sync: enabled === true,
      ...(enabled === true ? { syncedHashes: hashes } : {}),
      updatedAt: nowIso(),
    });
    await store().saveOneNow(next.id, next);
    return next;
  });
}

/**
 * Re-snapshot a sync-enabled session's `syncedHashes` baseline to the CURRENT
 * live records. This is the explicit "adopt this machine's universe/series
 * state as the new staleness baseline" gesture — the only thing that moves the
 * carried baseline across steps on a synced session. Rejects a local-only
 * session: reconcile is a re-baseline gesture, NOT a sync-enable one (use
 * `setStorySessionSync` to turn sync on), so calling it on a session with
 * sync off is a no-op-with-surprising-side-effect we'd rather surface loudly.
 */
export async function reconcileStorySession(id) {
  const session = await getStorySession(id);
  if (session.sync !== true) {
    throw makeErr('Cross-machine resume is off for this session — enable it before reconciling', ERR_VALIDATION);
  }
  const { hashes } = await computeCurrentHashes(session);
  return writeSyncState(id, true, hashes);
}

/**
 * Toggle cross-machine resume on/off for a session (#730). Turning it ON
 * snapshots the current live hashes as the staleness baseline (so the user
 * doesn't start out "stale against nothing"); turning it OFF drops the baseline
 * and reverts to live-diff staleness.
 */
export async function setStorySessionSync(id, enabled) {
  const on = enabled === true;
  const session = await getStorySession(id);
  const { hashes } = on ? await computeCurrentHashes(session) : { hashes: {} };
  return writeSyncState(id, on, hashes);
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
    // A sync-enabled session keys staleness off its carried baseline, not live
    // records — so locking must also move the baseline to live for THIS step
    // (#730). Otherwise the just-locked step would compare its fresh
    // `upstreamHash` against a stale `syncedHashes` entry and report itself
    // stale on the next read. Re-baseline ONLY `stepId`: merging the whole live
    // `hashes` map would move every OTHER locked step's baseline to the current
    // (possibly peer-edited) records, re-introducing the exact false-positive
    // #730 exists to prevent. Cross-step re-baselining is the reconcile gesture.
    const next = sanitizeSession({
      ...cur,
      steps,
      ...(cur.sync === true
        ? { syncedHashes: { ...(cur.syncedHashes || {}), [stepId]: hashes[stepId] } }
        : {}),
      updatedAt: nowIso(),
    });
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
