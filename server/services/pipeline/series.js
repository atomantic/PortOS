/**
 * Pipeline — Series Service
 *
 * A Series is the long-lived parent record for a narrative arc (comic series,
 * TV show, or both). It carries premise + arc + style notes and links to a
 * Universe (`universeId`) where canon — characters, places, objects — lives;
 * those flow into every Issue's stage prompts so issues stay visually and
 * tonally consistent.
 *
 * Persisted to data/pipeline-series/{id}/index.json. Issues live in their own
 * collection (server/services/pipeline/issues.js) and reference a series by id.
 */

import { randomUUID } from 'crypto';
import { getSeriesStore } from './seriesStore/store.js';
import { isStr, trimTo } from '../../lib/storyBible.js';
import { sanitizeArc, sanitizeSeasonList } from '../../lib/storyArc.js';
import { sanitizeCharacterArcList } from '../../lib/seriesCharacterArc.js';
import { sanitizeStyleGuide } from '../../lib/styleGuide.js';
import { sanitizeSeverityWeights, sanitizeBlockingSeverities } from '../../lib/editorial/severityConfig.js';
import { sanitizeOrigin } from '../../lib/sharingOrigin.js';
import { sanitizeSoftDeleteFields } from '../../lib/syncWire.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord, flushBaseHashes,
  deleteSyncBaseHash,
} from '../../lib/conflictJournal.js';
import {
  emitRecordUpdated, emitRecordDeleted,
  autoSubscribeRecordToAllPeers, unsubscribeAllForRecord,
} from '../sharing/recordEvents.js';
import { renameCollectionForSeries, unlinkCollectionsForSeries } from '../mediaCollections.js';

// Storage backend dispatcher (#1015). Series records moved from per-record
// `data/pipeline-series/{id}/index.json` (collectionStore) to one-row-per-series
// in PostgreSQL (`pipeline_series`); the facade is a drop-in for the
// collectionStore surface this service calls, so only this factory changed. The
// `manuscript-review.json` sibling doc stays file-primary — the facade's
// `recordDir(id)` still resolves to the on-disk path manuscriptReview.js reads.
const store = () => getSeriesStore(sanitizeSeries);

export const seriesStore = () => store();

export const ERR_NOT_FOUND = 'PIPELINE_SERIES_NOT_FOUND';
export const ERR_VALIDATION = 'PIPELINE_SERIES_VALIDATION';
export const ERR_DUPLICATE = 'PIPELINE_SERIES_DUPLICATE';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

const SERIES_ID_RE = /^ser-[A-Za-z0-9-]+$/;

export const NAME_MAX = 200;
export const LOGLINE_MAX = 500;
export const PREMISE_MAX = 8000;
export const STYLE_NOTES_MAX = 4000;
// Author-supplied real-world fact reference (#1588) — the ground-truth facts the
// opt-in `research.fact-accuracy` editorial check reconciles the prose against
// (e.g. "Paris is the capital of France"; physiological limits). Generous cap so
// a grounded historical/SFF series can paste a sizable fact sheet.
export const FACT_REFERENCE_MAX = 8000;
export const STYLE_PROMPT_OVERRIDE_MAX = 1000;
// How `stylePromptOverride` composes with the universe's style influences:
//   'prepend'  — override leads, universe trails (the historical default
//                — slight deviation, universe still visible)
//   'append'   — universe leads, override trails (universe-dominant)
//   'override' — universe style is dropped entirely (full spinoff look)
// Default 'prepend' so existing series migrate forward without a writer
// pass and the field can be absent in JSON.
export const STYLE_PROMPT_OVERRIDE_MODES = Object.freeze(['prepend', 'append', 'override']);
export const STYLE_PROMPT_OVERRIDE_MODE_DEFAULT = 'prepend';
// Title/logo design concept — prose description injected into cover + TV
// title-screen prompts as the "logo design" cue. Generated from the universe's
// style notes on series creation; editable in the bible.
export const TITLE_LOGO_MAX = 2000;
// Derived cover thumbnail — the filename of a rendered volume/issue cover,
// stamped by seriesCoverImage.refreshSeriesCoverImage so the pipeline series
// list can show a thumbnail (like the universe reference image) without
// scanning every issue at read time. Server-set/derived only — never accepted
// from a route body. Sized to RENDER_FILENAME_MAX (renderSlot.js).
export const COVER_IMAGE_MAX = 500;
export const AUTHOR_MAX = 120;
// FK to an Author persona (auth-<uuid>). The `author` string above stays as a
// denormalized byline so a federated series renders the cover correctly even
// when the peer lacks the (local-only) author record. Empty/cleared → null.
export const AUTHOR_ID_MAX = 64;
export const UNIVERSE_ID_MAX = 64;
export const WRITERS_ROOM_WORK_ID_MAX = 64;
export const TARGET_FORMATS = Object.freeze(['comic', 'tv', 'comic+tv']);
export const ISSUE_COUNT_TARGET_MAX = 999;

// The manuscript format the series is authored/finalized in first — the source
// of truth the other two formats are generated from. Stored as the stage id so
// it maps straight onto the issue stages. `null` = not chosen yet; the
// manuscript editor falls back to auto-detecting the dominant drafted stage.
// Mirrors MANUSCRIPT_STAGES in arcPlanner.js (kept local to avoid an import
// cycle — series.js is imported by arcPlanner.js).
export const MANUSCRIPT_TYPES = Object.freeze(['comicScript', 'teleplay', 'prose']);

export const LOCKABLE_STAGES = Object.freeze(['arc']);

// Per-field arc lock targets. Each field can be individually frozen so
// `resolveVerifyIssues` / `commitSeasonsWithRemap` rewrite unlocked fields
// while preserving locked ones verbatim. Sibling to the binary `locked.arc`
// (which freezes everything); the two stack — `locked.arc: true` always wins.
export const ARC_LOCKABLE_FIELDS = Object.freeze([
  'logline', 'summary', 'protagonistArc', 'themes', 'shape', 'readerMap', 'tickingClock', 'foreshadowing',
]);

// Series Autopilot run marker (full autonomous mode). A thin, persisted
// breadcrumb of the in-memory orchestrator run (server/services/pipeline/
// seriesAutopilot.js) — NOT a step cursor. Resume is derived from the
// canonical series/issue state by the pure resolver, so all this needs to do
// is survive a restart for the "resume available / paused" UI and the
// boot-recovery demotion (running → paused). Persisted only when set so a
// series that never uses autopilot keeps its on-disk + wire shape stable
// (mirrors the `ephemeral` / `importDraft` conditional-spread convention).
export const AUTOPILOT_STATUSES = Object.freeze(['idle', 'running', 'paused', 'done', 'error']);
export const AUTOPILOT_STEP_MAX = 80;
export const AUTOPILOT_ERROR_MAX = 1000;
const AUTOPILOT_FINDING_SEVERITIES = ['high', 'medium', 'low'];
// Why a bounded-retry gate paused the run. Convergence gates (#1571):
// `maxRounds` (the verify→resolve loop ran out of rounds) vs `divergence` (it
// stopped converging early — the blocking count failed to drop). Child runners
// (#1574): `childFailed` (a delegated beats/text run produced no output after
// its retry budget). Lets the UI classify the pause without string-matching the
// reason text. Any other pause (budget, error, a capability gap) leaves this null.
// Editorial checks (#1613): `checkFindings` (the editorial-checks pass surfaced ≥
// the armed high-finding threshold, so the run paused for human review).
export const AUTOPILOT_PAUSE_KINDS = Object.freeze(['maxRounds', 'divergence', 'childFailed', 'checkFindings']);

export const sanitizeAutopilot = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const status = AUTOPILOT_STATUSES.includes(raw.status) ? raw.status : 'idle';
  const residualFindings = Array.isArray(raw.residualFindings)
    ? raw.residualFindings
      .map((f) => {
        if (!f || typeof f !== 'object') return null;
        const problem = trimTo(f.problem, 2000);
        if (!problem) return null;
        return {
          ...(AUTOPILOT_FINDING_SEVERITIES.includes(f.severity) ? { severity: f.severity } : {}),
          location: trimTo(f.location, 200),
          problem,
        };
      })
      .filter(Boolean)
      .slice(0, 50)
    : [];
  return {
    status,
    runId: trimTo(raw.runId, 64) || null,
    currentStep: trimTo(raw.currentStep, AUTOPILOT_STEP_MAX) || null,
    residualFindings,
    lastError: trimTo(raw.lastError, AUTOPILOT_ERROR_MAX) || null,
    // No `pipelineSeries` schema-gate bump for this (or any) autopilot field: the
    // marker is transient, regenerated-every-run status, NOT durable creative
    // content. Unlike readerMap/styleGuide/characterArcs (gated because an LWW
    // strip is real data loss), a stale peer that drops pauseKind just briefly
    // shows a generic "paused" banner until the next run re-stamps it.
    pauseKind: AUTOPILOT_PAUSE_KINDS.includes(raw.pauseKind) ? raw.pauseKind : null,
    // #1572 — a `done` run that filed blocking script-craft gaps (the advisory
    // craft gate) carries the count here so the marker can qualify "complete"
    // instead of reporting clean while downstream rendering is still blocked.
    // Same transient-marker rationale as pauseKind: no schema-gate bump.
    craftGapIssues: toCount(raw.craftGapIssues),
    craftGapFindings: toCount(raw.craftGapFindings),
    // #1573 — count of editorial checks that errored during the run's checks
    // pass. A `done` run with errored>0 didn't actually evaluate those checks, so
    // the UI flags it instead of reporting clean. Same transient-marker rationale
    // as craftGap* / pauseKind: no schema-gate bump.
    editorialCheckErrors: toCount(raw.editorialCheckErrors),
    // #1579 — the per-check / per-issue breakdown that drove an editorial-health
    // pause, so the UI / resume banner can render *why* without re-hitting the
    // health API. Null on any non-health pause. Same transient-marker rationale
    // as pauseKind / craftGap*: no schema-gate bump.
    healthBreakdown: sanitizeHealthBreakdown(raw.healthBreakdown),
    updatedAt: isStr(raw.updatedAt) ? raw.updatedAt : null,
  };
};

// Bound the wire shape of a `summarizeEditorialBlockers` breakdown stamped onto
// a paused marker (#1579). Null unless it carries at least a numeric score —
// drops a hand-edited/older-peer blob that lacks the expected shape.
const HEALTH_BREAKDOWN_MAX_ROWS = 10;
const HEALTH_CHECK_ID_MAX = 120;
const sanitizeHealthBreakdown = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const topChecks = (Array.isArray(raw.topChecks) ? raw.topChecks : [])
    .map((c) => (c && typeof c === 'object' && isStr(c.checkId) && Number.isFinite(c.count)
      ? { checkId: trimTo(c.checkId, HEALTH_CHECK_ID_MAX), count: toCount(c.count) }
      : null))
    .filter(Boolean)
    .slice(0, HEALTH_BREAKDOWN_MAX_ROWS);
  const topIssues = (Array.isArray(raw.topIssues) ? raw.topIssues : [])
    .map((i) => (i && typeof i === 'object' && Number.isFinite(i.open)
      ? { issueNumber: Number.isInteger(i.issueNumber) ? i.issueNumber : null, open: toCount(i.open) }
      : null))
    .filter(Boolean)
    .slice(0, HEALTH_BREAKDOWN_MAX_ROWS);
  return { score: toCount(raw.score), open: toCount(raw.open), topChecks, topIssues };
};

// Coerce a marker counter to a non-negative integer, defaulting to 0 (so an
// older marker that predates the field reads as "no gaps", not undefined).
const toCount = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

// Per-series editorial-check config overrides (#1591). Shape:
//   { [checkId]: { [configKey]: number|string|boolean } }
// Each entry overrides the GLOBAL per-check config (settings.pipelineEditorialChecks)
// for THIS series only — the runner overlays it via `applySeriesCheckConfig`, then
// re-validates the merged blob through the check's own Zod `configSchema`, so a
// malformed/out-of-range value is dropped at run time and can't corrupt a pass.
// This sanitizer therefore only bounds the WIRE shape: a plain object-of-objects
// with primitive leaves, size-capped against a hand-edited/older-peer file. Always
// present (empty `{}` when a series tunes nothing) — mirroring factReference/
// styleGuide — so an explicit clear (`{}`) propagates between v8 peers via LWW
// while a behind-sender that OMITS the key is preserved by
// `preserveAbsentAdditiveFields` (see ADDITIVE_SERIES_FIELDS). The v8
// `pipelineSeries` gate stops a ≤v7 peer from strip-then-LWW-ing the field.
const ECC_MAX_CHECKS = 200;
const ECC_MAX_KEYS_PER_CHECK = 40;
const ECC_CHECK_ID_MAX = 120;
const ECC_STRING_MAX = 1000;

const sanitizeCheckConfigOverride = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= ECC_MAX_KEYS_PER_CHECK) break;
    if (typeof key !== 'string' || !key) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string') out[key] = value.slice(0, ECC_STRING_MAX);
    // null/object/array leaves are dropped — config fields are primitives.
  }
  return Object.keys(out).length ? out : null;
};

const sanitizeEditorialCheckConfig = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [checkId, override] of Object.entries(raw)) {
    if (Object.keys(out).length >= ECC_MAX_CHECKS) break;
    if (typeof checkId !== 'string' || !checkId || checkId.length > ECC_CHECK_ID_MAX) continue;
    const clean = sanitizeCheckConfigOverride(override);
    if (clean) out[checkId] = clean;
  }
  return out;
};

const sanitizeSeriesLocked = (raw = {}) => {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const key of LOCKABLE_STAGES) {
    if (raw[key] === true) out[key] = true;
  }
  if (raw.arcFields && typeof raw.arcFields === 'object') {
    const arcFields = {};
    for (const k of ARC_LOCKABLE_FIELDS) {
      if (raw.arcFields[k] === true) arcFields[k] = true;
    }
    if (Object.keys(arcFields).length > 0) out.arcFields = arcFields;
  }
  return out;
};

const sanitizeSeries = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  if (!isStr(raw.id) || !raw.id) return null;
  const name = trimTo(raw.name, NAME_MAX);
  if (!name) return null;
  const targetFormat = TARGET_FORMATS.includes(raw.targetFormat) ? raw.targetFormat : 'comic+tv';
  const issueCountTarget = Number.isFinite(raw.issueCountTarget)
    ? Math.max(0, Math.min(ISSUE_COUNT_TARGET_MAX, Math.floor(raw.issueCountTarget)))
    : 0;
  const llm = raw.llm && typeof raw.llm === 'object'
    ? {
      provider: trimTo(raw.llm.provider, 80) || null,
      model: trimTo(raw.llm.model, 200) || null,
    }
    : { provider: null, model: null };
  const createdAt = isStr(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : createdAt;
  const autopilot = sanitizeAutopilot(raw.autopilot);
  const editorialCheckConfig = sanitizeEditorialCheckConfig(raw.editorialCheckConfig);
  // Per-series autopilot severity config (#1616). Both default to `{}` (tunes
  // nothing → frozen defaults apply via mergeSeverityWeights/resolveBlockingSet),
  // mirroring editorialCheckConfig — so a clear propagates between v9 peers and a
  // behind-sender's omission is preserved (see ADDITIVE_SERIES_FIELDS).
  const severityWeights = sanitizeSeverityWeights(raw.severityWeights);
  const blockingSeverities = sanitizeBlockingSeverities(raw.blockingSeverities);
  return {
    id: raw.id,
    name,
    logline: trimTo(raw.logline, LOGLINE_MAX),
    premise: trimTo(raw.premise, PREMISE_MAX),
    universeId: trimTo(raw.universeId, UNIVERSE_ID_MAX) || null,
    // Bidirectional link to a Writers Room work (item 6 of the DRY
    // unification). Set by the "Promote to pipeline" flow; never auto-cleared.
    writersRoomWorkId: trimTo(raw.writersRoomWorkId, WRITERS_ROOM_WORK_ID_MAX) || null,
    // Phase 2 of Story Arc Planning: optional multi-season story spine + the
    // ordered season list. Both default to empty so existing series.json
    // files migrate forward without a writer pass — first save backfills.
    arc: sanitizeArc(raw.arc),
    seasons: sanitizeSeasonList(raw.seasons),
    // Per-character story arcs (#1293) — each cast member's want/need, start →
    // end transformation, and explicit transition beats. Defaults to [] so
    // existing series.json files (which predate this field) migrate forward
    // without a writer pass — first save backfills. Wire-gated (pipelineSeries
    // schema v6) so a characterArcs-unaware peer can't strip-then-LWW the loss.
    characterArcs: sanitizeCharacterArcList(raw.characterArcs),
    locked: sanitizeSeriesLocked(raw.locked),
    styleNotes: trimTo(raw.styleNotes, STYLE_NOTES_MAX),
    // Fact-checking opt-in (#1588). When true (and a non-empty `factReference`
    // is supplied), the gated `research.fact-accuracy` editorial check runs so
    // it never fires on pure fantasy. Defaults to false — existing series.json
    // files (which predate these fields) migrate forward without a writer pass;
    // first save backfills both. Wire-gated (pipelineSeries schema v7) so a
    // factReference-unaware peer can't strip-then-LWW the loss back.
    factCritical: raw.factCritical === true,
    factReference: trimTo(raw.factReference, FACT_REFERENCE_MAX),
    // Per-series house style (tense/POV/audience/rating/reading-level/tone/
    // conventions). Structured companion to the free-text styleNotes above;
    // sanitizeStyleGuide returns null when empty so existing series.json files
    // (which predate this field) migrate forward without a writer pass.
    styleGuide: sanitizeStyleGuide(raw.styleGuide),
    titleLogo: trimTo(raw.titleLogo, TITLE_LOGO_MAX),
    // Derived cover thumbnail filename (a rendered volume/issue cover). Stamped
    // by the cover filename hooks + the one-time boot backfill via
    // setSeriesCoverImage; null until a cover renders. Additive + gracefully
    // degrading (a pre-feature peer's sanitizeSeries drops it), but wire-gated
    // (pipelineSeries schema v5) so an older peer can't strip-then-LWW the
    // pointer back onto a newer peer.
    coverImage: trimTo(raw.coverImage, COVER_IMAGE_MAX) || null,
    author: trimTo(raw.author, AUTHOR_MAX),
    authorId: trimTo(raw.authorId, AUTHOR_ID_MAX) || null,
    // Per-series override that prepends ahead of the linked universe's
    // stylePrompt during image-gen composition. Lets a single series in a
    // shared universe deviate slightly (e.g. a noir spin-off) without
    // forking the universe. Empty string = no override; fall through to
    // universe-only style.
    stylePromptOverride: trimTo(raw.stylePromptOverride, STYLE_PROMPT_OVERRIDE_MAX),
    stylePromptOverrideMode: STYLE_PROMPT_OVERRIDE_MODES.includes(raw.stylePromptOverrideMode)
      ? raw.stylePromptOverrideMode
      : STYLE_PROMPT_OVERRIDE_MODE_DEFAULT,
    targetFormat,
    // The format this series is finalized in first (source of truth for the
    // other two). `null` until the author picks one in the bible. Validated
    // against the stage-id list so a stale/hand-edited value can't smuggle in
    // a non-manuscript stage.
    primaryManuscriptType: MANUSCRIPT_TYPES.includes(raw.primaryManuscriptType)
      ? raw.primaryManuscriptType
      : null,
    issueCountTarget,
    llm,
    // Share-bucket provenance — present on imported records, absent on locally-authored ones.
    origin: sanitizeOrigin(raw.origin),
    createdAt,
    updatedAt,
    // Soft-delete fields — peer sync needs the tombstone in the record itself
    // so LWW merge can resolve delete-vs-edit races by `updatedAt`.
    ...sanitizeSoftDeleteFields(raw),
    // Local-only "don't sync to peers" marker. Persisted only when true so
    // existing series keep their on-disk + wire-checksum shape. See
    // syncWire.sanitizeRecordForWire for the wire-side enforcement.
    ...(raw.ephemeral === true ? { ephemeral: true } : {}),
    // Importer-orphan marker (issue #727). Stamped only by analyzeImport on a
    // brand-new shell so the orphan-shell GC can tell an abandoned analyze from
    // a user's deliberately-private empty series (also `ephemeral`).
    // commitImport clears it. Server-set only — never from a route body — and
    // persisted only when true so every other record's shape stays stable.
    ...(raw.importDraft === true ? { importDraft: true } : {}),
    // Autopilot run marker — persisted only when present so series that never
    // run the autonomous pipeline keep their on-disk + wire shape unchanged.
    // Older peers' sanitizeSeries simply drops the unknown field (forward/
    // back-compatible).
    ...(autopilot ? { autopilot } : {}),
    // Per-series editorial-check config overrides (#1591). Always present (empty
    // `{}` when nothing is tuned), like factReference/styleGuide, so a clear
    // propagates between v8 peers and a behind-sender's omission is preserved (see
    // ADDITIVE_SERIES_FIELDS). Wire-gated at pipelineSeries v8 so a ≤v7 peer can't
    // strip-then-LWW the overrides back onto a newer peer.
    editorialCheckConfig,
    // Per-series autopilot severity config (#1616) — the health-score severity
    // weights + per-gate blocking-severity sets. Both always present (empty `{}`
    // when nothing is tuned), like editorialCheckConfig. Wire-gated at
    // pipelineSeries v9 so a ≤v8 peer can't strip-then-LWW them back.
    severityWeights,
    blockingSeverities,
  };
};

export async function listSeries({ includeDeleted = false } = {}) {
  const series = await store().loadAll();
  const filtered = includeDeleted ? series : series.filter((s) => !s.deleted);
  return [...filtered].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function getSeries(id, { includeDeleted = false } = {}) {
  const found = await store().loadOne(id);
  if (!found) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
  if (found.deleted && !includeDeleted) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
  return found;
}

export async function createSeries(input = {}) {
  const name = trimTo(input.name, NAME_MAX);
  if (!name) throw makeErr(`Series name is required (1..${NAME_MAX} chars)`, ERR_VALIDATION);
  const now = new Date().toISOString();
  const created = sanitizeSeries({
    id: `ser-${randomUUID()}`,
    name,
    logline: input.logline || '',
    premise: input.premise || '',
    universeId: input.universeId || null,
    writersRoomWorkId: input.writersRoomWorkId || null,
    arc: input.arc || null,
    seasons: input.seasons || [],
    characterArcs: input.characterArcs || [],
    locked: input.locked || {},
    styleNotes: input.styleNotes || '',
    factCritical: input.factCritical === true,
    factReference: input.factReference || '',
    styleGuide: input.styleGuide || null,
    titleLogo: input.titleLogo || '',
    author: input.author || '',
    authorId: input.authorId || null,
    stylePromptOverride: input.stylePromptOverride || '',
    stylePromptOverrideMode: input.stylePromptOverrideMode,
    targetFormat: input.targetFormat || 'comic+tv',
    issueCountTarget: input.issueCountTarget || 0,
    llm: input.llm || null,
    createdAt: now,
    updatedAt: now,
    ephemeral: input.ephemeral === true,
    // Importer-orphan marker (issue #727) — see sanitizeSeries.
    importDraft: input.importDraft === true,
    // Per-series editorial-check config overrides (#1591) — forwarded so an
    // importer / promote flow that seeds a series with tuned thresholds keeps
    // them; sanitizeSeries normalizes an empty/malformed map to `{}`.
    editorialCheckConfig: input.editorialCheckConfig,
    // Per-series autopilot severity config (#1616) — forwarded so an importer /
    // promote flow that seeds tuned weights/blocking sets keeps them;
    // sanitizeSeries normalizes empty/malformed values to `{}`.
    severityWeights: input.severityWeights,
    blockingSeverities: input.blockingSeverities,
  });
  await store().saveOne(created.id, created);
  // Skip auto-subscribe for ephemeral series — wire-side push would short-
  // circuit via sanitizeRecordForWire anyway, but not creating the sub up
  // front keeps the subscription store clean.
  if (!created.ephemeral) {
    // Fire-and-forget auto-subscribe to every peer with pipeline-sync enabled,
    // via the recordEvents subscription adapter (peerSync registers the real
    // implementation at boot — importing it from here would close a cycle).
    autoSubscribeRecordToAllPeers('series', created.id).catch((err) => {
      console.log(`⚠️ series: auto-subscribe after create failed: ${err.message}`);
    });
  }
  // Reconcile a draft parent universe (issue #851) when a committed (non-draft,
  // non-ephemeral) series is created already linked to it — the create-time
  // twin of the updateSeries link path. See reconcileDraftParentUniverse and
  // `isPromotingChild` for the gating contract.
  if (created.universeId && isPromotingChild(created)) {
    await reconcileDraftParentUniverse(created.universeId);
  }
  return created;
}

/**
 * Insert a series with a caller-supplied id (used by the share-bucket importer
 * so re-imports of the same series LWW-merge onto the same local row instead
 * of accumulating duplicates). Throws ERR_DUPLICATE if the id is already
 * present, ERR_VALIDATION if the id is malformed. Preserves createdAt /
 * updatedAt verbatim so LWW comparisons against subsequent re-shares work.
 */
export async function insertSeriesWithId(input = {}) {
  if (!isStr(input.id) || !SERIES_ID_RE.test(input.id)) {
    throw makeErr(`insertSeriesWithId: invalid id "${input.id}" (expected ser-<uuid>)`, ERR_VALIDATION);
  }
  const name = trimTo(input.name, NAME_MAX);
  if (!name) throw makeErr(`Series name is required (1..${NAME_MAX} chars)`, ERR_VALIDATION);
  const { next, wasResurrection } = await store().queueRecordWrite(input.id, async () => {
    // Tombstone-overwrite: same contract as universeBuilder.insertUniverseWithId —
    // re-import undeletes; peer-sync resurrection is prevented at the merge
    // path via LWW, not here.
    const existing = await store().loadOne(input.id);
    if (existing && !existing.deleted) {
      throw makeErr(`Series id already exists: ${input.id}`, ERR_DUPLICATE);
    }
    const wasResurrection = !!existing;
    const next = sanitizeSeries({ ...input, name });
    if (!next) throw makeErr('Invalid series payload', ERR_VALIDATION);
    if (wasResurrection) {
      console.warn(`♻️  insertSeriesWithId: overwriting tombstone for ${input.id}`);
    }
    await store().saveOneNow(next.id, next);
    return { next, wasResurrection };
  });
  // Mirror createSeries's federation side-effects on tombstone-overwrite:
  // peers that still have the deleted record need the resurrection propagated.
  if (wasResurrection && !next.ephemeral) {
    emitRecordUpdated('series', next.id);
    autoSubscribeRecordToAllPeers('series', next.id).catch((err) => {
      console.log(`⚠️ series: auto-subscribe after resurrection failed: ${err.message}`);
    });
  }
  return next;
}

/**
 * Whether linking `series` to a parent universe should promote a draft parent
 * (issue #851). True only for a series that is BOTH non-draft AND non-ephemeral:
 *
 *   - `importDraft !== true` — an import-draft series linked to a draft universe
 *     must NOT promote it; that's commitImport's job.
 *   - `ephemeral !== true` — a deliberately-private (kept-local) series carries
 *     no syncing work, so promoting (and thereby un-privatizing) its parent
 *     would push peers a universe whose only child never syncs. Only a series
 *     that itself reaches peers should pull its draft parent into sync.
 */
const isPromotingChild = (series) => series?.importDraft !== true && series?.ephemeral !== true;

/**
 * Promote an import-draft universe to a normal, syncing record when a
 * committed (non-draft, non-ephemeral) series gets linked to it outside the
 * commitImport path (issue #851). Mirrors commitImport's promotion: clears BOTH
 * `importDraft` and `ephemeral` through `updateUniverse` so the
 * ephemeral→non-ephemeral peer re-subscribe wiring fires.
 *
 * Gated STRICTLY on the parent's `importDraft === true` — a user's
 * deliberately-private (`ephemeral`-only) universe must never be un-privatized
 * as a side effect of linking a series, exactly as commitImport gates its own
 * promotion. (Caller gates the child via `isPromotingChild`.)
 *
 * Best-effort: runs outside any write queue and swallows + logs failures so a
 * universe-side error never fails the series link that triggered it. The
 * dynamic import dodges the static cycle (universeBuilder imports listSeries
 * from this module).
 */
async function reconcileDraftParentUniverse(universeId) {
  await import('../universeBuilder.js')
    .then(async ({ getUniverse, updateUniverse }) => {
      const universe = await getUniverse(universeId).catch(() => null);
      if (universe?.importDraft !== true) return;
      await updateUniverse(universeId, { ephemeral: false, importDraft: false });
      console.log(`🔗 series: promoted import-draft universe ${universeId.slice(0, 8)} — committed series linked outside commitImport`);
    })
    .catch((err) => {
      console.log(`⚠️ series: reconcile draft parent universe ${universeId.slice(0, 8)} failed: ${err.message}`);
    });
}

export async function updateSeries(id, patch = {}) {
  // Pre-B.4 canon (characters/settings/objects) lives on the universe, not the
  // series — but a stale browser tab can still POST a legacy series shape and
  // see a silent 200. Warn so a regression that re-introduces the legacy
  // payload is observable in logs instead of vanishing canon.
  const legacyFields = ['characters', 'settings', 'objects'].filter((k) => k in patch);
  if (legacyFields.length > 0) {
    console.warn(`⚠️ series PATCH ${id.slice(0, 8)} stripped legacy canon fields: ${legacyFields.join(', ')}`);
  }
  const { merged, nameChanged, prevEphemeral, nextEphemeral, linkedUniverseId } = await store().queueRecordWrite(id, async () => {
    const cur = await store().loadOne(id);
    if (!cur) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
    if (cur.deleted) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
    // Hierarchy invariant: a series lives in exactly one universe. Reject
    // clearing the link once it's set — moving to a *different* non-empty
    // universe is fine, and a legacy orphan (cur.universeId === null) is still
    // allowed to receive its first link. The importer / mergeSeriesFromSync
    // land legacy orphans via the service directly (not this guard), so peer
    // fidelity is preserved.
    if ('universeId' in patch && cur.universeId && !trimTo(patch.universeId, UNIVERSE_ID_MAX)) {
      throw makeErr('Cannot unlink a series from its universe — move it to another universe instead.', ERR_VALIDATION);
    }
    // Per-field merge so `{ provider: 'codex' }` doesn't clobber an existing `model`.
    const mergedLlm = 'llm' in patch
      ? { ...(cur.llm || {}), ...(patch.llm || {}) }
      : cur.llm;
    const next = sanitizeSeries({
      ...cur,
      ...('name' in patch ? { name: patch.name } : {}),
      ...('logline' in patch ? { logline: patch.logline } : {}),
      ...('premise' in patch ? { premise: patch.premise } : {}),
      ...('universeId' in patch ? { universeId: patch.universeId } : {}),
      ...('writersRoomWorkId' in patch ? { writersRoomWorkId: patch.writersRoomWorkId } : {}),
      ...('arc' in patch ? { arc: patch.arc } : {}),
      ...('seasons' in patch ? { seasons: patch.seasons } : {}),
      // Wholesale replace — `characterArcs: []` clears all arcs; omission
      // preserves. sanitizeCharacterArcList drops empties + dedupes by identity.
      ...('characterArcs' in patch ? { characterArcs: patch.characterArcs } : {}),
      // Wholesale replace — `locked: {}` clears every lock; omission preserves.
      ...('locked' in patch ? { locked: patch.locked } : {}),
      ...('styleNotes' in patch ? { styleNotes: patch.styleNotes } : {}),
      // Fact-checking opt-in + author fact reference (#1588). `factReference: ''`
      // clears the reference; omission preserves. Sanitizer normalizes a
      // non-true `factCritical` back to false.
      ...('factCritical' in patch ? { factCritical: patch.factCritical } : {}),
      ...('factReference' in patch ? { factReference: patch.factReference } : {}),
      // Wholesale replace — sanitizeStyleGuide normalizes an empty object back
      // to null (clear); omission preserves. Mirrors the arc/readerMap pattern.
      ...('styleGuide' in patch ? { styleGuide: patch.styleGuide } : {}),
      ...('titleLogo' in patch ? { titleLogo: patch.titleLogo } : {}),
      ...('author' in patch ? { author: patch.author } : {}),
      ...('authorId' in patch ? { authorId: patch.authorId } : {}),
      ...('stylePromptOverride' in patch ? { stylePromptOverride: patch.stylePromptOverride } : {}),
      ...('stylePromptOverrideMode' in patch ? { stylePromptOverrideMode: patch.stylePromptOverrideMode } : {}),
      ...('targetFormat' in patch ? { targetFormat: patch.targetFormat } : {}),
      ...('primaryManuscriptType' in patch ? { primaryManuscriptType: patch.primaryManuscriptType } : {}),
      ...('issueCountTarget' in patch ? { issueCountTarget: patch.issueCountTarget } : {}),
      ...('origin' in patch ? { origin: patch.origin } : {}),
      // Local-only "don't sync" marker — sanitizer normalizes anything
      // non-true back to absent.
      ...('ephemeral' in patch ? { ephemeral: patch.ephemeral } : {}),
      // Importer-orphan marker (issue #727) — commitImport clears it via
      // `{ importDraft: false }`; sanitizer normalizes non-true back to absent.
      ...('importDraft' in patch ? { importDraft: patch.importDraft } : {}),
      // Autopilot run marker — server-set by seriesAutopilot.js (and the
      // boot-recovery demotion). Wholesale replace; sanitizer normalizes a
      // non-object back to absent.
      ...('autopilot' in patch ? { autopilot: patch.autopilot } : {}),
      // Per-series editorial-check config overrides (#1591). Wholesale replace —
      // `{}`/`null` clears every override; omission preserves. The sanitizer drops
      // empty/malformed entries and normalizes to `{}` (always present).
      ...('editorialCheckConfig' in patch ? { editorialCheckConfig: patch.editorialCheckConfig } : {}),
      // Per-series autopilot severity config (#1616). Wholesale replace —
      // `{}`/`null` clears the override (defaults apply); omission preserves. The
      // sanitizer drops malformed values and normalizes to `{}` (always present).
      ...('severityWeights' in patch ? { severityWeights: patch.severityWeights } : {}),
      ...('blockingSeverities' in patch ? { blockingSeverities: patch.blockingSeverities } : {}),
      llm: mergedLlm,
      updatedAt: new Date().toISOString(),
    });
    if (!next) throw makeErr('Invalid series payload', ERR_VALIDATION);
    await store().saveOneNow(next.id, next);
    // Surface the universe this series ends up linked to ONLY when (a) this
    // PATCH set/changed the link and (b) the series itself qualifies to promote
    // its parent (committed AND syncing — see isPromotingChild). The post-queue
    // side effect reconciles a draft parent universe (issue #851) — see below.
    const linkChanged = 'universeId' in patch && next.universeId && next.universeId !== cur.universeId;
    return {
      merged: next,
      nameChanged: next.name !== cur.name,
      // See updateUniverse — surface the transition pair so the post-queue
      // side effects can wire subscribe / unsubscribe.
      prevEphemeral: cur.ephemeral === true,
      nextEphemeral: next.ephemeral === true,
      linkedUniverseId: (linkChanged && isPromotingChild(next)) ? next.universeId : null,
    };
  });
  // Ephemeral lifecycle wiring — see updateUniverse for the rationale. false→true
  // tears down per-record subs; true→false re-auto-subscribes so the now-
  // shareable series reaches every peer with the pipeline category enabled.
  // Must run BEFORE emitRecordUpdated so the peerSync 'updated' listener
  // doesn't schedule pushes against subs that are about to be torn down.
  // Awaited (NOT fire-and-forget) — otherwise the unsubscribe resolves on a
  // microtask after emitRecordUpdated has already fired the listener and
  // pushes get scheduled against the about-to-be-deleted subs.
  if (prevEphemeral && !nextEphemeral) {
    await autoSubscribeRecordToAllPeers('series', merged.id).catch((err) => {
      console.log(`⚠️ series: re-subscribe after un-ephemeralizing failed: ${err.message}`);
    });
  } else if (!prevEphemeral && nextEphemeral) {
    await unsubscribeAllForRecord('series', merged.id).catch((err) => {
      console.log(`⚠️ series: unsubscribe after ephemeralizing failed: ${err.message}`);
    });
  }
  // Cascade rename onto the linked per-series media collection (if any) —
  // log but don't fail the save. Runs OUTSIDE the queue so the media-
  // collections write tail can't stall subsequent series mutators. No-op
  // when no series-linked collection exists (the common case for
  // universe-backed series, where the universe owns the auto-collection).
  if (nameChanged) {
    await renameCollectionForSeries(merged.id, merged.name).catch((err) => {
      console.error(`❌ series-collection rename cascade failed for ${merged.id}: ${err?.message || err}`);
    });
  }
  // Reconcile a draft parent universe (issue #851). When a committed (non-
  // draft, non-ephemeral) series is linked to an import-draft universe WITHOUT
  // going through commitImport, the universe stays `ephemeral` + `importDraft`
  // forever and silently never syncs — even though it now holds real committed
  // work that reaches peers (see isPromotingChild for the child gate). Mirror
  // commitImport's promotion exactly: clear BOTH flags via updateUniverse so
  // the ephemeral→non-ephemeral peer re-subscribe fires and the now-real
  // universe reaches every peer. Best-effort + outside the series write queue
  // (it touches a different record); a failure must not fail the series link.
  // Dynamic import to dodge the static cycle (universeBuilder imports this
  // module's listSeries).
  if (linkedUniverseId) {
    await reconcileDraftParentUniverse(linkedUniverseId);
  }
  emitRecordUpdated('series', merged.id);
  return merged;
}

export async function setArcFieldLock(id, field, locked) {
  if (!ARC_LOCKABLE_FIELDS.includes(field)) {
    throw makeErr(`Unknown arc lock field: ${field}`, ERR_VALIDATION);
  }
  return store().queueRecordWrite(id, async () => {
    const cur = await store().loadOne(id);
    if (!cur) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
    if (cur.deleted) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
    const arcFields = { ...(cur.locked?.arcFields || {}) };
    if (locked === true) arcFields[field] = true;
    else delete arcFields[field];
    const nextLocked = { ...(cur.locked || {}) };
    if (Object.keys(arcFields).length > 0) nextLocked.arcFields = arcFields;
    else delete nextLocked.arcFields;
    const next = sanitizeSeries({
      ...cur,
      locked: nextLocked,
      updatedAt: new Date().toISOString(),
    });
    if (!next) throw makeErr('Invalid series payload', ERR_VALIDATION);
    await store().saveOneNow(next.id, next);
    emitRecordUpdated('series', next.id);
    return next;
  });
}

/**
 * Stamp the derived cover thumbnail (a rendered volume/issue cover filename)
 * onto the series record so the pipeline list can show a thumbnail without
 * scanning issues at read time. Server-set/derived only — see
 * seriesCoverImage.refreshSeriesCoverImage for the recompute that calls this.
 *
 * No-op (no write, no `recordUpdated` emit) when the value is unchanged so
 * repeat cover renders for an already-decorated series don't churn the record
 * or re-broadcast to peers. Mirrors the empty-patch fast-path in
 * `updateSeasonOnSeries`.
 */
export async function setSeriesCoverImage(id, filename) {
  const next = isStr(filename) && filename ? filename.slice(0, COVER_IMAGE_MAX) : null;
  return store().queueRecordWrite(id, async () => {
    const cur = await store().loadOne(id);
    if (!cur) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
    if (cur.deleted) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
    if ((cur.coverImage || null) === next) return cur; // no-op guard
    const merged = sanitizeSeries({ ...cur, coverImage: next, updatedAt: new Date().toISOString() });
    if (!merged) throw makeErr('Invalid series payload', ERR_VALIDATION);
    await store().saveOneNow(merged.id, merged);
    emitRecordUpdated('series', merged.id);
    return merged;
  });
}

/**
 * Apply a structured patch to one season inside a series. Routes through the
 * per-series collection-store queue so a season-cover render PATCH, the
 * season-cover filename hook landing, and a user-driven season metadata edit
 * all serialize against the same series record. Returns the updated series.
 *
 * Throws `PIPELINE_SEASON_NOT_FOUND` (the seasons-service ERR_NOT_FOUND
 * value, inlined here to avoid a circular import seasons → series → seasons)
 * when the season is missing so the season-resource routes surface a 404
 * with "Season not found" rather than "Series not found".
 */
export async function updateSeasonOnSeries(seriesId, seasonId, patchFn) {
  return store().queueRecordWrite(seriesId, async () => {
    const cur = await store().loadOne(seriesId);
    if (!cur) throw makeErr(`Series not found: ${seriesId}`, ERR_NOT_FOUND);
    if (cur.deleted) throw makeErr(`Series not found: ${seriesId}`, ERR_NOT_FOUND);
    const seasons = Array.isArray(cur.seasons) ? cur.seasons : [];
    const seasonIdx = seasons.findIndex((s) => s.id === seasonId);
    if (seasonIdx < 0) {
      throw makeErr(`Season not found: ${seasonId}`, 'PIPELINE_SEASON_NOT_FOUND');
    }
    const existing = seasons[seasonIdx];
    const patched = patchFn(existing);
    // No-op short-circuit: `patchFn` returning `null`/`undefined` (or an empty
    // object) means "nothing changed" — typically a filename-hook racing a
    // newer job. Without this guard, every late completion event bumps
    // `season.updatedAt`, rewrites the series file, and re-broadcasts
    // `recordUpdated('series', …)`, which schedules a share re-export and
    // makes LWW comparisons noisy. Mirrors the empty-patch fast-path the
    // issues-side `updateStageWithLatest` already has.
    if (!patched || (typeof patched === 'object' && Object.keys(patched).length === 0)) {
      return cur;
    }
    const nextSeasons = [...seasons];
    // Force a fresh updatedAt on the touched season so LWW comparisons fire.
    nextSeasons[seasonIdx] = { ...existing, ...patched, updatedAt: new Date().toISOString() };
    const merged = sanitizeSeries({
      ...cur,
      seasons: nextSeasons,
      updatedAt: new Date().toISOString(),
    });
    if (!merged) throw makeErr('Invalid series payload after season patch', ERR_VALIDATION);
    await store().saveOneNow(merged.id, merged);
    emitRecordUpdated('series', merged.id);
    return merged;
  });
}

export async function deleteSeries(id) {
  // Soft-delete: flip `deleted` + stamp `deletedAt`, bump `updatedAt` so the
  // tombstone propagates via the existing LWW merge. Side effects (media-
  // collection unlink + recordDeleted emit) still run locally and also fire
  // on the receiving peer via mergeSeriesFromSync's transition detection.
  const result = await store().queueRecordWrite(id, async () => {
    const cur = await store().loadOne(id);
    if (!cur) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
    if (cur.deleted) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
    const now = new Date().toISOString();
    await store().saveOneNow(id, { ...cur, deleted: true, deletedAt: now, updatedAt: now });
    // Any live share-bucket subscription for this series tears itself down via
    // the recordEvents listener instead of orphaning.
    emitRecordDeleted('series', id);
    return { id };
  });
  // Release the rename-lock on any linked per-series media collection so
  // the orphan becomes a normal user-owned bucket. Runs OUTSIDE the series
  // write tail; best-effort, mirrors the universe-side flow.
  await unlinkCollectionsForSeries(id).catch((err) => {
    console.error(`❌ unlink media collections for deleted series ${id} failed: ${err?.message || err}`);
  });
  return result;
}

/**
 * Cascade orphan cleanup for a series whose soft-delete arrived via peer
 * sync. Mirrors the post-queue cleanup in deleteSeries so a synced delete on
 * the receiver leaves the same orphan-free state as a local delete.
 */
async function cascadeDeleteSideEffects(id) {
  await unlinkCollectionsForSeries(id).catch((err) => {
    console.error(`❌ unlink media collections for synced-delete series ${id} failed: ${err?.message || err}`);
  });
  emitRecordDeleted('series', id);
}

// Top-level additive content fields whose ABSENCE in a remote payload must not
// erase a locally-authored value. `sanitizeSeries` collapses an absent key to
// the same null/[]/'' as an explicit clear, so on the sync-merge path we
// consult the RAW remote payload to tell the two apart: key absent → preserve
// local; key present (even null/empty) → honor the intentional clear. Mirrors
// the `universeId` hierarchy guard. See issue #1361.
const ADDITIVE_SERIES_FIELDS = ['arc', 'seasons', 'styleGuide', 'styleNotes', 'characterArcs', 'factReference', 'factCritical', 'editorialCheckConfig', 'severityWeights', 'blockingSeverities'];
// Additive sub-fields nested inside `arc`. A peer that predates these (readerMap
// shipped at schema v2, tickingClock at #1289/v3, foreshadowing at #2172/v10)
// still sends an `arc` object — just without these keys — so the erasure for
// them happens one level down. (The v10 gate rejects OLDER peers; this list
// additionally guards a SAME-version peer whose arc simply omits the key.)
const ADDITIVE_ARC_FIELDS = ['readerMap', 'tickingClock', 'foreshadowing'];

const keyAbsent = (obj, key) => !obj || typeof obj !== 'object' || !(key in obj) || obj[key] === undefined;

/**
 * Re-inject locally-authored additive fields into a freshly-sanitized remote
 * record when the RAW remote payload omitted the key entirely. Mutates and
 * returns `sanitized`. Skips tombstones (a deleted record carries no content to
 * protect). Operates both at the top level and on the additive sub-fields nested
 * inside `arc`. An explicitly-present null/empty from an up-to-date peer is left
 * untouched so an intentional clear still applies. See issue #1361.
 */
export const preserveAbsentAdditiveFields = (sanitized, rawRemote, local) => {
  if (!sanitized || sanitized.deleted || !local || typeof local !== 'object') return sanitized;
  for (const field of ADDITIVE_SERIES_FIELDS) {
    if (keyAbsent(rawRemote, field)) sanitized[field] = local[field];
  }
  // Nested arc sub-fields: only when the remote DID send an `arc` object (so the
  // top-level preserve above didn't already restore the whole arc) and both the
  // sanitized result and the local record carry an arc object to merge into.
  if (!keyAbsent(rawRemote, 'arc')
    && sanitized.arc && typeof sanitized.arc === 'object'
    && local.arc && typeof local.arc === 'object') {
    for (const sub of ADDITIVE_ARC_FIELDS) {
      if (keyAbsent(rawRemote.arc, sub)) sanitized.arc[sub] = local.arc[sub];
    }
  }
  return sanitized;
};

/**
 * Sync-orchestrator entry point. Merges a remote peer's series array into
 * local state through per-record collection-store queues. Each incoming record
 * passes through `sanitizeSeries` for shape enforcement. LWW by `updatedAt`;
 * returns `{ applied, count }` where `count` is the number of series actually
 * changed/added.
 */
export async function mergeSeriesFromSync(remoteSeries, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteSeries)) return { applied: false, count: 0 };
  // Series IDs that transitioned to deleted via this merge — cascade fires
  // after the write queue releases (mirrors local-delete contract).
  //
  // Edit-merges (no delete-transition) DO NOT call `emitRecordUpdated` here —
  // see `mergeUniversesFromSync` for the rationale (the Stage 2 per-record
  // peer-sync push owns sync-time edit emits).
  const transitionedToDeleted = [];
  let changed = 0;
  for (const remote of remoteSeries) {
    if (!remote || typeof remote !== 'object' || !isStr(remote.id)) continue;
    if (!SERIES_ID_RE.test(remote.id)) continue;
    await store().queueRecordWrite(remote.id, async () => {
      const sanitized = sanitizeSeries(remote);
      if (!sanitized) return;
      // Strip inbound `ephemeral` — see mergeUniversesFromSync.
      if ('ephemeral' in sanitized) delete sanitized.ephemeral;
      // Strip inbound `importDraft` (issue #727) — local-only GC marker; a peer
      // must not be able to mark our records GC-eligible.
      if ('importDraft' in sanitized) delete sanitized.importDraft;
      const local = await store().loadOne(sanitized.id);
      if (!local) {
        // See universeBuilder.mergeUniversesFromSync — no local means no
        // cascade work, regardless of inbound tombstone state.
        await store().saveOneNow(sanitized.id, sanitized);
        // Seed the base hash so a FUTURE divergence on this record is detected.
        await setSyncBaseHash('series', sanitized.id, contentHashForRecord('series', sanitized));
        changed++;
      } else if (local.ephemeral === true) {
        // Local-ephemeral series are immune to inbound merges. See
        // mergeUniversesFromSync for the contract.
        return;
      } else {
        const localTs = local.updatedAt || '';
        const remoteTs = sanitized.updatedAt || '';
        if (remoteTs > localTs) {
          // Hierarchy invariant on the sync path: an older peer (or a peer that
          // cleared the link before the rule shipped) can push a newer series
          // payload with universeId:null. updateSeries refuses to unlink, but
          // this merge writes directly — so preserve the local link here too,
          // or LWW would silently orphan a linked series. A *move* to a
          // different non-empty universe still applies. Mirrors the importer's
          // mergeOne guard.
          if (!sanitized.deleted && !sanitized.universeId && local.universeId) {
            sanitized.universeId = local.universeId;
          }
          // Additive content fields: a behind/legacy peer (or one that never
          // authored the field) pushes a newer payload that simply OMITS the
          // key. `sanitizeSeries` already flattened that absence to null/[]/'',
          // so re-inject the local value from the raw remote payload — otherwise
          // LWW silently erases styleGuide/readerMap/tickingClock/styleNotes/
          // seasons. An explicit null/empty from an up-to-date peer still
          // applies. See issue #1361.
          preserveAbsentAdditiveFields(sanitized, remote, local);
          // Non-blocking conflict journal — archive the losing local version on
          // a true 3-way divergence; always advances the base hash. Never throws.
          await maybeJournalBeforeOverwrite({ kind: 'series', id: sanitized.id, local, remote: sanitized, source });
          await store().saveOneNow(sanitized.id, sanitized);
          if (sanitized.deleted && !local.deleted) transitionedToDeleted.push(sanitized.id);
          changed++;
        }
      }
    });
  }
  await flushBaseHashes();
  const result = changed === 0 ? { applied: false, count: 0 } : { applied: true, count: changed };
  for (const id of transitionedToDeleted) {
    await cascadeDeleteSideEffects(id);
  }
  return result;
}

/**
 * Garbage-collect series tombstones older than `beforeMs`. See
 * `pruneTombstonedUniverses` in universeBuilder.js for the contract — the
 * caller owns the ack-cursor + grace-period math and just tells us the
 * cutoff timestamp. Tombstones with unparseable `deletedAt` are kept.
 */
export async function pruneTombstonedSeries(beforeMs) {
  if (!Number.isFinite(beforeMs)) return { pruned: 0 };
  const s = store();
  const series = await s.loadAll();
  const candidates = [];
  for (const rec of series) {
    if (!rec?.deleted) continue;
    const t = Date.parse(rec.deletedAt || '');
    if (!Number.isFinite(t)) continue;
    if (t < beforeMs) candidates.push(rec.id);
  }
  // Re-check the tombstone status INSIDE each per-id queue. A concurrent
  // mergeSeriesFromSync could have un-deleted the record (newer remote
  // `updatedAt`, `deleted: false`) between our out-of-queue snapshot and the
  // queued delete; without the re-check we'd rm -rf a freshly un-deleted
  // record. Mirrors pruneTombstonedUniverses. Uses deleteOneNow (not deleteOne —
  // that re-enters queueRecordWrite for the same id and would deadlock).
  const results = await Promise.allSettled(candidates.map((id) =>
    s.queueRecordWrite(id, async () => {
      const fresh = await s.loadOne(id);
      if (!fresh?.deleted) return false; // un-deleted between snapshot and queue
      const t = Date.parse(fresh.deletedAt || '');
      if (!Number.isFinite(t) || t >= beforeMs) return false;
      await s.deleteOneNow(id);
      await deleteSyncBaseHash('series', id);
      return true;
    })
  ));
  let pruned = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value === true) pruned += 1;
    else if (r.status === 'rejected') console.log(`⚠️ pruneTombstonedSeries: delete failed: ${r.reason?.message || r.reason}`);
  }
  return { pruned };
}
