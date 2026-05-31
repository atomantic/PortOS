/**
 * Pipeline — Importer Service
 *
 * Reverse-engineers a finished short story / novel / screenplay / comic
 * script into universe canon + series arc + prose-seeded issues.
 *
 * Canon kind mapping: the prompts, wire shape, AND on-disk universe schema
 * all use `places` after the bible-kind SETTING→PLACE rename. The mapping
 * table below preserves the orchestrator's wire-vs-storage tuple so a
 * future schema change only has to flip the third column.
 */

import { randomUUID } from 'crypto';
import { runStagedLLM } from '../lib/stageRunner.js';
import { importerEvents } from './importerEvents.js';
// Re-export so consumers reach the analyze-phase progress bus through the
// importer's public surface (the socket bridge imports it from the source
// module directly; tests + future callers use this).
export { importerEvents };
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
import { createIssue, deleteIssue, listIssues } from './pipeline/issues.js';
import { sanitizeArc, sanitizeSeasonList, buildSeason, ARC_SHAPE_IDS, ARC_ROLES } from '../lib/storyArc.js';
import { COMIC_NUM, COMIC_HEADER_TAIL } from '../lib/comicScriptParser.js';
import { IMPORTER_CONTENT_TYPES, IMPORTER_PROSE_EXCERPT_MAX } from '../lib/validation.js';
// Re-export the per-issue excerpt ceiling so callers/tests can reference the
// same value the mechanical comic split validates against.
export { IMPORTER_PROSE_EXCERPT_MAX };
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
// under the toolkit's 30-min MAX_TIMEOUT ceiling. Passed as `timeoutOverride`
// on every analyze stage call.
export const ANALYZE_STAGE_TIMEOUT_MS = 1_200_000;

// Sanity ceiling on the source corpus — matches the schema-layer abuse guard
// (`importerSourceField`, 5MB) so the importer doesn't impose an *artificial*
// product cap below it. A 5M-char source (~3,000 pages) is far beyond any real
// book — even War & Peace is ~3.2M. The real operational limit is dynamic: the
// active provider's context window, since the whole corpus still goes into one
// extraction call. Sources that fit the ceiling but overflow the chosen model's
// window will fail at the provider until the chunked-extraction follow-up lands
// (PLAN.md / "Create Suite — Importer page") — pick a large-context provider or
// trim the source in the meantime.
export const IMPORTER_SOURCE_CHAR_LIMIT = 5_000_000;

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

// Which text stage an issue's verbatim excerpt seeds at commit. A content type
// that is ALREADY in a script form seeds that script stage (ready) so the
// pipeline renders the user's verbatim text instead of regenerating it; prose
// types seed `stages.prose`. One table row per new structured type — e.g.
// screenplay → 'teleplay' is the queued follow-up (PLAN.md
// [importer-screenplay-teleplay-seed]).
const CONTENT_TYPE_SEED_STAGE = Object.freeze({
  'comic-script': 'comicScript',
});
const DEFAULT_SEED_STAGE = 'prose';
const seedStageFor = (contentType) => CONTENT_TYPE_SEED_STAGE[contentType] || DEFAULT_SEED_STAGE;

const normName = (s) => String(s || '').trim().toLowerCase();
const isStr = (v) => typeof v === 'string';

// Required + oversized-ceiling guard for the source corpus. Shared by
// analyze / classify / retry-issues so the check and its (verbatim) error
// message live in one place.
function assertSourceWithinLimit(source) {
  if (!isStr(source) || !source.trim()) {
    throw makeErr('source is required', ERR_VALIDATION);
  }
  if (source.length > IMPORTER_SOURCE_CHAR_LIMIT) {
    throw makeErr(
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

// Wire schema (importerSeasonEntry) caps season.number at 99 — mirror
// that ceiling here so the auto-assign path can't silently land a value
// the schema wouldn't accept on direct entry.
const SEASON_NUMBER_MAX = 99;
// Wire schema (importerIssueEntry) caps arcPosition at 9999 — mirror so
// the service-side auto-assign can't drift above it.
const ARC_POSITION_MAX = 9999;

/**
 * Merge incoming seasons with the existing `series.seasons[]` array,
 * matching by `number`. Pure function — no I/O. Extracted so the merge
 * logic (used number set, auto-assign for omitted numbers, update vs
 * create per number, change-aware updatedAt bump, union back with
 * retained existing) can be reasoned about + unit-tested in isolation.
 *
 * Contract:
 *   - Incoming seasons with an explicit integer `number >= 1` keep it.
 *   - Incoming seasons that omit `number` are assigned the next free
 *     integer above the union of existing + already-assigned numbers;
 *     throws ERR_VALIDATION if that would exceed SEASON_NUMBER_MAX (99).
 *   - Where the assigned number matches an existing season, the existing
 *     season's id (+ timestamps) are preserved — re-import is a metadata
 *     refresh, not a new season. **String-field merge follows CLAUDE.md's
 *     "absent vs intentionally empty" rule**: `undefined`/`null` preserves
 *     the existing value; an empty string `""` is treated as an intentional
 *     clear and applied. `updatedAt` bumps when any tracked field
 *     (title / logline / synopsis / endingHook / episodeCountTarget)
 *     actually changed, including a clear.
 *   - Existing seasons not touched by this merge are retained as-is.
 *   - Caller is responsible for `sanitizeSeasonList` on the result.
 */
export function mergeSeasons(existingSeasons, incomingSeasons, buildSeasonImpl = buildSeason) {
  const existingByNumber = new Map(
    existingSeasons.filter((s) => Number.isFinite(s.number)).map((s) => [s.number, s]),
  );
  // Dedup-check + ceiling-check explicit incoming numbers — commitImport's
  // route path Zod gates against both, but a direct caller (a future
  // internal consumer of the pure helper, or a test) would otherwise
  // silently collapse two incoming seasons sharing a number into one merge
  // target, or land a number > SEASON_NUMBER_MAX that the wire wouldn't
  // accept. Auto-assign path enforces the ceiling below; the explicit
  // path enforces it here for symmetry.
  const seenIncomingNumbers = new Set();
  for (const s of incomingSeasons) {
    if (Number.isInteger(s?.number) && s.number >= 1) {
      if (s.number > SEASON_NUMBER_MAX) {
        throw makeErr(
          `mergeSeasons: explicit season number ${s.number} exceeds the max of ${SEASON_NUMBER_MAX}.`,
          ERR_VALIDATION,
        );
      }
      if (seenIncomingNumbers.has(s.number)) {
        throw makeErr(
          `mergeSeasons: duplicate explicit season number ${s.number} in incoming list — caller must pre-dedupe.`,
          ERR_VALIDATION,
        );
      }
      seenIncomingNumbers.add(s.number);
    }
  }
  const usedNumbers = new Set([...existingByNumber.keys(), ...seenIncomingNumbers]);
  // Jump-past-max rather than gap-fill: if existing seasons are [1, 5],
  // auto-assign lands at 6 (not 2). Two reasons: (1) gap-fill could
  // silently re-occupy a slot the user intentionally deleted (e.g.
  // removed season 3 to retire it; new content shouldn't land at slot 3
  // with a totally different premise); (2) "new = appended" matches the
  // user's mental model of how multi-pass imports extend the world.
  let nextFreeNumber = (usedNumbers.size === 0) ? 1 : Math.max(...usedNumbers) + 1;
  const nowIso = new Date().toISOString();
  // String-field merge: absent (`undefined`/`null`) preserves the existing
  // value; everything else — including `""` — is the user's intent and is
  // applied verbatim. Mirrors the CLAUDE.md "distinguish absent vs
  // intentionally empty" rule so a Review-phase blank-out actually clears.
  const mergeStr = (incoming, existing) => (incoming == null ? (existing ?? '') : incoming);
  const incomingBuilt = incomingSeasons.map((s) => {
    let num;
    if (Number.isInteger(s?.number) && s.number >= 1) {
      num = s.number;
    } else {
      if (nextFreeNumber > SEASON_NUMBER_MAX) {
        throw makeErr(
          `Cannot auto-assign season number — next free slot (${nextFreeNumber}) exceeds the max of ${SEASON_NUMBER_MAX}. Free up a season slot or set season.number explicitly.`,
          ERR_VALIDATION,
        );
      }
      num = nextFreeNumber++;
    }
    const existing = existingByNumber.get(num);
    if (existing) {
      // Apply the same `|| Season N` default to BOTH sides of the title
      // comparison so a legacy season with `title: undefined` doesn't
      // churn updatedAt on every no-op re-import: without normalizing
      // the existing-side default, `'Season N' !== undefined` always
      // resolves truthy and bumps updatedAt even when nothing changed.
      const titleDefault = `Season ${num}`;
      const nextTitle = mergeStr(s.title, existing.title) || titleDefault;
      const nextLogline = mergeStr(s.logline, existing.logline);
      const nextSynopsis = mergeStr(s.synopsis, existing.synopsis);
      const nextEndingHook = mergeStr(s.endingHook, existing.endingHook);
      const nextEpisodeCount = s.episodeCountTarget ?? existing.episodeCountTarget ?? 0;
      const anyChanged = nextTitle !== (existing.title || titleDefault)
        || nextLogline !== (existing.logline ?? '')
        || nextSynopsis !== (existing.synopsis ?? '')
        || nextEndingHook !== (existing.endingHook ?? '')
        || nextEpisodeCount !== (existing.episodeCountTarget ?? 0);
      return {
        ...existing,
        title: nextTitle,
        logline: nextLogline,
        synopsis: nextSynopsis,
        endingHook: nextEndingHook,
        episodeCountTarget: nextEpisodeCount,
        ...(anyChanged ? { updatedAt: nowIso } : {}),
      };
    }
    return buildSeasonImpl({
      number: num,
      title: s.title || `Season ${num}`,
      logline: s.logline || '',
      synopsis: s.synopsis || '',
      endingHook: s.endingHook || '',
      episodeCountTarget: s.episodeCountTarget ?? 0,
      status: 'draft',
    });
  });
  // Union: existing seasons NOT in the incoming set + the (updated or
  // freshly built) incoming entries. Caller runs sanitizeSeasonList.
  // Filter retained to the same finite-numbered subset the map above
  // operates on — a malformed existing entry (number undefined/NaN)
  // would otherwise always slip through (since incomingNumbers only
  // contains valid integers), surviving the merge unreachable by id.
  // sanitizeSeasonList downstream coerces those to 0 and may drop
  // them, but filtering here removes the ambiguity at the source.
  const incomingNumbers = new Set(incomingBuilt.map((s) => s.number));
  const retained = existingSeasons.filter((s) =>
    Number.isFinite(s.number) && !incomingNumbers.has(s.number),
  );
  return [...retained, ...incomingBuilt];
}

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

// --- Mechanical comic-script splitting -------------------------------------
//
// A comic script is already issue/page-structured prose, so re-running it
// through a heavy LLM to "propose" an issue split both costs tokens and
// risks the model rephrasing verbatim panel/dialogue text. When the script
// carries explicit ISSUE or PAGE headers we split on them deterministically
// instead — verbatim, instant, free. Falls back (returns null) to the LLM
// split when no headers are found so a header-less comic script still works.

// Default page bundle size when a script has PAGE markers but no ISSUE
// markers and the user didn't request a specific issue count. ~22 pages is
// the floppy-issue convention referenced in DEFAULT_TARGET_ISSUE_COUNT_HINT.
const COMIC_PAGES_PER_ISSUE = 22;

// Header-like line gate: comic ISSUE/PAGE headers sit on their own short,
// usually all-caps line. Capping length keeps a prose sentence that happens
// to open with "Page " or "Issue " from being mistaken for a structural
// marker (the LLM fallback still covers genuinely header-less scripts).
const COMIC_HEADER_MAX_LEN = 80;
// `ISSUE #3`, `ISSUE 3`, `ISSUE THREE`, `ISSUE 3: TITLE`, `ISSUE THREE - TITLE`.
// `COMIC_NUM` + `COMIC_HEADER_TAIL` (shared with the render-time parser via
// comicScriptParser.js) restrict the number token to digits/spelled-numbers
// AND require a standalone header form — so prose like "Issue resolved." or
// "Issue 1 of the saga lay open" (content that merely starts with the keyword)
// isn't mis-split. A title is captured only after a separator. Sharing the
// grammar keeps the import-time split and the render-time parse in agreement —
// except for the COMIC_HEADER_MAX_LEN (80) length cap applied here but NOT by
// the render-time bare parser, so a rare >80-char PAGE/ISSUE header folds into
// the prior segment at split time yet still opens a page at render time.
const ISSUE_HEADER_RE = new RegExp(`^issue\\b\\s*#?\\s*(${COMIC_NUM})\\b\\s*(?:[:.\\-–—]\\s*(.*))?\\s*$`, 'i');
// `PAGE 1`, `PAGE ONE`, `PAGES 2-3`, `PAGE ONE (FIVE PANELS)`
const PAGE_HEADER_RE = new RegExp(`^pages?\\b\\s*#?\\s*(${COMIC_NUM})\\b${COMIC_HEADER_TAIL}`, 'i');

// Locate header lines matching `re`. Returns `[{ idx, title }]` where `idx`
// is the 0-based line index and `title` is the trailing text after the
// number (ISSUE only; '' otherwise).
function findComicHeaders(lines, re) {
  const headers = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.length > COMIC_HEADER_MAX_LEN) continue;
    const m = re.exec(t);
    if (m) headers.push({ idx: i, title: (m[2] || '').trim() });
  }
  return headers;
}

// Slice `lines[startIdx..endIdx)` back into a verbatim string (newline-
// joined) and trim surrounding blank lines without touching interior text.
function joinSegment(lines, startIdx, endIdx) {
  return lines.slice(startIdx, endIdx).join('\n').replace(/^\n+|\n+$/g, '');
}

/**
 * Mechanically split a comic script into issue proposals on its ISSUE / PAGE
 * headers. Returns an array of `{ title, arcPosition, proseExcerpt }` (no
 * logline/synopsis — the split deliberately does NOT interpret), or `null`
 * when no usable headers are found (caller falls back to the LLM split).
 *
 * Pure + exported for unit testing. `targetIssueCount` (when a positive
 * integer) forces the PAGE-bundling path to produce exactly that many issues,
 * evenly distributed; ISSUE headers always win when present.
 */
export function splitComicScriptIssues(source, { targetIssueCount = null } = {}) {
  if (!isStr(source) || !source.trim()) return null;
  const lines = source.split(/\r\n|\r|\n/);

  // 1) Explicit ISSUE headers — one issue per header, verbatim. Any text
  //    before the first header (title page / credits) folds into issue 1.
  const issueHeaders = findComicHeaders(lines, ISSUE_HEADER_RE);
  if (issueHeaders.length > 0) {
    const out = [];
    for (let i = 0; i < issueHeaders.length; i++) {
      const startIdx = i === 0 ? 0 : issueHeaders[i].idx;
      const endIdx = i + 1 < issueHeaders.length ? issueHeaders[i + 1].idx : lines.length;
      const proseExcerpt = joinSegment(lines, startIdx, endIdx);
      if (!proseExcerpt.trim()) continue;
      out.push({
        // Preserve the script's own issue title verbatim when present;
        // otherwise label sequentially. Title-casing would be a rewrite.
        title: issueHeaders[i].title || `Issue ${i + 1}`,
        arcPosition: i + 1,
        proseExcerpt,
      });
    }
    return out.length > 0 ? out : null;
  }

  // 2) No ISSUE headers — bundle PAGE markers into issues.
  const pageHeaders = findComicHeaders(lines, PAGE_HEADER_RE);
  if (pageHeaders.length === 0) return null; // header-less → LLM fallback

  // Each page spans from its header to the next (preamble folds into page 1).
  const pages = pageHeaders.map((h, i) => {
    const startIdx = i === 0 ? 0 : h.idx;
    const endIdx = i + 1 < pageHeaders.length ? pageHeaders[i + 1].idx : lines.length;
    return joinSegment(lines, startIdx, endIdx);
  }).filter((p) => p.trim());
  if (pages.length === 0) return null;

  // How many issues to produce: explicit user count (clamped to page count)
  // beats the ~22-pages-per-issue default.
  const requested = Number.isInteger(targetIssueCount) && targetIssueCount > 0
    ? Math.min(targetIssueCount, pages.length)
    : Math.max(1, Math.ceil(pages.length / COMIC_PAGES_PER_ISSUE));

  // Distribute pages as evenly as possible across `requested` issues — the
  // first `remainder` issues get one extra page so no pages are dropped.
  const base = Math.floor(pages.length / requested);
  const remainder = pages.length % requested;
  const out = [];
  let cursor = 0;
  for (let i = 0; i < requested; i++) {
    const take = base + (i < remainder ? 1 : 0);
    const slice = pages.slice(cursor, cursor + take);
    cursor += take;
    const proseExcerpt = slice.join('\n\n').replace(/^\n+|\n+$/g, '');
    if (!proseExcerpt.trim()) continue;
    out.push({ title: `Issue ${i + 1}`, arcPosition: i + 1, proseExcerpt });
  }
  return out.length > 0 ? out : null;
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
        throw makeErr(
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
// 4K chars is roughly 1 200 tokens — enough to see chapter markers, scene
// headings, and panel breaks. Exported so the client can trim its payload
// to match (no point shipping 196KB of body the server will discard).
export const CLASSIFY_SOURCE_HEAD_CHARS = 4_000;

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
    throw makeErr('universeName is required', ERR_VALIDATION);
  }
  if (!isStr(seriesName) || !seriesName.trim()) {
    throw makeErr('seriesName is required', ERR_VALIDATION);
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
  // option). `analyzeLlmOpts` returns a FRESH object each call so a future
  // runner that adds bookkeeping can't leak state across our parallel
  // canon + arc invocations.
  const buildLlmOpts = () => analyzeLlmOpts(providerOverride, modelOverride);

  // Live stage progress (see ANALYZE_STAGES). `runId` lets the client ignore
  // stragglers from a prior run. Emitting is best-effort UI sugar — never let
  // a listener throw abort the extraction, so swallow + log at this boundary.
  const runId = randomUUID();
  const emitProgress = (frame) => {
    try {
      importerEvents.emit('progress', { runId, ...frame });
    } catch (err) {
      console.error(`❌ importer progress emit failed: ${err.message}`);
    }
  };
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
    throw makeErr(`Unknown contentType "${contentType}"`, ERR_VALIDATION);
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
  // Content type drives which stage each issue's verbatim excerpt seeds (see
  // the stage-seed block below). Absent → prose-seed (prior behavior).
  contentType = null,
  // Destructive replace: wipes existing issues, overwrites arc + seasons.
  // Universe canon still merges additively (it's shared across series, so
  // a per-series destructive replace would be too coarse). Default false.
  replaceMode = false,
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

  // Defensive: refuse commit when series.universeId is set AND differs,
  // OR when series.universeId is missing entirely. A legacy series
  // persisted before universeId became standard would otherwise silently
  // be re-homed to whichever universe the caller routed through. createSeries
  // sets universeId today, so a missing value implies hand-edited / pre-link
  // legacy data — flag it so the caller decides rather than silently linking.
  if (series.universeId !== universe.id) {
    if (series.universeId) {
      throw makeErr(
        `Series "${series.name}" is linked to a different universe — commit refused to avoid cross-linking.`,
        ERR_VALIDATION,
      );
    }
    throw makeErr(
      `Series "${series.name}" has no universeId — commit refused. Link the series to a universe explicitly before importing.`,
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
    // arcPosition is the issue's slot in the series — Zod enforces
    // int 1..ARC_POSITION_MAX at the route layer, but commitImport is
    // also called directly from tests + future internal callers; mirror
    // both the floor and the ceiling here so the service contract holds
    // regardless of caller. Allow undefined — an auto-assign pass below
    // picks the next free slot. Reject anything that isn't a valid
    // integer in [1, ARC_POSITION_MAX].
    if (proposal.arcPosition !== undefined && proposal.arcPosition !== null
        && (!Number.isInteger(proposal.arcPosition)
            || proposal.arcPosition < 1
            || proposal.arcPosition > ARC_POSITION_MAX)) {
      throw makeErr(
        `Issue at position ${i + 1} has invalid arcPosition (must be integer 1..${ARC_POSITION_MAX}) — commit refused before any state changed.`,
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
  // Reject duplicate explicit arcPosition values across the incoming
  // issues array — downstream sorting collapses ties to insertion order
  // and the renumber pass would silently re-key, leaving the user
  // wondering why issue #3 became #4. Auto-assign for omitted positions
  // happens below.
  const seenArcPositions = new Set();
  for (let i = 0; i < issues.length; i++) {
    const pos = issues[i]?.arcPosition;
    if (Number.isInteger(pos) && pos >= 1) {
      if (seenArcPositions.has(pos)) {
        throw makeErr(
          `Duplicate arcPosition ${pos} at issue position ${i + 1} — commit refused before any state changed.`,
          ERR_VALIDATION,
        );
      }
      seenArcPositions.add(pos);
    }
  }
  // Auto-assign sequential arcPositions to incoming issues that omit one.
  // Mirrors the seasons auto-assign in the merge path. Issues with an
  // explicit position keep it; gaps get filled by the next free integer.
  // Seed nextFree from the UNION of explicit incoming positions AND any
  // pre-existing series.issues[].arcPosition — re-import on a series
  // that already has issues at [1..3] would otherwise auto-assign
  // starting at 1 again and create duplicate positions. createIssue
  // doesn't enforce arcPosition uniqueness, so the collision would
  // silently land on disk and the renumber pass would arbitrarily
  // order the ties.
  // Cap at ARC_POSITION_MAX (matching the wire schema's `.max(9999)`)
  // so a value the wire wouldn't accept can't reach createIssue via the
  // service auto-assign path.
  const existingIssues = await listIssues({ seriesId: series.id });
  // In replace mode we'll wipe these before creating the new set, so any
  // arcPosition that's currently occupied by an existing issue is fair
  // game. In additive merge mode (default), occupied positions are
  // off-limits — collisions silently land on disk today since
  // createIssue doesn't enforce uniqueness.
  const existingArcPositions = new Set();
  if (!replaceMode) {
    for (const ex of existingIssues) {
      if (Number.isInteger(ex.arcPosition) && ex.arcPosition >= 1) {
        existingArcPositions.add(ex.arcPosition);
      }
    }
    // Symmetry with the auto-assign branch: reject incoming issues whose
    // EXPLICIT arcPosition collides with an arcPosition already used by an
    // existing issue on the series. The auto-assign branch dodges this via
    // the union-set seed; the explicit-position branch would otherwise let
    // createIssue happily land a duplicate.
    for (let i = 0; i < issues.length; i++) {
      const pos = issues[i]?.arcPosition;
      if (Number.isInteger(pos) && pos >= 1 && existingArcPositions.has(pos)) {
        throw makeErr(
          `Issue at position ${i + 1} explicit arcPosition ${pos} collides with an existing issue on the series — commit refused before any state changed. Either renumber the incoming issue or omit arcPosition to auto-assign.`,
          ERR_VALIDATION,
        );
      }
    }
  }
  const allUsedArcPositions = new Set([...seenArcPositions, ...existingArcPositions]);
  let nextFreeArcPos = (allUsedArcPositions.size === 0) ? 1 : Math.max(...allUsedArcPositions) + 1;
  const issuesWithPositions = issues.map((proposal) => {
    if (Number.isInteger(proposal.arcPosition) && proposal.arcPosition >= 1) {
      return proposal;
    }
    if (nextFreeArcPos > ARC_POSITION_MAX) {
      throw makeErr(
        `Cannot auto-assign arcPosition — next free slot (${nextFreeArcPos}) exceeds the max of ${ARC_POSITION_MAX}. Free up a position or set issue.arcPosition explicitly.`,
        ERR_VALIDATION,
      );
    }
    const assigned = nextFreeArcPos++;
    return { ...proposal, arcPosition: assigned };
  });

  // Same contract for seasons: route Zod enforces `number: int 1..99`,
  // commitImport mirrors both the floor AND the ceiling so the service is
  // safe under direct calls. Also reject duplicate season numbers — the
  // merge keys by `number`, so two incoming seasons sharing one would
  // silently collapse into a single entry post sanitizeSeasonList.
  const seenSeasonNumbers = new Set();
  for (let i = 0; i < seasons.length; i++) {
    const s = seasons[i];
    if (s?.number !== undefined && s?.number !== null) {
      if (!Number.isInteger(s.number) || s.number < 1 || s.number > SEASON_NUMBER_MAX) {
        throw makeErr(
          `Season at position ${i + 1} has invalid number (must be integer 1..${SEASON_NUMBER_MAX}) — commit refused before any state changed.`,
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

  // Wipe BEFORE universe + series writes so any delete failure aborts the
  // commit cleanly — universe canon + series arc are still in their
  // pre-import state, and no new issues have been created yet. Without this
  // ordering, a swallowed delete failure would leave us writing new issues
  // alongside undeleted old ones; the additive-mode collision check is
  // skipped in replace mode (existingArcPositions stays empty), so reused
  // arcPositions would silently produce duplicates on disk that additive
  // mode explicitly rejects.
  //
  // Abort on the FIRST delete failure (not after looping through all of
  // them) to minimize the destructive surface — deletes already landed are
  // unrecoverable, so the fewer that completed before the throw, the more
  // of the user's pre-import state survives. The error message names the
  // succeeded vs remaining sets explicitly so the user can audit what's
  // gone before retrying. Universe + series writes below are idempotent,
  // so re-running the import after the user fixes the underlying error
  // (and accepts the partially-deleted state) is safe.
  if (replaceMode && existingIssues.length > 0) {
    const deletedIds = [];
    for (const ex of existingIssues) {
      let failed = null;
      await deleteIssue(ex.id).catch((delErr) => {
        console.error(`❌ commitImport replace: failed to delete existing issue ${ex.id}: ${delErr.message}`);
        failed = delErr;
      });
      if (failed) {
        // The "still on disk" set includes BOTH the failed-to-delete issue
        // AND the untouched issues that come after it in the loop — all of
        // them are unaffected on disk and will be wiped on retry. Reporting
        // them as one set (instead of singling out `ex.id` separately) keeps
        // the count honest: total still-on-disk == remainingIds.length.
        const deletedSet = new Set(deletedIds);
        const remainingIds = existingIssues
          .map((e) => e.id)
          .filter((id) => !deletedSet.has(id));
        const deletedMsg = deletedIds.length > 0
          ? ` ${deletedIds.length} issue${deletedIds.length === 1 ? '' : 's'} were already deleted before the failure (${deletedIds.join(', ')}) and cannot be recovered.`
          : '';
        const remainingMsg = ` ${remainingIds.length} issue${remainingIds.length === 1 ? '' : 's'} remain on disk (${remainingIds.join(', ')}, including the failed one); retry will wipe them.`;
        throw makeErr(
          `Replace mode aborted on first delete failure — issue ${ex.id} could not be deleted (${failed.message}). No universe, series, or new-issue writes were performed.${deletedMsg}${remainingMsg} Resolve the underlying error and retry.`,
          ERR_VALIDATION,
        );
      }
      deletedIds.push(ex.id);
    }
  }

  // Wire field, BIBLE_KIND, and storage field collapsed to one row per kind
  // so a future schema change updates one tuple instead of three call sites.
  const KIND_MAP = [
    ['characters', BIBLE_KIND.CHARACTER, 'characters'],
    ['places',     BIBLE_KIND.PLACE,     'places'],
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

  const sanitizedArc = sanitizeArc(arc);

  // Bible top-level fields the Arc Canvas sidebar reads. The importer used to
  // write only series.arc + seasons, leaving logline/premise/issueCountTarget
  // empty — so a freshly-imported series showed a blank bible. Fill them from
  // the extracted arc + the count of issues being created. replaceMode
  // overwrites (user-confirmed wipe); additive only fills fields the series
  // doesn't already have, so a re-import never clobbers a hand-edited bible.
  const issueCount = issuesWithPositions.length;
  const arcLogline = sanitizedArc?.logline || '';
  const arcPremise = sanitizedArc?.summary || sanitizedArc?.protagonistArc || '';
  const biblePatch = {};
  if (replaceMode) {
    // Replace mode is a user-confirmed full overwrite — write the new arc's
    // bible fields unconditionally, INCLUDING empty strings, so an import whose
    // extracted arc lacks a logline/summary clears the prior work's bible
    // rather than leaving stale text beside the freshly-replaced arc + seasons.
    biblePatch.logline = arcLogline;
    biblePatch.premise = arcPremise;
    biblePatch.issueCountTarget = issueCount;
  } else {
    if (arcLogline && !(series.logline || '').trim()) biblePatch.logline = arcLogline;
    if (arcPremise && !(series.premise || '').trim()) biblePatch.premise = arcPremise;
    // Additive: target the POST-import total (issues already on the series plus
    // the ones being added), not just this batch — adding 3 issues to a series
    // that already has 2 should target 5, not 3. Only when no target is set yet.
    const additiveTotal = existingIssues.length + issueCount;
    if (additiveTotal > 0 && !(series.issueCountTarget > 0)) biblePatch.issueCountTarget = additiveTotal;
  }

  let updatedSeries = series;
  if (replaceMode) {
    // null arc + empty seasons are user-confirmed clears in replace mode
    // (in additive mode the same values mean "preserve").
    updatedSeries = await updateSeries(series.id, {
      arc: sanitizedArc,
      seasons: sanitizeSeasonList(seasons),
      ...biblePatch,
    });
  } else if (sanitizedArc || seasons.length > 0 || Object.keys(biblePatch).length > 0) {
    // Only build + persist a seasons array when the caller actually sent
    // some — otherwise an arc-only re-import on a series that already has
    // seasons rewrites the array byte-for-byte identical (just to bump
    // sanitizeSeasonList's normalization), a wasted disk write.
    const seasonsPatch = seasons.length > 0
      ? { seasons: sanitizeSeasonList(mergeSeasons(
          Array.isArray(series.seasons) ? series.seasons : [],
          seasons,
        )) }
      : {};
    updatedSeries = await updateSeries(series.id, {
      ...(sanitizedArc ? { arc: sanitizedArc } : {}),
      ...seasonsPatch,
      ...biblePatch,
    });
  }

  // seasonNumber → season-record map; missing seasonNumber falls through
  // to the LOWEST-NUMBERED season (not array-position [0]), or null when no
  // seasons exist. mergeSeasons returns `[...retained, ...incomingBuilt]`
  // — retained existing seasons come first regardless of number, so an
  // import that adds season 1 to a series already holding [2, 3] would
  // otherwise pick season 2 as "first" and surprise the user.
  const seasonByNumber = new Map();
  for (const s of (updatedSeries.seasons || [])) {
    if (Number.isFinite(s.number)) seasonByNumber.set(s.number, s);
  }
  const sortedSeasons = [...(updatedSeries.seasons || [])]
    .filter((s) => Number.isFinite(s.number))
    .sort((a, b) => a.number - b.number);
  const fallbackSeason = sortedSeasons[0] || null;
  const fallbackSeasonId = fallbackSeason?.id || null;

  const createdIssueIds = [];
  // Surface season-remap events so the UI can warn "issue 3 wanted season 5
  // but landed in S2 — Diaspora." Each entry carries the actual landed
  // season's number + title so the client toast can be specific, not just
  // "first season" (which can lie when seasons are sparsely numbered).
  const remappedIssues = [];

  // Thread C fix — issue-loop with rollback on failure. The universe +
  // series are already written above. If createIssue throws mid-loop (e.g.
  // transient FS error) we delete every issue created so far and re-throw,
  // leaving the universe + series in their updated state but with no partial
  // issue set. The universe + series writes are kept because they represent
  // user-confirmed data; only the issue set is all-or-nothing from the
  // commit's perspective.
  try {
    for (const proposal of issuesWithPositions) {
      let seasonId = fallbackSeasonId;
      if (proposal.seasonNumber != null) {
        const matched = seasonByNumber.get(proposal.seasonNumber);
        if (matched) {
          seasonId = matched.id;
        } else {
          remappedIssues.push({
            title: proposal.title,
            arcPosition: proposal.arcPosition,
            requestedSeasonNumber: proposal.seasonNumber,
            actualSeasonId: fallbackSeasonId,
            // Surface the landed season's number + title so the UI can
            // render a precise toast ("Issue 'Cold Iron' landed in S2 —
            // Diaspora") instead of an inaccurate "first season".
            actualSeasonNumber: fallbackSeason?.number ?? null,
            actualSeasonTitle: fallbackSeason?.title ?? null,
          });
        }
      }
      // Bundle stage seeds into the initial createIssue payload so the
      // serialized write tail handles one write per issue instead of
      // create + updateStage(prose) + updateStage(idea).
      const stages = {};
      if (proposal.proseExcerpt) {
        // Route the verbatim excerpt to the stage that matches the source form
        // (see CONTENT_TYPE_SEED_STAGE): a comic-script seeds stages.comicScript
        // (ready) so the pipeline renders the user's verbatim script instead of
        // regenerating it; everything else seeds stages.prose.
        stages[seedStageFor(contentType)] = { status: 'ready', output: proposal.proseExcerpt };
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
    // `context.arcAlreadyPersisted` tells the client to drop arc + seasons +
    // canon from the retry payload — otherwise the retry overwrites any edits
    // (parallel tab, collaborator) made to the persisted state after the
    // failure. `skipArcOnRetry` is the imperative form of the same signal.
    const n = issues.length;
    const partial = Object.assign(
      new Error(
        `The universe and series were updated successfully, but ${createdIssueIds.length} of ${n} issue${n === 1 ? '' : 's'} failed and were rolled back — retry to create the remaining issues. (Original error: ${issueErr.message})`,
      ),
      {
        code: ERR_PARTIAL_COMMIT_ISSUES,
        context: {
          universeId: updatedUniverse.id,
          seriesId: updatedSeries.id,
          arcAlreadyPersisted: true,
          skipArcOnRetry: true,
        },
      },
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

