/**
 * Pipeline — Foundation-quality judge + fix router (CWQE Phase 11, #2176).
 *
 * The "correct it up-front, not in editor mode" mechanism for autonomous runs.
 * Before Series Autopilot drafts a single issue, it judges the FOUNDATION as a
 * whole — universe canon (worldbuilding) + character records + the series
 * arc/seasons (structure) + declared voice/style (craft) — against a weighted
 * rubric mirroring the Phase 10 craft doctrine (#2175):
 *
 *     worldbuilding 40% · character 30% · structure 20% · craft 10%
 *
 * The judge runs on the writer/judge split resolved by `resolveJudgeForStage()`
 * (#2167) off the `pipeline-arc-overview` writer stage — the model that scores
 * the foundation is deliberately different from the one that generated it. It
 * returns a per-dimension `{ score, gap, fix }` and a weighted composite the
 * autopilot gate spends: proceed once the weighted score clears a configurable
 * threshold AND every dimension clears its floor; otherwise the bounded improve loop (in
 * seriesAutopilot.js `runFoundationGate`) targets the largest weighted deficit, applies
 * the fix through the OWNING service (never a raw write, `force:false`
 * everywhere), and re-judges.
 *
 * Fast-pass / skip: the judged inputs (canon + character records + full
 * synopsis plan + character arcs + series voice) are
 * content-hashed and pinned on the snapshot, so a re-judge of an UNCHANGED
 * foundation returns the cached verdict with no LLM call — an already-clean
 * foundation re-reached after unrelated steps cannot loop (mirrors
 * editorialAnalysis.js / pipelineJudge.js staleness). Snapshots persist at
 * `data/pipeline-foundation-judge/{seriesId}.json`.
 *
 * AI-provider policy: this fires ONLY from the already-consented Series
 * Autopilot (or an explicit user action) — never at boot.
 *
 * Errors bubble (no try/catch) except the single deliberate malformed-JSON retry
 * in `runFoundationJudgeStage` — LLM judges intermittently emit prose-wrapped or
 * truncated JSON, and one stricter retry salvages most of them.
 */

import { join } from 'path';
import { assertValidSeriesId } from '../../lib/pipelineIds.js';
import { PATHS, atomicWrite, ensureDir, tryReadFile, safeJSONParse } from '../../lib/fileUtils.js';
import { runStagedLLM, resolveStageContext, resolveJudgeForStage } from '../stageRunner.js';
import { manuscriptContentBudgetChars, estimateTokens } from '../../lib/contextBudget.js';
import { getStage } from '../promptService.js';
import { composeStyleNotes } from '../../lib/styleGuide.js';
import { BIBLE_KEYS } from '../../lib/storyBible.js';
import { getUniverse, updateUniverse } from '../universeBuilder.js';
import { getSeries, updateSeries } from './series.js';
import { listIssues } from './issues.js';
import { getSeriesCanon } from './seriesCanon.js';
import { resolveVerifyIssues, resolvedEpisodeEdits, restoreArcState, snapshotArcState, verifyArc } from './arcPlanner.js';
import { createArcMutationLedger } from './arcMutationLedger.js';
import {
  FRAMEWORK_STRING_FIELDS,
  PROFILE_STRING_FIELDS,
  buildFoundationContext,
  contentHash,
  countFoundationCharacterBlanks,
  countSeriesCastIntegrityFindings,
  foundationInputs,
  foundationInputsHash,
  renderArc,
  renderCharacterLine,
  renderWorldFoundation,
} from './foundationJudgeContext.js';
import { weakestDimension, isValidFoundationShape, sanitizeFoundationJudge, isFoundationStale } from './foundationScoring.js';
import {
  CHARACTER_FOUNDATION_BATCH_SIZE,
  REPAIR_OUTLINE_MAX_CHARS,
  REPAIR_SERIES_MAX_CHARS,
  REPAIR_CHARACTERS_MAX_CHARS,
  CHARACTER_FOUNDATION_TIMEOUT_MS,
  renderRepairSeriesJson,
  renderRepairCharactersJson,
  repairCharacters,
  repairCraft,
  refineWorld,
} from './foundationRepairs.js';

export * from './foundationScoring.js';
export { establishCharacterFoundation } from './foundationRepairs.js';
export {
  countFoundationCharacterBlanks,
  countSeriesCastIntegrityFindings,
  foundationInputs,
  foundationInputsHash,
  rankFoundationCharacters,
  seriesFoundationCharacters,
} from './foundationJudgeContext.js';

const STAGE = 'pipeline-judge-foundation';

// The writer stage whose judgeProvider/judgeModel pin drives the writer/judge
// split — the arc overview is the foundation's authoring pass. Mirrors
// pipelineJudge.js's WRITER_STAGE_TEMPLATE indirection (kept local + stable).
const WRITER_STAGE = 'pipeline-arc-overview';

const MAX_STRUCTURE_CORRECTION_PASSES = 3;

const JUDGE_OUTPUT_RESERVE_TOKENS = 2_000;

const nowIso = () => new Date().toISOString();

const ARC_BLOCKER_SEVERITIES = Object.freeze(['high', 'medium', 'low']);

function arcBlockerProfile(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const profile = Object.fromEntries(ARC_BLOCKER_SEVERITIES.map((severity) => [severity, 0]));
  for (const finding of list) {
    const severity = ARC_BLOCKER_SEVERITIES.includes(finding?.severity) ? finding.severity : 'medium';
    profile[severity] += 1;
  }
  return { ...profile, total: list.length };
}

// Negative means `left` is the safer checkpoint. A smaller high-severity count
// outranks raw total: six polish findings are preferable to four findings that
// still include a broken authorization or climax. Medium, low, then total break
// ties. This is deliberately lexicographic rather than a weighted sum so no
// number of low findings can conceal one unresolved high blocker.
function compareArcBlockers(left, right) {
  const a = arcBlockerProfile(left);
  const b = arcBlockerProfile(right);
  for (const key of [...ARC_BLOCKER_SEVERITIES, 'total']) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  return 0;
}

function formatArcBlockerProfile(findings) {
  const profile = arcBlockerProfile(findings);
  return `${profile.total} blocker(s): ${profile.high} high, ${profile.medium} medium, ${profile.low} low`;
}

const foundationDir = () => join(PATHS.data, 'pipeline-foundation-judge');
const snapshotPath = (seriesId) => join(foundationDir(), `${seriesId}.json`);

// ---------- storage ----------

async function loadSnapshot(seriesId) {
  const content = await tryReadFile(snapshotPath(seriesId));
  if (content === null) return null;
  const parsed = safeJSONParse(content, null, { allowArray: false, logError: true, context: snapshotPath(seriesId) });
  // `allowArray: false` only rejects a root array — a bare JSON scalar
  // (corrupted snapshot) still parses, and callers spread this into a
  // response object, so guard for a genuine object here.
  return parsed && typeof parsed === 'object' ? parsed : null;
}

async function saveSnapshot(snapshot) {
  await ensureDir(foundationDir());
  await atomicWrite(snapshotPath(snapshot.seriesId), snapshot);
}

// ---------- context record reads ----------

/**
 * The two objective, LLM-free measures of a `character` repair's work, read off
 * live records. Pass `charactersOverride` to measure a checkpoint's cast (the
 * pre-repair snapshot) against the same series/issue roster the live read uses,
 * so only the cast CONTENT differs between a before and an after.
 *
 * - `blanks` — named framework/profile/visual fields that are empty across the
 *   repairable roster. Holds every character to one field list.
 * - `integrityFindings` — deterministic cast-integrity gaps (#6415), which
 *   apply a per-character depth (a declared minor role or an author-explained
 *   unknown owes less) and are the only measure that reaches the psychology
 *   profile at all.
 *
 * Both are facts on disk. Neither subsumes the other: a visual-identity pass
 * moves only `blanks`, and authoring a theory of control moves only
 * `integrityFindings`.
 */
export async function readFoundationCharacterProgress(seriesId, charactersOverride = null) {
  assertValidSeriesId(seriesId);
  const series = await getSeries(seriesId);
  const [universe, issues] = await Promise.all([
    series?.universeId ? getUniverse(series.universeId).catch(() => null) : null,
    listIssues({ seriesId }),
  ]);
  const characters = Array.isArray(charactersOverride) ? charactersOverride : universe?.characters;
  return {
    blanks: countFoundationCharacterBlanks(characters, series, issues),
    integrityFindings: countSeriesCastIntegrityFindings(characters, series, issues),
  };
}

// One deliberate malformed-JSON retry (see module doc). Mirrors pipelineJudge.js.
async function runFoundationJudgeStage(ctx, runOptions) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await runStagedLLM(STAGE, ctx, runOptions);
      if (isValidFoundationShape(result.content)) return result;
      lastError = new Error('foundation judge response parsed but its rubric is incomplete or contains placeholders');
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// ---------- judge ----------

/**
 * Judge a series' foundation. Returns the stored snapshot, or a cached snapshot
 * when the inputs are unchanged and `!force` (the fast-pass that stops the gate
 * looping on an already-clean foundation).
 *
 * @param {string} seriesId
 * @param {object} [opts]
 * @param {string} [opts.providerId]  explicit judge provider override
 * @param {string} [opts.model]       explicit judge model override
 * @param {string} [opts.effort]      run-level reasoning effort (soft — a per-stage
 *                                   `effort` pin still wins, #3641)
 * @param {string} [opts.providerDefault] soft run-level judge provider; stage pin wins
 * @param {string} [opts.modelDefault] soft run-level judge model; explicit stage model wins
 * @param {string} [opts.effortDefault] soft run-level judge effort; stage pin wins
 * @param {boolean} [opts.force]      re-judge unchanged inputs
 */
export async function judgeFoundation(seriesId, {
  providerId,
  model,
  effort,
  providerDefault,
  modelDefault,
  effortDefault,
  onRunCreated,
  onRunSettled,
  force = false,
} = {}) {
  assertValidSeriesId(seriesId);
  const series = await getSeries(seriesId);
  const [universe, issues] = await Promise.all([
    series?.universeId ? getUniverse(series.universeId).catch(() => null) : null,
    listIssues({ seriesId }),
  ]);
  const hash = foundationInputsHash(series, universe, issues);

  const existing = await loadSnapshot(seriesId);
  // Cache only a verdict that still satisfies the current rubric contract.
  // This also self-heals snapshots written by an older permissive validator
  // from echoed prompt examples (`gap: "string"`): unchanged story inputs must
  // not make fabricated editorial evidence immortal across restarts/resumes.
  if (!force
    && existing
    && existing.status === 'complete'
    && existing.sourceInputsHash === hash
    && isValidFoundationShape(existing)) {
    return { ...existing, cached: true };
  }

  const canon = await getSeriesCanon(series);

  // Writer/judge split: resolve the judge provider/model from the arc-overview
  // writer stage's config (judgeProvider/judgeModel), honoring a route override.
  const writerStage = getStage(WRITER_STAGE);
  const { provider: judgeProvider, model: judgeModel } = await resolveJudgeForStage(writerStage, {
    providerOverride: providerId,
    modelOverride: model,
    providerDefault,
    modelDefault,
  });

  // Budget content to the judge model's window (#1488).
  const { contextWindow } = await resolveStageContext(STAGE, {
    providerOverride: judgeProvider.id,
    modelOverride: judgeModel,
  });
  const overheadTokens = 2_000 + estimateTokens(composeStyleNotes(series, { proseCraft: true }));
  const contentMax = manuscriptContentBudgetChars({
    contextWindow,
    overheadTokens,
    outputReserveTokens: JUDGE_OUTPUT_RESERVE_TOKENS,
  });

  const ctx = buildFoundationContext({ series, universe, canon, issues, contentMax });
  const result = await runFoundationJudgeStage(ctx, {
    returnsJson: true,
    providerOverride: judgeProvider.id,
    modelOverride: judgeModel,
    effortDefault: effort || effortDefault,
    onRunCreated,
    onRunSettled,
    source: STAGE,
  });

  const judge = sanitizeFoundationJudge(result.content);
  const weak = weakestDimension(judge.dimensions);
  const snapshot = {
    seriesId,
    universeId: series?.universeId || null,
    status: 'complete',
    sourceInputsHash: hash,
    providerId: result.providerId,
    model: result.model,
    judgeProviderId: judgeProvider.id,
    judgeModel: judgeModel || null,
    runId: result.runId,
    createdAt: existing?.createdAt || nowIso(),
    completedAt: nowIso(),
    weakest: weak ? weak.dimension : null,
    ...judge,
  };
  await saveSnapshot(snapshot);
  const actualProviderId = result.providerId || judgeProvider.id;
  const actualModel = result.model || judgeModel || '(default)';
  console.log(`🏛️ foundation judge — series=${seriesId.slice(0, 12)} weighted=${judge.weightedScore} target=${weak?.dimension || '—'}(${weak?.score ?? '—'}) via ${actualProviderId}/${actualModel}`);
  return snapshot;
}

/**
 * Load a series' stored foundation verdict with a `stale` flag. Returns null when
 * never judged.
 */
export async function getFoundationJudge(seriesId) {
  assertValidSeriesId(seriesId);
  const snap = await loadSnapshot(seriesId);
  if (!snap) return null;
  const series = await getSeries(seriesId).catch(() => null);
  const [universe, issues] = await Promise.all([
    series?.universeId ? getUniverse(series.universeId).catch(() => null) : null,
    series ? listIssues({ seriesId }).catch(() => null) : null,
  ]);
  const hash = series && issues ? foundationInputsHash(series, universe, issues) : null;
  return { ...snap, stale: hash ? isFoundationStale(snap, hash) : true };
}

const FOUNDATION_UNIVERSE_SNAPSHOT_FIELDS = Object.freeze([
  'logline', 'premise', 'styleNotes', 'influences', 'characters',
]);

const FOUNDATION_SERIES_SNAPSHOT_FIELDS = Object.freeze([
  'styleNotes', 'styleGuide', 'characterArcs',
]);

const pickFoundationFields = (record, fields) => Object.fromEntries(
  fields.map((field) => [
    field,
    record && Object.hasOwn(record, field) ? structuredClone(record[field]) : undefined,
  ]),
);

// Per-canon-entry fields the universe WRITE PATH owns, which a faithful restore
// therefore does NOT (and must not) bring back to the checkpoint value:
//   - `updatedAt` is re-stamped by `updateUniverse` on every canon entry whose
//     content changed vs the live record — and undoing a repair IS a content
//     change, so a correct revert always comes back with a fresh LWW clock (it
//     has to, or the canon→catalog projection would never carry the revert).
//   - the render/sheet pointers are deliberately preserved FROM the live record
//     (`mergePreservedSheetPointers` / `preserveImageRefsById`) so a sheet or
//     render that completed while the repair ran isn't thrown away by the undo.
// Comparing them made every faithful character rollback report itself as a
// failed restore, which stalled the foundation gate with a checkpoint-corruption
// warning that was never true. Authored content is still compared byte-for-byte.
const CANON_WRITE_PATH_OWNED_FIELDS = Object.freeze([
  'updatedAt', 'referenceSheetImageRef', 'referenceSheets', 'imageRefs',
]);

const comparableCanonEntry = (entry) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const rest = { ...entry };
  for (const field of CANON_WRITE_PATH_OWNED_FIELDS) delete rest[field];
  return rest;
};

// Walk EVERY canon array the bible defines, not just `characters`. The write
// path (`stampChangedCanonEntries` in universeBuilder/crud.js) stamps
// `updatedAt` across all of `BIBLE_KEYS`, so the moment a canon array beyond
// `characters` joins FOUNDATION_UNIVERSE_SNAPSHOT_FIELDS the same false
// "restored foundation fields did not match the checkpoint" pause would return.
const comparableUniverseFields = (universe) => {
  if (!universe || typeof universe !== 'object') return universe ?? null;
  const comparable = { ...universe };
  for (const key of BIBLE_KEYS) {
    if (Array.isArray(comparable[key])) comparable[key] = comparable[key].map(comparableCanonEntry);
  }
  return comparable;
};

// `undefined` (field absent from the record) is NOT the same as `null` — the
// restore skips absent fields, so a repair-added field the checkpoint never had
// is a genuine leftover the verification must still catch. The sentinel keeps
// the two distinguishable through JSON.
const comparablePart = (value) => (value === undefined ? '<absent>' : JSON.stringify(value ?? null));

/**
 * Field-keyed projection of a foundation snapshot for the post-restore check.
 * Keyed (rather than one blob) so a mismatch can NAME what failed to come back —
 * a bare "did not match" pause tells an operator nothing about what to inspect.
 */
const foundationSnapshotParts = (snapshot) => {
  const universe = comparableUniverseFields(snapshot?.universe);
  const parts = { universeId: comparablePart(snapshot?.universeId || null) };
  for (const field of FOUNDATION_UNIVERSE_SNAPSHOT_FIELDS) {
    parts[`universe.${field}`] = comparablePart(universe ? universe[field] : null);
  }
  for (const field of FOUNDATION_SERIES_SNAPSHOT_FIELDS) {
    parts[`series.${field}`] = comparablePart(snapshot?.series ? snapshot.series[field] : null);
  }
  parts.arc = comparablePart(snapshot?.arcState?.arc ?? null);
  parts.seasons = comparablePart(snapshot?.arcState?.seasons || []);
  parts.episodes = comparablePart(snapshot?.arcState?.episodes || []);
  return parts;
};

/** The snapshot fields that did NOT come back — [] when the restore was faithful. */
const mismatchedFoundationFields = (checkpoint, restored) => {
  const before = foundationSnapshotParts(checkpoint);
  const after = foundationSnapshotParts(restored);
  return Object.keys(before).filter((field) => before[field] !== after[field]);
};

/**
 * Capture every field an owned foundation repair may rewrite. Arc planning has
 * its own exact snapshot (including episode ideas); this adds the world,
 * character, and craft-owned records so the conductor can reject a repair that
 * a fresh judge proves did not earn its changes.
 */
export async function snapshotFoundationState(seriesId) {
  assertValidSeriesId(seriesId);
  const series = await getSeries(seriesId);
  const [universe, arcState] = await Promise.all([
    series?.universeId ? getUniverse(series.universeId).catch(() => null) : null,
    snapshotArcState(seriesId),
  ]);
  return {
    seriesId,
    universeId: series?.universeId || null,
    universe: universe ? pickFoundationFields(universe, FOUNDATION_UNIVERSE_SNAPSHOT_FIELDS) : null,
    series: pickFoundationFields(series, FOUNDATION_SERIES_SNAPSHOT_FIELDS),
    arcState,
  };
}

/**
 * Restore a foundation snapshot and verify the tracked fields match exactly.
 *
 * `judge` is the verdict that scored the checkpoint being restored. The cached
 * verdict on disk is keyed by a content hash, so after a rewind it describes
 * content that no longer exists and the next `judgeFoundation` pays a full LLM
 * call to re-derive a score this one already holds. Re-pinning it on a VERIFIED
 * restore puts the cache back in step with the content. Optional: a caller
 * without the pre-rewind verdict simply leaves the stale entry to self-
 * invalidate on its hash.
 */
export async function restoreFoundationState(seriesId, snapshot, { judge } = {}) {
  if (!snapshot || snapshot.seriesId !== seriesId || !snapshot.arcState) {
    return { restored: false, reason: 'invalid foundation snapshot' };
  }
  if (snapshot.universeId && snapshot.universe) {
    await updateUniverse(snapshot.universeId, Object.fromEntries(
      Object.entries(structuredClone(snapshot.universe)).filter(([, value]) => value !== undefined),
    ));
  }
  await updateSeries(seriesId, Object.fromEntries(
    Object.entries(structuredClone(snapshot.series)).filter(([, value]) => value !== undefined),
  ));
  const arcRestore = await restoreArcState(seriesId, snapshot.arcState);
  const restoredSnapshot = await snapshotFoundationState(seriesId);
  const mismatched = mismatchedFoundationFields(snapshot, restoredSnapshot);
  const restored = mismatched.length === 0;
  if (restored && judge?.seriesId === seriesId && judge.sourceInputsHash) {
    const { cached, ...verdict } = judge;
    await saveSnapshot(verdict);
  }
  return {
    restored,
    reason: restored
      ? null
      : `restored foundation fields did not match the checkpoint: ${mismatched.join(', ')}`,
    mismatchedFields: mismatched,
    episodesRestored: arcRestore.episodesRestored || 0,
  };
}

/**
 * Apply a fix for one foundation dimension through its OWNING service (never a
 * raw write; `force:false` everywhere so locked canon is a constraint, not a
 * target). Returns `{ applied, dimension, reason? }`.
 *
 * Routing:
 *   worldbuilding → universe world refine (expandWorldTemplate → updateUniverse)
 *   craft         → series voice/style repair (including concrete exemplars)
 *   character     → judge-directed core-cast framework + character-arc repair
 *   structure     → arc resolve (resolveVerifyIssues) with the judge's finding
 *
 * `finding` is the judge's `{ gap, fix }` for the targeted dimension, threaded
 * into the structure resolve as a synthesized arc finding.
 *
 * A retry after the caller REVERTED an earlier attempt at this same dimension
 * describes that attempt so this one changes strategy instead of re-proposing
 * discarded edits. It arrives on whichever channel the owning route has: the
 * prose `finding.retryReason` for the LLM-payload routes (character/craft's
 * finding JSON, worldbuilding's directive), and `avoidFindings` — the shared
 * "a previous attempt produced these, do not author them again" contract of
 * `resolveVerifyIssues` — for the structure route, so those stay OUT of the
 * work-to-close list a `suggestion` would have put them in.
 */
export async function applyFoundationFix(seriesId, dimension, {
  finding = {},
  avoidFindings,
  providerOverride,
  modelOverride,
  effortOverride,
  judgeProviderDefault,
  judgeModelDefault,
  judgeEffortDefault,
  judgeOnRunCreated,
  judgeOnRunSettled,
  preserveDroppedSeasons = false,
  onRunCreated,
  onRunSettled,
} = {}) {
  assertValidSeriesId(seriesId);
  const series = await getSeries(seriesId);
  const issues = await listIssues({ seriesId });
  const universeId = series?.universeId || null;
  const provider = {
    providerId: providerOverride,
    model: modelOverride,
    effort: effortOverride,
    finding,
    onRunCreated,
    onRunSettled,
  };

  if (dimension === 'worldbuilding') {
    const r = await refineWorld(universeId, provider);
    return { dimension, ...r };
  }

  if (dimension === 'craft') {
    const r = await repairCraft(series, issues, finding, provider);
    return { dimension, ...r };
  }

  if (dimension === 'character') {
    if (!universeId) return { dimension, applied: false, reason: 'no linked universe' };
    const universe = await getUniverse(universeId).catch(() => null);
    if (!universe) return { dimension, applied: false, reason: 'universe not found' };
    const r = await repairCharacters(series, issues, universe, finding, { ...provider, phase: 'post-arc reconciliation' });
    return { dimension, ...r };
  }

  if (dimension === 'structure') {
    // A locked arc is a constraint, not a fix target — resolveVerifyIssues throws
    // on a locked arc, which would error the whole run. Degrade to a graceful
    // "can't apply" so the gate pauses for human review instead (mirrors the
    // no-linked-universe / fully-locked-cast paths above).
    if (series?.locked?.arc === true) {
      return { dimension, applied: false, reason: 'arc is locked (a constraint, not a fix target)' };
    }
    // Synthesize an arc finding from the judge's structure gap/fix and route it
    // through the existing arc-resolve owning service.
    const findings = [{
      severity: 'high',
      location: 'arc',
      problem: finding.gap || 'arc structure is below the foundation-quality bar',
      suggestion: finding.fix || '',
    }];
    // Which episode synopses each rollback below may put back: the ones the
    // resolver reported writing after that checkpoint was taken, and nothing
    // else (see `createArcMutationLedger`). Without it, a repair that runs a
    // resolve plus up to MAX_STRUCTURE_CORRECTION_PASSES correct/verify pairs
    // reverted every episode `idea` that merely DIFFERED from its checkpoint —
    // including a write that landed from elsewhere across that whole window.
    // One ledger for the whole repair, because a checkpoint outlives the pass
    // that took it: rewinding to `bestVerified` has to undo every resolve since.
    const ledger = createArcMutationLedger();
    const takeSnapshot = async () => ledger.hold(await snapshotArcState(seriesId));
    const restoreTo = (checkpoint) => restoreArcState(seriesId, checkpoint, {
      episodeEdits: ledger.since(checkpoint),
    });
    const snapshot = await takeSnapshot();
    const structureRunIds = [];
    const resolveOptions = {
      providerDefault: providerOverride,
      modelDefault: modelOverride,
      // What a reverted earlier attempt at this dimension produced. The resolver
      // renders these in its own "do not author these again" block, apart from
      // the findings it must close (mirrors the arc gate's rollback retry).
      ...(Array.isArray(avoidFindings) && avoidFindings.length > 0 ? { avoid: avoidFindings } : {}),
      // The autopilot's unlock-for-run mode clears both `series.locked.arc`
      // (disarming the short-circuit above) and every per-season lock, so this
      // is the third arc-rewriting path that could otherwise delete a volume.
      // Carry the same non-deletion guarantee the other two do.
      preserveDroppedSeasons,
      effortDefault: effortOverride,
      onRunCreated: (runId) => {
        structureRunIds.push(runId);
        onRunCreated?.(runId);
      },
      onRunSettled,
    };
    const verifyOptions = {
      providerDefault: judgeProviderDefault,
      modelDefault: judgeModelDefault,
      effortDefault: judgeEffortDefault,
      onRunCreated: judgeOnRunCreated,
      onRunSettled: judgeOnRunSettled,
    };
    const trackedResolve = async (resolveFindings) => {
      const before = structureRunIds.length;
      const result = await resolveVerifyIssues(seriesId, { findings: resolveFindings, ...resolveOptions });
      ledger.note(resolvedEpisodeEdits(result));
      return { result, runIds: structureRunIds.slice(before) };
    };
    const runGuardedStructureRepair = async () => {
      const firstAttempt = await trackedResolve(findings);
      const first = firstAttempt.result;
      if (first?.applied === false) {
        return { dimension, applied: false, reason: first?.notes || 'arc resolver applied no change' };
      }

      let verification = await verifyArc(seriesId, verifyOptions);
      let blockers = Array.isArray(verification?.issues) ? verification.issues : [];
      if (blockers.length === 0) {
        return { dimension, applied: true, actions: 2, acceptedRunIds: firstAttempt.runIds };
      }

      const initialBlockers = blockers;
      let retainedRunIds = [...firstAttempt.runIds];
      let rejectedRunIds = [];
      let bestVerified = {
        blockers,
        snapshot: await takeSnapshot(),
        runIds: [...retainedRunIds],
      };

      // A foundation-directed structure rewrite can satisfy its broad judge
      // while accidentally violating a narrower canon/location/timing rule.
      // Keep correcting while the specialized verifier's severity profile improves.
      // A single all-or-nothing pass threw away demonstrated 10 → 3 progress and
      // forced the next run to rebuy all ten fixes. The bounded loop preserves
      // the original rollback guarantee, but spends up to three focused passes
      // when each one is moving monotonically toward a clean plan.
      let actions = 2;
      for (let pass = 0; pass < MAX_STRUCTURE_CORRECTION_PASSES && blockers.length > 0; pass += 1) {
        const before = blockers;
        const correctionAttempt = await trackedResolve(blockers);
        const correction = correctionAttempt.result;
        actions += 1;
        if (correction?.applied === false) break;
        verification = await verifyArc(seriesId, verifyOptions);
        actions += 1;
        const nextBlockers = Array.isArray(verification?.issues) ? verification.issues : [];
        blockers = nextBlockers;
        if (blockers.length === 0) {
          return {
            dimension,
            applied: true,
            actions,
            acceptedRunIds: [...retainedRunIds, ...correctionAttempt.runIds],
            rejectedRunIds,
          };
        }
        if (compareArcBlockers(blockers, before) > 0) {
          rejectedRunIds = [...rejectedRunIds, ...correctionAttempt.runIds];
          break;
        }
        retainedRunIds = [...retainedRunIds, ...correctionAttempt.runIds];
        if (compareArcBlockers(blockers, bestVerified.blockers) <= 0) {
          bestVerified = {
            blockers,
            snapshot: await takeSnapshot(),
            runIds: [...retainedRunIds],
          };
        }
      }

      // Do not throw away a demonstrated monotonic improvement merely because
      // the next correction traded its final residual for a larger set. Keep
      // the best independently verified checkpoint; the foundation judge will
      // still decide whether it improved structure, and the normal full-arc
      // gate remains latched dirty so it must close the residual before beats.
      if (compareArcBlockers(bestVerified.blockers, initialBlockers) < 0) {
        await restoreTo(bestVerified.snapshot);
        return {
          dimension,
          applied: true,
          partial: true,
          actions,
          reason: `structure repair retained its best verified improvement (${formatArcBlockerProfile(initialBlockers)} → ${formatArcBlockerProfile(bestVerified.blockers)}); the full arc gate must close the residual`,
          residual: bestVerified.blockers,
          discarded: blockers,
          acceptedRunIds: bestVerified.runIds,
          rejectedRunIds,
        };
      }

      await restoreTo(snapshot);
      return {
        dimension,
        applied: false,
        reverted: true,
        actions,
        reason: `structure repair left ${blockers.length} arc-verification blocker(s); reverted to the pre-repair plan`,
        // The blockers that condemned the rewrite. Without them the revert is a
        // bare count in prose, and the pause it raises reports dimension-level
        // gaps instead — a different set entirely — so the user is never shown
        // why a plausible rewrite was thrown away.
        discarded: blockers,
        rejectedRunIds: structureRunIds,
      };
    };
    // Any provider/parse failure after the first mutation must not strand the
    // series in the unverified intermediate draft. Restore, then preserve the
    // original error so the conductor pauses with the real provider diagnosis.
    return runGuardedStructureRepair().catch(async (err) => {
      await restoreTo(snapshot);
      throw err;
    });
  }

  return { dimension, applied: false, reason: `unknown dimension: ${dimension}` };
}

export const __testing = {
  sanitizeFoundationJudge,
  foundationInputs,
  contentHash,
  isFoundationStale,
  buildFoundationContext,
  renderArc,
  renderWorldFoundation,
  renderCharacterLine,
  renderRepairSeriesJson,
  renderRepairCharactersJson,
  REPAIR_OUTLINE_MAX_CHARS,
  REPAIR_SERIES_MAX_CHARS,
  REPAIR_CHARACTERS_MAX_CHARS,
  CHARACTER_FOUNDATION_TIMEOUT_MS,
  CHARACTER_FOUNDATION_BATCH_SIZE,
  FRAMEWORK_STRING_FIELDS,
  PROFILE_STRING_FIELDS,
  mismatchedFoundationFields,
  comparableUniverseFields,
  CANON_WRITE_PATH_OWNED_FIELDS,
};
