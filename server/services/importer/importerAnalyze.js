/** Classifies manuscript content and builds an import preview through staged analysis. */

import { runStagedLLM } from '../stageRunner.js';
import { listUniverses, createUniverse, deleteUniverse } from '../universeBuilder.js';
import { listSeries, createSeries } from '../pipeline/series.js';
import { ARC_SHAPE_IDS, ARC_ROLES } from '../../lib/storyArc.js';
import { IMPORTER_PROSE_EXCERPT_MAX } from '../../lib/creativeDirectorValidation.js';
import { CLASSIFY_SOURCE_HEAD_CHARS, IMPORTER_CONTENT_TYPES, IMPORTER_SOURCE_CHAR_LIMIT } from '../../lib/importerContentTypes.js';
import { isStr } from '../../lib/textUtils.js';
import { deriveImportId, SESSION_STATUS } from '../importerSessions.js';
import { codedError } from '../../lib/codedError.js';
import { ERR_VALIDATION, ERR_LOCKED } from './importerErrors.js';
import { splitComicScriptIssues } from './importerComicSplit.js';
import { resolveImportSession } from './importerSessionState.js';
import { makeImporterProgressEmitter } from '../importerEvents.js';

// Ordered stages surfaced to the client's live progress checklist during the
// analyze phase. Emitted in the `start` frame so the client renders the list
// without hardcoding (and drifting from) it; each stage then flips to
// `running`/`done` via `stage` frames. `canon` + `arc` run in parallel — both
// go `running` together, then resolve independently.
export const ANALYZE_STAGES = [
  { id: 'canon', label: 'Extracting canon (characters, places, objects)' },
  { id: 'arc', label: 'Extracting story arc & seasons' },
  { id: 'issues', label: 'Proposing issue split' },
];

// Each analyze stage feeds the ENTIRE source corpus (tens of thousands of
// chars) to a heavy-tier model in one shot, so the toolkit's 5-min default
// (DEFAULT_TIMEOUT) is too tight — a false timeout triggers an expensive
// from-scratch fallback re-run. 20 min gives real headroom while staying
// under the toolkit's configurable MAX_TIMEOUT ceiling. Passed as `timeoutOverride`
// on every analyze stage call.
export const ANALYZE_STAGE_TIMEOUT_MS = 1_200_000;

// Per-content-type defaults when the user doesn't pass `targetIssueCount`.
// `null` means "let the LLM decide" — short stories collapse to one; novels
// honor chapter boundaries; screenplays default to a single episode; comic
// scripts use explicit ISSUE headers or ~22-page bundles.
const DEFAULT_TARGET_ISSUE_COUNT_HINT = Object.freeze({
  'short-story': 1,
  'novel': null,
  'screenplay': 1,
  'comic-script': null,
});

const normName = (s) => String(s || '').trim().toLowerCase();

// Required + oversized-ceiling guard for the source corpus. Shared by
// analyze / classify / retry-issues so the check and its (verbatim) error
// message live in one place.
function assertSourceWithinLimit(source) {
  if (!isStr(source) || !source.trim()) {
    throw codedError('source is required', ERR_VALIDATION);
  }
  if (source.length > IMPORTER_SOURCE_CHAR_LIMIT) {
    throw codedError(
      `Source is ${source.length.toLocaleString()} chars — exceeds the ${IMPORTER_SOURCE_CHAR_LIMIT.toLocaleString()}-char ceiling. Trim the source or wait for chunked-extraction support.`,
      ERR_VALIDATION,
    );
  }
}

// Per-content-type Mustache section-guard booleans — the prompt templates use
// `{{#isComicScript}}…{{/isComicScript}}` blocks (Mustache, not Liquid), so we
// expose presence flags rather than the raw contentType string.
const buildTypeFlags = (contentType) => ({
  isShortStory: contentType === 'short-story',
  isNovel: contentType === 'novel',
  isScreenplay: contentType === 'screenplay',
  isComicScript: contentType === 'comic-script',
});

// Shared per-call options for the analyze-tier staged LLM calls. Returns a
// FRESH object each call so the parallel canon + arc invocations can't leak
// bookkeeping state across each other, and keeps the source tag + extended
// timeout in lock-step across analyze and retry-issues.
const analyzeLlmOpts = (providerOverride, modelOverride) => ({
  providerOverride,
  modelOverride,
  source: 'importer-analyze',
  returnsJson: true,
  timeoutOverride: ANALYZE_STAGE_TIMEOUT_MS,
});

// Build the "existing canon" prompt block in JS rather than as a Mustache
// `{{#section}}{{{var}}}{{/section}}` so the user-supplied canon JSON
// passes through the template engine's TRIPLE_RE substitution exactly
// once (after the section-resolution loop has settled). Substituting a
// JSON-stringified value that contains `{{spoilers}}` *inside* a section
// would otherwise let the outer SECTION/VAR loop re-interpret the
// braces as template tokens.
function buildExistingCanonBlock(existingCanon) {
  if (!existingCanon) return '';
  const json = JSON.stringify(existingCanon, null, 2);
  // Wrap in a tilde fence (`~~~`) rather than triple-backticks — user
  // canon content (stylized character names, lyric titles, pasted
  // markdown from a prior import) can legitimately contain ``` and
  // would otherwise close our fence early, corrupting the prompt.
  // Tildes are exceedingly rare in fiction prose; if they ever collide,
  // a longer tilde run (`~~~~`) is the escape hatch.
  return [
    '## Existing universe canon (do NOT duplicate these by name or aliases)',
    '',
    'This universe already has some canonical entries. Match by `name` (case-insensitive) **and by any listed `aliases`**. If an existing entry covers the same character / place / object, **omit it entirely** from your output — return only NEW entries. (Evidence for existing entries from this source is not currently re-merged; downstream evidence backfill is a follow-up.)',
    '',
    '~~~json',
    json,
    '~~~',
    '',
  ].join('\n');
}

/**
 * Find a universe by case-insensitive name match. Returns `null` when no
 * match — the caller decides to create. Exported for the test surface.
 */
export async function findUniverseByName(name) {
  const target = normName(name);
  if (!target) return null;
  const all = await listUniverses();
  return all.find((u) => normName(u.name) === target) || null;
}

/**
 * Find a series by case-insensitive name match, scoped to a specific
 * universe. A name match in a DIFFERENT universe returns `null` — see the
 * design doc's "Find-or-Create Logic" section.
 */
export async function findSeriesByName(name, universeId) {
  const target = normName(name);
  if (!target) return null;
  // Guard universeId too — without this, a falsy/missing universeId
  // would match every series with a falsy `universeId` on disk, which
  // breaks the "scoped to a specific universe" contract. Today's only
  // caller in analyzeImport skips this lookup entirely when the universe
  // doesn't exist yet, but this is exported for tests + future callers.
  if (typeof universeId !== 'string' || !universeId) return null;
  const all = await listSeries();
  return all.find((s) =>
    normName(s.name) === target && s.universeId === universeId,
  ) || null;
}

/**
 * Render the existing universe canon as a compact JSON block so the
 * canon-extract LLM can dedup by name before returning. Drops fields that
 * inflate the prompt without informing the dedup decision (imageRefs,
 * timestamps, ids).
 */
// Fields that must serialize as arrays in the prompt JSON — a non-array
// truthy value (defensive against malformed on-disk data) would otherwise
// reach the LLM as a scalar and break dedup matching.
const COMPACT_ARRAY_FIELDS = new Set(['aliases']);

function compactCanonForPrompt(universe) {
  const slim = (entry, fields) => {
    const out = {};
    for (const k of fields) {
      const v = entry[k];
      if (v == null || v === '') continue;
      if (COMPACT_ARRAY_FIELDS.has(k)) {
        if (!Array.isArray(v) || v.length === 0) continue;
      } else if (Array.isArray(v) && v.length === 0) {
        continue;
      }
      out[k] = v;
    }
    return out;
  };
  // Aliases are exposed for every kind so the LLM's dedup matching aligns
  // with the server-side merge keys (`mergeExtractedBible` dedups by name +
  // aliases). Omitting aliases for any kind would let the LLM return an
  // entry the merge layer treats as a duplicate, just with the new source's
  // name variant.
  const characters = (universe.characters || []).map((c) =>
    slim(c, ['name', 'aliases', 'role', 'physicalDescription']));
  const places = (universe.places || []).map((p) =>
    slim(p, ['name', 'aliases', 'slugline', 'description']));
  const objects = (universe.objects || []).map((o) =>
    slim(o, ['name', 'aliases', 'description']));
  if (!characters.length && !places.length && !objects.length) return null;
  return { characters, places, objects };
}

/**
 * Build a sanitized arc preview from a raw LLM arc response. Whitelists the
 * known fields (matching `importerArcShape` in creativeDirectorValidation.js) so hallucinated
 * or future extra keys never silently reach the client or commit path. Also
 * validates `shape` against `ARC_SHAPE_IDS` — an invalid/misspelled shape is
 * dropped to `null` so the UI renders "— pick one —" immediately rather than
 * hiding the error until Zod rejects it at commit time.
 * Threads B + C combined.
 */
function buildArcPreview(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const shape = isStr(raw.shape) && ARC_SHAPE_IDS.includes(raw.shape) ? raw.shape : null;
  return {
    logline: isStr(raw.logline) ? raw.logline : null,
    summary: isStr(raw.summary) ? raw.summary : null,
    protagonistArc: isStr(raw.protagonistArc) ? raw.protagonistArc : null,
    themes: Array.isArray(raw.themes) ? raw.themes : [],
    shape,
  };
}

/**
 * Propose the issue split for a source. Comic scripts try the mechanical
 * header split first (verbatim, no LLM); everything else — and header-less
 * comics — fall through to the staged `importer-issue-proposal` LLM call.
 * Shared by `analyzeImport` and the retry-issues route so both honor the
 * mechanical path identically.
 *
 * Returns `{ issues, runId, method }` where `method` is `'mechanical'`
 * (runId null) or `'llm'`.
 */
async function proposeIssues({ seriesName, contentType, source, typeFlags, arcSummary, targetIssueCount, userRequestedCount, llmOpts }) {
  if (contentType === 'comic-script') {
    const mechanical = splitComicScriptIssues(source, {
      targetIssueCount: userRequestedCount ? targetIssueCount : null,
    });
    if (mechanical && mechanical.length > 0) {
      // A verbatim issue can exceed the commit-time proseExcerpt ceiling.
      // Fail HERE (analyze/retry) with an actionable message instead of
      // letting it sail through to a confusing commit-time 400.
      const oversized = mechanical.findIndex((iss) => iss.proseExcerpt.length > IMPORTER_PROSE_EXCERPT_MAX);
      if (oversized !== -1) {
        throw codedError(
          `Issue ${oversized + 1} of the comic split is ${mechanical[oversized].proseExcerpt.length.toLocaleString()} chars — over the ${IMPORTER_PROSE_EXCERPT_MAX.toLocaleString()}-char per-issue limit. Add ISSUE/PAGE headers so it splits into smaller issues, or split the source.`,
          ERR_VALIDATION,
        );
      }
      console.log(`📚 importer: split comic script into ${mechanical.length} issue(s) on existing headers (no LLM rewrite)`);
      return { issues: mechanical, runId: null, method: 'mechanical' };
    }
  }
  const issueCountHint = userRequestedCount
    ? targetIssueCount
    : DEFAULT_TARGET_ISSUE_COUNT_HINT[contentType];
  const issuesRun = await runStagedLLM('importer-issue-proposal', {
    seriesName,
    contentType,
    source,
    ...typeFlags,
    arcSummary,
    // `targetIssueCount` (number) is the value the prompt interpolates;
    // `isUserRequestedCount` (boolean) gates the "user-requested — produce
    // exactly this many" copy vs the softer "default for this type" copy so
    // a per-type hint isn't presented as a hard user constraint.
    targetIssueCount: issueCountHint,
    isUserRequestedCount: userRequestedCount,
  }, llmOpts);
  return {
    issues: Array.isArray(issuesRun.content?.issues) ? issuesRun.content.issues : [],
    runId: issuesRun.runId,
    method: 'llm',
  };
}

const CLASSIFIER_CONFIDENCES = new Set(['high', 'medium', 'low']);
/**
 * Lightweight pre-pass that classifies a source's content type so the
 * Importer intake form can pre-select the radio (still user-editable).
 * Runs at light tier, sees only the head of the source — costs are
 * negligible compared to the three heavy-tier extractors in analyzeImport.
 *
 * Returns `{ contentType, confidence, reasoning }`. A hallucinated /
 * out-of-enum `contentType` is dropped to `null` so the client can fall
 * back to its default radio without rendering nonsense; `confidence` is
 * gated similarly. The reasoning string is passed through verbatim so the
 * UI can show it in a tooltip beside the auto-pick.
 */
export async function classifyImportContent({ source, providerOverride, modelOverride } = {}) {
  assertSourceWithinLimit(source);
  const sourceHead = source.slice(0, CLASSIFY_SOURCE_HEAD_CHARS);
  const run = await runStagedLLM('importer-classify', { sourceHead }, {
    providerOverride,
    modelOverride,
    source: 'importer-classify',
    returnsJson: true,
  });
  const raw = (typeof run.content === 'object' && run.content !== null) ? run.content : {};
  const contentType = isStr(raw.contentType) && IMPORTER_CONTENT_TYPES.includes(raw.contentType) ? raw.contentType : null;
  const confidence = isStr(raw.confidence) && CLASSIFIER_CONFIDENCES.has(raw.confidence) ? raw.confidence : null;
  const reasoning = isStr(raw.reasoning) ? raw.reasoning.slice(0, 500) : null;
  return {
    contentType,
    confidence,
    reasoning,
    runId: run.runId,
    providerId: run.providerId,
    model: run.model,
  };
}

// A finished import whose receipt was lost (#10762) is reported as committed
// only once its import-draft shells are promoted: until then the client must
// still send the commit, which replays the issues and promotes them — a client
// that took `committed` at its word would skip that and strand the drafts.
const summarizeImportSession = (session, { universe, series }) => {
  if (!session) return null;
  if (session.receiptPending && (universe.importDraft === true || series.importDraft === true)) {
    return { status: SESSION_STATUS.ARC_PERSISTED, createdIssueIds: [] };
  }
  return { status: session.status, createdIssueIds: session.createdIssueIds };
};

/**
 * Phase 1: analyze. Runs canon-extract + arc-extract in parallel (both read
 * source independently); after arc resolves, runs issue-proposal with the
 * arc summary in scope so the issue boundaries align with the arc's beats.
 *
 * Returns a fully-shaped preview the client can render in the Review
 * phase. Nothing canonical (arc, seasons, issues) is persisted yet — only
 * the find-or-created universe + series exist on disk so the commit phase
 * has stable ids to reference.
 *
 * Partial-failure safety: universe + series are NOT written to disk until
 * after the canon + arc passes succeed. A failure in either of those leaves
 * no orphaned half-created records behind (the function throws before any
 * create). The issue split, by contrast, is non-fatal — canon + arc are the
 * expensive passes, so a split timeout/parse error sets `issueSplitFailed`
 * and still returns the canon + arc preview (with universe + series shells
 * persisted) so the client can retry ONLY the split via `retryIssueSplit`.
 */
export async function analyzeImport({
  universeName,
  seriesName,
  contentType,
  source,
  providerOverride,
  modelOverride,
  targetIssueCount,
} = {}) {
  if (!isStr(universeName) || !universeName.trim()) {
    throw codedError('universeName is required', ERR_VALIDATION);
  }
  if (!isStr(seriesName) || !seriesName.trim()) {
    throw codedError('seriesName is required', ERR_VALIDATION);
  }
  assertSourceWithinLimit(source);

  // Look up pre-existing records WITHOUT creating anything yet. Creation is
  // deferred until after all LLM calls succeed so a failure above never
  // leaves orphaned data on disk.
  const existingUniverse = await findUniverseByName(universeName);
  const isExistingUniverse = existingUniverse !== null;

  // Series lookup requires a universe id. For new universes we skip the
  // series lookup — there can't be an existing series in a universe that
  // doesn't exist yet.
  const existingSeries = isExistingUniverse
    ? await findSeriesByName(seriesName, existingUniverse.id)
    : null;
  const isExistingSeries = existingSeries !== null;

  // If the user re-runs the importer on a series whose arc is locked, fail
  // FAST — no point spending heavy-tier tokens to extract an arc the commit
  // phase will refuse to apply.
  if (existingSeries?.locked?.arc === true) {
    throw codedError(
      `Series "${existingSeries.name}" has a locked arc. Unlock it on the Arc Canvas before importing — or rename the import's series so a fresh series is created.`,
      ERR_LOCKED,
    );
  }

  // Build the existing-canon prompt hint from the pre-existing universe (if
  // any). For a brand-new universe this is null — the LLM gets no prior
  // context, which is correct.
  const existingCanon = existingUniverse ? compactCanonForPrompt(existingUniverse) : null;

  // returnsJson gates extractJson() in stageRunner — required even though
  // the stage-config also declares `returnsJson: true` (that field is
  // metadata for the Prompts UI; the runtime only consults the per-call
  // option). `analyzeLlmOpts` returns a FRESH object each call so a future
  // runner that adds bookkeeping can't leak state across our parallel
  // canon + arc invocations.
  const buildLlmOpts = () => analyzeLlmOpts(providerOverride, modelOverride);

  // Live stage progress (see ANALYZE_STAGES). `runId` lets the client ignore
  // stragglers from a prior run. Emitting is best-effort UI sugar — never let
  // a listener throw abort the extraction, so swallow + log at this boundary.
  // `emitImporterProgress` records each frame into the live snapshot before
  // broadcasting so a socket that (re)connects mid-analyze can be replayed the
  // checklist (see importerEvents.js / socket.js).
  const { emitProgress } = makeImporterProgressEmitter();
  const emitStage = (id, status) => emitProgress({ type: 'stage', id, status });
  emitProgress({ type: 'start', stages: ANALYZE_STAGES });

  // `proposeIssues` derives the per-type issue-count hint internally; analyze
  // only needs the boolean to forward.
  const userRequestedCount = Number.isFinite(targetIssueCount) && targetIssueCount > 0;

  // Per-type Mustache section-guard booleans (see buildTypeFlags).
  const typeFlags = buildTypeFlags(contentType);

  // Use the known persisted name for prompt variables when the record
  // already exists; fall back to the trimmed input for new records.
  const promptUniverseName = existingUniverse?.name ?? universeName.trim();
  const promptSeriesName = existingSeries?.name ?? seriesName.trim();

  // Canon + arc are independent reads of the same source — fire in
  // parallel. Issue-proposal depends on the arc summary, so chain after
  // arc resolves.
  emitStage('canon', 'running');
  emitStage('arc', 'running');
  // `.then` on each promise flips its stage to `done` the moment that pass
  // resolves — Promise.all alone would only report after BOTH finish, which
  // would make the slower of the two appear stalled in the checklist.
  const [canonRun, arcRun] = await Promise.all([
    runStagedLLM('importer-canon-extract', {
      universeName: promptUniverseName,
      seriesName: promptSeriesName,
      contentType,
      source,
      existingCanonBlock: buildExistingCanonBlock(existingCanon),
      ...typeFlags,
    }, buildLlmOpts()).then((r) => { emitStage('canon', 'done'); return r; }),
    runStagedLLM('importer-arc-extract', {
      seriesName: promptSeriesName,
      contentType,
      source,
      ...typeFlags,
    }, buildLlmOpts()).then((r) => { emitStage('arc', 'done'); return r; }),
  ]);

  // Pull the arc summary in before issue-proposal so the issue boundaries
  // align with the arc's act structure. Falls back to logline if summary
  // is empty (older / smaller models sometimes return just logline).
  const arcContent = (typeof arcRun.content === 'object' && arcRun.content !== null)
    ? arcRun.content
    : {};
  // Warn when the LLM returned a structurally-successful arc with empty
  // summary AND empty logline — a regression silently dropping both fields
  // would otherwise present as a healthy import with a synthetic placeholder
  // arc summary downstream.
  if (!arcContent.summary && !arcContent.logline) {
    console.warn(`⚠️ importer arc extract returned empty summary+logline for "${promptSeriesName}" — using synthetic fallback`);
  }
  const arcSummary = arcContent.summary || arcContent.logline || `${promptSeriesName} — ${contentType}`;

  emitStage('issues', 'running');
  // Issue split tolerates failure: canon + arc are the expensive passes and
  // they already succeeded, so a timeout / parse error on the split must NOT
  // throw them away. On failure we flag `issueSplitFailed` and return the
  // canon + arc preview anyway — the client offers a "retry issue split" that
  // re-runs ONLY this pass (see POST /api/importer/retry-issues). Comic
  // scripts take the mechanical header split first (no LLM), which both
  // sidesteps the timeout and preserves verbatim panel/dialogue text.
  let issueProposals = [];
  let issuesRunId = null;
  let issueSplitFailed = false;
  let issueSplitError = null;
  const issueResult = await proposeIssues({
    seriesName: promptSeriesName,
    contentType,
    source,
    typeFlags,
    arcSummary,
    targetIssueCount,
    userRequestedCount,
    llmOpts: buildLlmOpts(),
  }).catch((err) => {
    issueSplitFailed = true;
    issueSplitError = err?.message || String(err);
    console.error(`❌ importer issue split failed (canon+arc preserved): ${issueSplitError}`);
    return null;
  });
  if (issueResult) {
    issueProposals = issueResult.issues;
    issuesRunId = issueResult.runId;
    emitStage('issues', 'done');
  } else {
    emitStage('issues', 'error');
  }

  // Canon + arc succeeded — persist any new records so the preview has stable
  // ids the client can commit/retry against. The issue split may have failed
  // (issueSplitFailed); that's surfaced to the client, not fatal. Pre-existing
  // records are returned as-is.
  //
  // Thread A: wrap the two-step create in a try/catch so a `createSeries`
  // failure doesn't leave an orphaned universe on disk. We only delete the
  // universe if we created it in this call — a pre-existing universe must
  // never be removed as a side-effect of a series-create failure.
  //
  // New shells are created as import drafts (issue #727): an analyze the user
  // abandons before commit otherwise leaves a zero-issue/zero-canon universe
  // + series lingering on disk. `ephemeral` keeps them out of every sync
  // transport; `importDraft` is the dedicated GC marker that distinguishes an
  // abandoned analyze from a user's deliberately-private empty record (which
  // is also `ephemeral`) — so the orphan-shell GC sweep (importerOrphanGc.js)
  // only ever touches genuine import shells. `commitImport` clears both flags
  // so a committed import becomes a normal, syncing record. Pre-existing
  // records are never re-flagged here.
  let universe = isExistingUniverse
    ? existingUniverse
    : await createUniverse({ name: universeName.trim(), ephemeral: true, importDraft: true });
  const universeWasCreated = !isExistingUniverse;

  let series;
  try {
    series = isExistingSeries
      ? existingSeries
      : await createSeries({ name: seriesName.trim(), universeId: universe.id, ephemeral: true, importDraft: true });
  } catch (seriesErr) {
    if (universeWasCreated) {
      await deleteUniverse(universe.id).catch((delErr) =>
        console.error(`❌ analyzeImport rollback: failed to delete orphaned universe ${universe.id}: ${delErr.message}`),
      );
    }
    throw seriesErr;
  }

  const arcPreview = buildArcPreview(arcRun.content);

  // Progress this manuscript's earlier commit left behind (#9943). A series
  // created a moment ago has none, so only a pre-existing one is looked up. The
  // id travels back on commit; `importSession` tells the client to resume
  // instead of re-sending a payload the server already applied.
  const importId = deriveImportId({ seriesId: series.id, source });
  // Best-effort here: an unreadable ledger must not throw away the canon + arc
  // passes that just ran. The commit reads it again and refuses on its own.
  const importSession = isExistingSeries
    ? await resolveImportSession(importId, series.id).catch((err) => {
        console.error(`❌ importer session lookup failed for series ${series.id}: ${err.message}`);
        return null;
      })
    : null;

  // Terminal frame: clears the live snapshot so a tab that opens after this
  // run finishes isn't replayed a stale (all-done) checklist. A throw before
  // here (an LLM timeout on canon/arc, a series-create failure) leaves the
  // snapshot in place; that's benign — the client only renders the checklist
  // while its own analyze request is in flight, and the next run's `start`
  // frame overwrites the snapshot.
  emitProgress({ type: 'done' });

  return {
    universe,
    series,
    isExistingUniverse,
    isExistingSeries,
    importId,
    importSession: summarizeImportSession(importSession, { universe, series }),
    canonPreview: {
      characters: Array.isArray(canonRun.content?.characters) ? canonRun.content.characters : [],
      places: Array.isArray(canonRun.content?.places) ? canonRun.content.places : [],
      objects: Array.isArray(canonRun.content?.objects) ? canonRun.content.objects : [],
    },
    arcPreview,
    seasonsPreview: Array.isArray(arcRun.content?.seasons) ? arcRun.content.seasons : [],
    issueProposals,
    // True when the issue split failed after canon+arc succeeded — the client
    // shows a "retry issue split" affordance instead of throwing the run away.
    issueSplitFailed,
    issueSplitError,
    runIds: {
      canon: canonRun.runId,
      arc: arcRun.runId,
      issues: issuesRunId,
    },
    providerId: canonRun.providerId,
    model: canonRun.model,
    // Server-canonical constants surfaced to the client so it doesn't have to
    // hardcode (and silently drift from) them. The intake form's char-count
    // warning + the review form's arc-role dropdown both read these.
    limits: {
      sourceCharLimit: IMPORTER_SOURCE_CHAR_LIMIT,
    },
    arcRoles: [...ARC_ROLES],
    // Surface the server's recognized arc-shape ids so the client can filter
    // its local `STORY_SHAPES` metadata (display labels + sparkline points)
    // against what the server will accept on commit. Avoids drift when
    // shapes are added/removed server-side without a client redeploy.
    arcShapeIds: [...ARC_SHAPE_IDS],
  };
}

/**
 * Re-run ONLY the issue split — the recovery path when `analyzeImport`
 * returned `issueSplitFailed: true` (canon + arc succeeded, the split timed
 * out / failed). Re-extracting canon + arc would burn the two expensive
 * passes again, so this re-runs just the split against the same source, with
 * the arc summary the user already has in the Review panel for alignment.
 * Comic scripts take the mechanical header path first (see `proposeIssues`).
 */
export async function retryIssueSplit({
  contentType,
  source,
  seriesName,
  arcSummary,
  targetIssueCount,
  providerOverride,
  modelOverride,
} = {}) {
  assertSourceWithinLimit(source);
  if (!IMPORTER_CONTENT_TYPES.includes(contentType)) {
    throw codedError(`Unknown contentType "${contentType}"`, ERR_VALIDATION);
  }
  const userRequestedCount = Number.isFinite(targetIssueCount) && targetIssueCount > 0;
  const promptSeriesName = isStr(seriesName) && seriesName.trim() ? seriesName.trim() : 'the series';
  const result = await proposeIssues({
    seriesName: promptSeriesName,
    contentType,
    typeFlags: buildTypeFlags(contentType),
    source,
    // Fall back to a synthetic summary so the LLM prompt always has the
    // {{arcSummary}} var (the mechanical comic path ignores it entirely).
    arcSummary: isStr(arcSummary) && arcSummary.trim() ? arcSummary : `${promptSeriesName} — ${contentType}`,
    targetIssueCount,
    userRequestedCount,
    llmOpts: analyzeLlmOpts(providerOverride, modelOverride),
  });
  return { issueProposals: result.issues, method: result.method, runId: result.runId };
}
