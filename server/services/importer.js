/**
 * Pipeline — Importer Service
 *
 * Reverse-engineers a finished short story / novel / screenplay / comic
 * script into universe canon + series arc + prose-seeded issues.
 *
 * Canon kind mapping: the prompts + wire shape use the forward-looking
 * `places` label (matches the in-flight Phase 0b SETTING→PLACE rename),
 * but the on-disk universe schema still stores them under `settings`.
 * Mapping happens at the orchestrator boundary so the UI + LLM never see
 * the legacy field name.
 */

import { runStagedLLM } from '../lib/stageRunner.js';
import {
  listUniverses,
  getUniverse,
  createUniverse,
  updateUniverse,
  deleteUniverse,
} from './universeBuilder.js';
import {
  listSeries,
  getSeries,
  createSeries,
  updateSeries,
} from './pipeline/series.js';
import { createIssue, deleteIssue } from './pipeline/issues.js';
import { sanitizeArc, sanitizeSeasonList, buildSeason, ARC_SHAPE_IDS, ARC_ROLES } from '../lib/storyArc.js';
import { mergeExtractedBible, BIBLE_KIND } from '../lib/storyBible.js';

// Surfaced to the route layer so the importer's policy errors become 400s
// with stable codes.
export const ERR_VALIDATION = 'IMPORTER_VALIDATION';
export const ERR_LOCKED = 'IMPORTER_LOCKED';
// Thrown when the issue-loop fails mid-flight after universe + series writes
// already landed. Universe/series are preserved; the partial issue set is
// rolled back. Retrying commit is safe (merges are idempotent).
export const ERR_PARTIAL_COMMIT_ISSUES = 'IMPORTER_PARTIAL_COMMIT_ISSUES';

const makeErr = (message, code) => Object.assign(new Error(message), { code });

// v1 hard cap on the source corpus. Big novels run ~500K chars; this keeps
// us under most providers' single-call context limit until the chunked
// fallback follow-up lands (PLAN.md / "Create Suite — Importer page").
export const IMPORTER_SOURCE_CHAR_LIMIT = 200_000;

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
const isStr = (v) => typeof v === 'string';

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
  return [
    '## Existing universe canon (do NOT duplicate these by name or aliases)',
    '',
    'This universe already has some canonical entries. Match by `name` (case-insensitive) **and by any listed `aliases`**. If an existing entry covers the same character / place / object, **omit it entirely** from your output — return only NEW entries. (Evidence for existing entries from this source is not currently re-merged; downstream evidence backfill is a follow-up.)',
    '',
    '```json',
    json,
    '```',
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
function compactCanonForPrompt(universe) {
  const slim = (entry, fields) => {
    const out = {};
    for (const k of fields) {
      const v = entry[k];
      if (v == null || v === '') continue;
      if (Array.isArray(v) && v.length === 0) continue;
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
  const places = (universe.settings || []).map((s) =>
    slim(s, ['name', 'aliases', 'slugline', 'description']));
  const objects = (universe.objects || []).map((o) =>
    slim(o, ['name', 'aliases', 'description']));
  if (!characters.length && !places.length && !objects.length) return null;
  return { characters, places, objects };
}

/**
 * Build a sanitized arc preview from a raw LLM arc response. Whitelists the
 * known fields (matching `importerArcShape` in validation.js) so hallucinated
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
 * Phase 1: analyze. Runs canon-extract + arc-extract in parallel (both read
 * source independently); after arc resolves, runs issue-proposal with the
 * arc summary in scope so the issue boundaries align with the arc's beats.
 *
 * Returns a fully-shaped preview the client can render in the Review
 * phase. Nothing canonical (arc, seasons, issues) is persisted yet — only
 * the find-or-created universe + series exist on disk so the commit phase
 * has stable ids to reference.
 *
 * Partial-failure safety (Thread A): universe + series are NOT written to
 * disk until after all three LLM calls succeed. Pre-existing records are
 * looked up first; new records are persisted only at the end. A network
 * timeout or parse failure during any LLM stage therefore leaves no
 * orphaned half-created records behind.
 */
export async function analyzeImport({
  universeName,
  seriesName,
  contentType,
  source,
  providerOverride,
  targetIssueCount,
} = {}) {
  if (!isStr(universeName) || !universeName.trim()) {
    throw makeErr('universeName is required', ERR_VALIDATION);
  }
  if (!isStr(seriesName) || !seriesName.trim()) {
    throw makeErr('seriesName is required', ERR_VALIDATION);
  }
  if (!isStr(source) || !source.trim()) {
    throw makeErr('source is required', ERR_VALIDATION);
  }
  if (source.length > IMPORTER_SOURCE_CHAR_LIMIT) {
    throw makeErr(
      `Source is ${source.length.toLocaleString()} chars — v1 limit is ${IMPORTER_SOURCE_CHAR_LIMIT.toLocaleString()}. Trim the source or wait for chunked-extraction support.`,
      ERR_VALIDATION,
    );
  }

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
    throw makeErr(
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
  // option).
  const llmOpts = { providerOverride, source: 'importer-analyze', returnsJson: true };

  const userRequestedCount = Number.isFinite(targetIssueCount) && targetIssueCount > 0;
  const issueCountHint = userRequestedCount
    ? targetIssueCount
    : DEFAULT_TARGET_ISSUE_COUNT_HINT[contentType];

  // Per-type booleans for the Mustache section guards in the prompt
  // templates (PortOS's template engine is Mustache, not Liquid — no
  // `{% if x == 'y' %}` support, so we expose presence flags instead).
  const typeFlags = {
    isShortStory: contentType === 'short-story',
    isNovel: contentType === 'novel',
    isScreenplay: contentType === 'screenplay',
    isComicScript: contentType === 'comic-script',
  };

  // Use the known persisted name for prompt variables when the record
  // already exists; fall back to the trimmed input for new records.
  const promptUniverseName = existingUniverse?.name ?? universeName.trim();
  const promptSeriesName = existingSeries?.name ?? seriesName.trim();

  // Canon + arc are independent reads of the same source — fire in
  // parallel. Issue-proposal depends on the arc summary, so chain after
  // arc resolves.
  const [canonRun, arcRun] = await Promise.all([
    runStagedLLM('importer-canon-extract', {
      universeName: promptUniverseName,
      seriesName: promptSeriesName,
      contentType,
      source,
      existingCanonBlock: buildExistingCanonBlock(existingCanon),
      ...typeFlags,
    }, llmOpts),
    runStagedLLM('importer-arc-extract', {
      seriesName: promptSeriesName,
      contentType,
      source,
      ...typeFlags,
    }, llmOpts),
  ]);

  // Pull the arc summary in before issue-proposal so the issue boundaries
  // align with the arc's act structure. Falls back to logline if summary
  // is empty (older / smaller models sometimes return just logline).
  const arcContent = (typeof arcRun.content === 'object' && arcRun.content !== null)
    ? arcRun.content
    : {};
  const arcSummary = arcContent.summary || arcContent.logline || `${promptSeriesName} — ${contentType}`;

  const issuesRun = await runStagedLLM('importer-issue-proposal', {
    seriesName: promptSeriesName,
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

  // All LLM calls succeeded — now persist any new records. Pre-existing
  // records are returned as-is; new records are created here at the end so
  // a failure above never leaves orphaned data on disk.
  //
  // Thread A: wrap the two-step create in a try/catch so a `createSeries`
  // failure doesn't leave an orphaned universe on disk. We only delete the
  // universe if we created it in this call — a pre-existing universe must
  // never be removed as a side-effect of a series-create failure.
  let universe = isExistingUniverse
    ? existingUniverse
    : await createUniverse({ name: universeName.trim() });
  const universeWasCreated = !isExistingUniverse;

  let series;
  try {
    series = isExistingSeries
      ? existingSeries
      : await createSeries({ name: seriesName.trim(), universeId: universe.id });
  } catch (seriesErr) {
    if (universeWasCreated) {
      await deleteUniverse(universe.id).catch((delErr) =>
        console.error(`❌ analyzeImport rollback: failed to delete orphaned universe ${universe.id}: ${delErr.message}`),
      );
    }
    throw seriesErr;
  }

  const arcPreview = buildArcPreview(arcRun.content);

  return {
    universe,
    series,
    isExistingUniverse,
    isExistingSeries,
    canonPreview: {
      characters: Array.isArray(canonRun.content?.characters) ? canonRun.content.characters : [],
      places: Array.isArray(canonRun.content?.places) ? canonRun.content.places : [],
      objects: Array.isArray(canonRun.content?.objects) ? canonRun.content.objects : [],
    },
    arcPreview,
    seasonsPreview: Array.isArray(arcRun.content?.seasons) ? arcRun.content.seasons : [],
    issueProposals: Array.isArray(issuesRun.content?.issues) ? issuesRun.content.issues : [],
    runIds: {
      canon: canonRun.runId,
      arc: arcRun.runId,
      issues: issuesRun.runId,
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
  };
}

/**
 * Phase 2: commit. Merges the user-confirmed canon into the universe,
 * writes the arc + seasons onto the series, then creates one issue per
 * proposal with prose pre-seeded. Validates the locked-arc guard one more
 * time (the series could have been locked between analyze + commit).
 */
export async function commitImport({
  universeId,
  seriesId,
  canonSelections = {},
  arc = null,
  seasons = [],
  issues = [],
} = {}) {
  if (!isStr(universeId)) throw makeErr('universeId is required', ERR_VALIDATION);
  if (!isStr(seriesId)) throw makeErr('seriesId is required', ERR_VALIDATION);
  if (!Array.isArray(issues) || issues.length === 0) {
    throw makeErr('At least one issue is required', ERR_VALIDATION);
  }

  // Re-fetch under the universe + series lock window so we apply the merge
  // against the freshest persisted state — the user may have edited the
  // universe canon in another tab between analyze and commit.
  const universe = await getUniverse(universeId);
  const series = await getSeries(seriesId);

  if (series.universeId && series.universeId !== universe.id) {
    throw makeErr(
      `Series "${series.name}" is linked to a different universe — commit refused to avoid cross-linking.`,
      ERR_VALIDATION,
    );
  }

  if (series.locked?.arc === true) {
    throw makeErr(
      `Series "${series.name}" has a locked arc — commit refused. Unlock the arc to import.`,
      ERR_LOCKED,
    );
  }

  // Thread C fix — fail-fast validation BEFORE any state mutation. Run
  // every issue through all gates that createIssue enforces so that a bad
  // payload is rejected here, before the universe + series are written.
  // `createIssue` also requires `seriesId` (supplied below) and generates
  // its own `id`, so those two fields don't need pre-checking.
  for (let i = 0; i < issues.length; i++) {
    const proposal = issues[i];
    if (!isStr(proposal?.title) || !proposal.title.trim()) {
      throw makeErr(
        `Issue at position ${i + 1} is missing a title — commit refused before any state changed.`,
        ERR_VALIDATION,
      );
    }
    // arcPosition is the issue's slot in the series — Zod enforces int >= 1
    // at the route layer, but commitImport is also called directly from
    // tests + future internal callers; mirror the schema gate here so the
    // service contract holds regardless of caller.
    if (!Number.isInteger(proposal.arcPosition) || proposal.arcPosition < 1) {
      throw makeErr(
        `Issue at position ${i + 1} has invalid arcPosition (must be integer >= 1) — commit refused before any state changed.`,
        ERR_VALIDATION,
      );
    }
    // When proseExcerpt is present it must be non-empty after trim —
    // mirrors the route Zod `.refine` so a whitespace-only excerpt from
    // a direct caller doesn't seed `stages.prose` with garbage.
    if (proposal.proseExcerpt !== undefined && proposal.proseExcerpt !== null) {
      if (!isStr(proposal.proseExcerpt) || !proposal.proseExcerpt.trim()) {
        throw makeErr(
          `Issue at position ${i + 1} has invalid proseExcerpt (must be non-empty when present) — commit refused before any state changed.`,
          ERR_VALIDATION,
        );
      }
    }
  }
  // Same contract for seasons: route Zod enforces `number: int >= 1`,
  // commitImport mirrors it so the service is safe under direct calls.
  // Also reject duplicate season numbers — the merge keys by `number`,
  // so two incoming seasons with the same number would silently collapse
  // into one entry post sanitizeSeasonList.
  const seenSeasonNumbers = new Set();
  for (let i = 0; i < seasons.length; i++) {
    const s = seasons[i];
    if (s?.number !== undefined && s?.number !== null) {
      if (!Number.isInteger(s.number) || s.number < 1) {
        throw makeErr(
          `Season at position ${i + 1} has invalid number (must be integer >= 1) — commit refused before any state changed.`,
          ERR_VALIDATION,
        );
      }
      if (seenSeasonNumbers.has(s.number)) {
        throw makeErr(
          `Duplicate season number ${s.number} at position ${i + 1} — commit refused before any state changed.`,
          ERR_VALIDATION,
        );
      }
      seenSeasonNumbers.add(s.number);
    }
  }

  // Wire field `places` maps to storage field `settings` until the
  // Phase 0b rename lands; the table keeps the three near-identical
  // merge calls + universe.update payload in one place.
  const KIND_MAP = [
    ['characters', BIBLE_KIND.CHARACTER, 'characters'],
    ['places',     BIBLE_KIND.SETTING,   'settings'],
    ['objects',    BIBLE_KIND.OBJECT,    'objects'],
  ];
  // Only merge kinds the user actually supplied entries for — calling
  // mergeExtractedBible with an empty list still rebuilds the array and
  // re-stamps timestamps, churning the file write for no behavior change.
  const universePatch = Object.fromEntries(
    KIND_MAP
      .filter(([selectionKey]) => (canonSelections[selectionKey] || []).length > 0)
      .map(([selectionKey, kind, storageKey]) => [
        storageKey,
        mergeExtractedBible(
          universe[storageKey] || [],
          canonSelections[selectionKey],
          kind,
          { source: 'imported' },
        ),
      ]),
  );
  // If the user supplied no canon at all (arc-only import), skip the
  // updateUniverse round-trip entirely.
  const updatedUniverse = Object.keys(universePatch).length > 0
    ? await updateUniverse(universe.id, universePatch)
    : universe;

  // sanitizeArc returns null on an entirely-empty payload — leave
  // series.arc untouched in that case.
  const sanitizedArc = sanitizeArc(arc);
  let updatedSeries = series;
  if (sanitizedArc || seasons.length > 0) {
    // Thread B fix: merge incoming seasons with the existing series.seasons[]
    // instead of wholesale-replacing them. Match by `number` (the stable
    // addressing key for seasons — buildSeason always assigns a canonical
    // number). For each incoming season: if an existing season with the same
    // number is found, preserve its id and timestamps (so issue pointers stay
    // intact); otherwise build a fresh season. Seasons absent from the
    // incoming list are kept as-is so a re-import never deletes user-authored
    // seasons that weren't in the source.
    const existingSeasons = Array.isArray(series.seasons) ? series.seasons : [];
    const existingByNumber = new Map(
      existingSeasons.filter((s) => Number.isFinite(s.number)).map((s) => [s.number, s]),
    );
    // Auto-assign sequential numbers to incoming seasons that omit one
    // (the route schema allows omission). Without this, multiple
    // unnumbered seasons would all default to `1` and silently collapse.
    // Resolution: scan max-of-(existing ∪ already-assigned-in-this-call)
    // and pick `max + 1` for each unnumbered season.
    const usedNumbers = new Set([...existingByNumber.keys()]);
    for (const s of seasons) {
      if (Number.isInteger(s?.number) && s.number >= 1) usedNumbers.add(s.number);
    }
    let nextFreeNumber = (usedNumbers.size === 0) ? 1 : Math.max(...usedNumbers) + 1;
    const nowIso = new Date().toISOString();
    const incomingBuilt = seasons.map((s) => {
      let num;
      if (Number.isInteger(s?.number) && s.number >= 1) {
        num = s.number;
      } else {
        num = nextFreeNumber++;
      }
      const existing = existingByNumber.get(num);
      const titleChanged = !!(s.title && existing && s.title !== existing.title);
      const loglineChanged = !!(s.logline && existing && s.logline !== existing.logline);
      const synopsisChanged = !!(s.synopsis && existing && s.synopsis !== existing.synopsis);
      if (existing) {
        // Preserve the existing season's id — re-import with the same
        // season number is a metadata refresh, not a new season. Bump
        // `updatedAt` only when an importable field actually changed so
        // LWW reasoning and "last edited" UIs stay accurate.
        return {
          ...existing,
          title: s.title || existing.title || `Season ${num}`,
          logline: s.logline || existing.logline || '',
          synopsis: s.synopsis || existing.synopsis || '',
          endingHook: s.endingHook || existing.endingHook || '',
          episodeCountTarget: s.episodeCountTarget ?? existing.episodeCountTarget ?? 0,
          ...((titleChanged || loglineChanged || synopsisChanged) ? { updatedAt: nowIso } : {}),
        };
      }
      return buildSeason({
        number: num,
        title: s.title || `Season ${num}`,
        logline: s.logline || '',
        synopsis: s.synopsis || '',
        endingHook: s.endingHook || '',
        episodeCountTarget: s.episodeCountTarget ?? 0,
        status: 'draft',
      });
    });
    // Merge: union of existing seasons + updated/new incoming seasons,
    // deduped and sorted by sanitizeSeasonList (LWW by id, then by number).
    const incomingNumbers = new Set(incomingBuilt.map((s) => s.number));
    const retained = existingSeasons.filter((s) => !incomingNumbers.has(s.number));
    const builtSeasons = sanitizeSeasonList([...retained, ...incomingBuilt]);

    updatedSeries = await updateSeries(series.id, {
      ...(sanitizedArc ? { arc: sanitizedArc } : {}),
      ...(builtSeasons.length > 0 ? { seasons: builtSeasons } : {}),
    });
  }

  // seasonNumber → seasonId map; missing seasonNumber falls through to
  // the first season's id, or null when no seasons exist.
  const seasonByNumber = new Map();
  for (const s of (updatedSeries.seasons || [])) {
    if (Number.isFinite(s.number)) seasonByNumber.set(s.number, s.id);
  }
  const fallbackSeasonId = updatedSeries.seasons?.[0]?.id || null;

  const createdIssueIds = [];
  // Surface season-remap events so the UI can warn "issue 3 wanted season 5
  // but it doesn't exist — landed in season 1." Silent reassignment hides
  // user intent; an explicit list lets the caller toast it.
  const remappedIssues = [];

  // Thread C fix — issue-loop with rollback on failure. The universe +
  // series are already written above. If createIssue throws mid-loop (e.g.
  // transient FS error) we delete every issue created so far and re-throw,
  // leaving the universe + series in their updated state but with no partial
  // issue set. The universe + series writes are kept because they represent
  // user-confirmed data; only the issue set is all-or-nothing from the
  // commit's perspective.
  try {
    for (const proposal of issues) {
      let seasonId = fallbackSeasonId;
      if (proposal.seasonNumber != null) {
        const matched = seasonByNumber.get(proposal.seasonNumber);
        if (matched) {
          seasonId = matched;
        } else {
          remappedIssues.push({
            title: proposal.title,
            arcPosition: proposal.arcPosition,
            requestedSeasonNumber: proposal.seasonNumber,
            actualSeasonId: fallbackSeasonId,
          });
        }
      }
      // Bundle stage seeds into the initial createIssue payload so the
      // serialized write tail handles one write per issue instead of
      // create + updateStage(prose) + updateStage(idea).
      const stages = {};
      if (proposal.proseExcerpt) {
        stages.prose = { status: 'ready', output: proposal.proseExcerpt };
      }
      const ideaSeed = [
        proposal.logline && `Logline: ${proposal.logline}`,
        proposal.synopsis && `Synopsis: ${proposal.synopsis}`,
      ].filter(Boolean).join('\n\n');
      if (ideaSeed) {
        // `idea` is seeded with input only — the user/LLM still needs to
        // run the idea stage to produce `output`. `isStageReady` requires
        // both `status in {'ready','edited'}` AND non-empty output, so
        // marking 'ready' here would mislabel it to status-only consumers
        // while failing readiness predicates downstream. 'empty' matches
        // the actual state: input present, generation not yet performed.
        stages.idea = { status: 'empty', input: ideaSeed };
      }
      const issue = await createIssue({
        seriesId: updatedSeries.id,
        title: proposal.title,
        seasonId,
        arcPosition: proposal.arcPosition,
        arcRole: proposal.arcRole,
        stages,
      });
      createdIssueIds.push(issue.id);
    }
  } catch (issueErr) {
    // Roll back any issues already written so the system isn't left with a
    // partial issue set. Rollback failures are logged but don't mask the
    // original error — the user gets the real error and can re-commit.
    for (const id of createdIssueIds) {
      await deleteIssue(id).catch((delErr) =>
        console.error(`❌ commitImport rollback: failed to delete issue ${id}: ${delErr.message}`),
      );
    }
    // Surface a distinct code + message so the UI can tell the user that the
    // universe and series were saved but the issues were rolled back. Retrying
    // commit is safe: universe/series merges are idempotent and season ids are
    // stable, so only the issue creation re-runs.
    const n = issues.length;
    const partial = Object.assign(
      new Error(
        `The universe and series were updated successfully, but ${createdIssueIds.length} of ${n} issue${n === 1 ? '' : 's'} failed and were rolled back — retry to create the remaining issues. (Original error: ${issueErr.message})`,
      ),
      { code: ERR_PARTIAL_COMMIT_ISSUES },
    );
    throw partial;
  }

  return {
    universe: updatedUniverse,
    series: updatedSeries,
    createdIssueIds,
    remappedIssues,
  };
}

