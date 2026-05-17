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
} from './universeBuilder.js';
import {
  listSeries,
  getSeries,
  createSeries,
  updateSeries,
} from './pipeline/series.js';
import { createIssue } from './pipeline/issues.js';
import { sanitizeArc, sanitizeSeasonList, buildSeason, ARC_SHAPE_IDS, ARC_ROLES } from '../lib/storyArc.js';
import { mergeExtractedBible, BIBLE_KIND } from '../lib/storyBible.js';

// Surfaced to the route layer so the importer's policy errors become 400s
// with stable codes.
export const ERR_VALIDATION = 'IMPORTER_VALIDATION';
export const ERR_LOCKED = 'IMPORTER_LOCKED';

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

async function findOrCreateUniverse(name) {
  const found = await findUniverseByName(name);
  if (found) return { universe: found, isExisting: true };
  const created = await createUniverse({ name });
  return { universe: created, isExisting: false };
}

async function findOrCreateSeries(name, universeId) {
  const found = await findSeriesByName(name, universeId);
  if (found) return { series: found, isExisting: true };
  const created = await createSeries({ name, universeId });
  return { series: created, isExisting: false };
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
 * Phase 1: analyze. Runs canon-extract + arc-extract in parallel (both read
 * source independently); after arc resolves, runs issue-proposal with the
 * arc summary in scope so the issue boundaries align with the arc's beats.
 *
 * Returns a fully-shaped preview the client can render in the Review
 * phase. Nothing canonical (arc, seasons, issues) is persisted yet — only
 * the find-or-created universe + series exist on disk so the commit phase
 * has stable ids to reference.
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

  const { universe, isExisting: isExistingUniverse } = await findOrCreateUniverse(universeName);
  const { series, isExisting: isExistingSeries } = await findOrCreateSeries(seriesName, universe.id);

  // If the user re-runs the importer on a series whose arc is locked, fail
  // FAST — no point spending heavy-tier tokens to extract an arc the commit
  // phase will refuse to apply.
  if (series.locked?.arc === true) {
    throw makeErr(
      `Series "${series.name}" has a locked arc. Unlock it on the Arc Canvas before importing — or rename the import's series so a fresh series is created.`,
      ERR_LOCKED,
    );
  }

  const existingCanon = compactCanonForPrompt(universe);
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

  // Canon + arc are independent reads of the same source — fire in
  // parallel. Issue-proposal depends on the arc summary, so chain after
  // arc resolves.
  const [canonRun, arcRun] = await Promise.all([
    runStagedLLM('importer-canon-extract', {
      universeName: universe.name,
      seriesName: series.name,
      contentType,
      source,
      existingCanonJson: existingCanon ? JSON.stringify(existingCanon, null, 2) : '',
      ...typeFlags,
    }, llmOpts),
    runStagedLLM('importer-arc-extract', {
      seriesName: series.name,
      contentType,
      source,
      ...typeFlags,
    }, llmOpts),
  ]);

  // Pull the arc summary in before issue-proposal so the issue boundaries
  // align with the arc's act structure. Falls back to logline if summary
  // is empty (older / smaller models sometimes return just logline).
  const arcSummary = String(
    arcRun.content?.summary
    || arcRun.content?.logline
    || `${series.name} — ${contentType}`,
  );

  const issuesRun = await runStagedLLM('importer-issue-proposal', {
    seriesName: series.name,
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
    universe,
    series,
    isExistingUniverse,
    isExistingSeries,
    canonPreview: {
      characters: Array.isArray(canonRun.content?.characters) ? canonRun.content.characters : [],
      places: Array.isArray(canonRun.content?.places) ? canonRun.content.places : [],
      objects: Array.isArray(canonRun.content?.objects) ? canonRun.content.objects : [],
    },
    arcPreview: arcRun.content || null,
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

  // Fail-fast validation BEFORE any state mutation: a missing-title issue
  // would otherwise let the canon merge + arc/seasons write land on disk
  // and only fail mid-issues-loop, leaving the system half-imported. We
  // require `title` here because `createIssue` requires it and there is no
  // rollback path for partial writes.
  for (let i = 0; i < issues.length; i++) {
    const proposal = issues[i];
    if (!isStr(proposal?.title) || !proposal.title.trim()) {
      throw makeErr(
        `Issue at position ${i + 1} is missing a title — commit refused before any state changed.`,
        ERR_VALIDATION,
      );
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
  const universePatch = Object.fromEntries(KIND_MAP.map(([selectionKey, kind, storageKey]) => [
    storageKey,
    mergeExtractedBible(
      universe[storageKey] || [],
      canonSelections[selectionKey] || [],
      kind,
      { source: 'imported' },
    ),
  ]));
  const updatedUniverse = await updateUniverse(universe.id, universePatch);

  // sanitizeArc returns null on an entirely-empty payload — leave
  // series.arc untouched in that case.
  const sanitizedArc = sanitizeArc(arc);
  let updatedSeries = series;
  if (sanitizedArc || seasons.length > 0) {
    const builtSeasons = sanitizeSeasonList(
      seasons.map((s) => buildSeason({
        number: s.number ?? 1,
        title: s.title || `Season ${s.number ?? 1}`,
        logline: s.logline || '',
        synopsis: s.synopsis || '',
        endingHook: s.endingHook || '',
        episodeCountTarget: s.episodeCountTarget ?? 0,
        status: 'draft',
      })),
    );
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
      stages.idea = { status: 'ready', input: ideaSeed };
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

  return {
    universe: updatedUniverse,
    series: updatedSeries,
    createdIssueIds,
    remappedIssues,
  };
}

export { ARC_SHAPE_IDS };
