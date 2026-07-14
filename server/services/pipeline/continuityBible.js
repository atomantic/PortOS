/**
 * Pipeline — Continuity Bible facts ledger (#1305, PR 1).
 *
 * An **established-facts ledger** the manuscript is checked against: concrete,
 * checkable facts about the story world — character physical traits, ages &
 * birthdays, dates & elapsed time, locations/geography, possessions/wardrobe,
 * world rules, and who-knows-what-when. The ledger is **auto-seeded from
 * universe canon** (locked canon is treated as ground truth) and then **learned
 * from the drafted prose** via an LLM extraction pass.
 *
 * This PR ships the ledger artifact + a browsable "Series Continuity" view. The
 * four contradiction checks (canon / timeline / knowledge-leak / wardrobe-prop-
 * injury) that read this ledger land in a follow-up PR against the editorial
 * check registry (#1284) — the ledger is the substrate they consume.
 *
 * Stored as a sibling of the series record at
 * `data/pipeline-series/{id}/continuity-bible.json` (same pattern as
 * `reverse-outline.json`) so it travels with the series folder without bloating
 * the LWW-merged series `index.json`. Two hashes pin the inputs so the UI flags
 * the ledger stale once either the manuscript (`sourceContentHash`) or the canon
 * (`sourceCanonHash`) changes. Writes serialize on a per-series tail (single
 * tail per shared file, per CLAUDE.md). The SSE wrapper mirrors
 * reverseOutline.js via lib/sseUtils.js.
 */

import { join } from 'path';
import { createHash } from 'crypto';
import { atomicWrite, readJSONFile } from '../../lib/fileUtils.js';
import { createKeyedFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { createSseRunner } from '../../lib/sseUtils.js';
import { runStagedLLM, resolveStageContext } from '../../lib/stageRunner.js';
import { manuscriptContentBudgetChars, estimateTokens } from '../../lib/contextBudget.js';
import { seriesStore, getSeries } from './series.js';
import { getSeriesCanon } from './seriesCanon.js';
import { collectManuscriptSections, sectionsCorpus } from './arcPlanner.js';

const STAGE = 'pipeline-continuity-bible';

// Storage-layout version for the ledger document. Bump + migrate if the fact
// shape changes in a way an older reader can't tolerate.
const SCHEMA_VERSION = 1;

const LEDGER_FILE = 'continuity-bible.json';
const ledgerPath = (seriesId) => join(seriesStore().recordDir(seriesId), LEDGER_FILE);

// Ordered fact categories — the buckets the issue enumerates. Order drives the
// view's section order; ids are the stored `fact.category` values.
export const FACT_CATEGORIES = Object.freeze([
  { id: 'physical', label: 'Physical traits' },
  { id: 'age', label: 'Ages & birthdays' },
  { id: 'timeline', label: 'Dates & elapsed time' },
  { id: 'location', label: 'Locations & geography' },
  { id: 'possession', label: 'Possessions & wardrobe' },
  { id: 'world-rule', label: 'World rules' },
  { id: 'knowledge', label: 'Who knows what, when' },
]);
const CATEGORY_IDS = new Set(FACT_CATEGORIES.map((c) => c.id));

// Map each canon kind to the fact category it seeds.
const CANON_KIND_CATEGORY = Object.freeze({ character: 'physical', place: 'location', object: 'possession' });

// Defensive caps on LLM output — never trust raw model JSON.
const MAX_FACTS = 1_000;
const SUBJECT_MAX = 120;
const STATEMENT_MAX = 600;
const ANCHOR_MAX = 240;

// Output space reserved when budgeting the manuscript chunk against the model's
// context window (see manuscriptContentBudgetChars in generateContinuityBible,
// mirrors reverseOutline) — the corpus scales to fill the window above a manuscript
// floor, so a big-context model reads the whole manuscript while a small one trims.
const LEDGER_OUTPUT_RESERVE_TOKENS = 6_000;

const nowIso = () => new Date().toISOString();
const clampStr = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Content hash — pins an input so a later edit flips the ledger to `stale`.
const contentHash = (text) => createHash('sha256').update(text || '').digest('hex');

// Defense-in-depth: refuse path-traversal-shaped ids before they reach the
// on-disk ledger path. Series ids are `ser-<uuid>` — restrict to a safe charset.
function assertValidSeriesId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid series id: ${id}`);
  }
}

// ---------- per-series write tail ----------

const queueLedgerWrite = createKeyedFileWriteQueue();

// ---------- canon seeding ----------

// Stable dedup key for a fact — category + subject + statement, case/space
// normalized — so a prose fact that merely restates a canon fact is dropped.
const factKey = (f) => `${f.category}::${(f.subject || '').toLowerCase().trim()}::${(f.statement || '').toLowerCase().trim()}`;

/**
 * Seed checkable facts directly from universe canon. Each character with a
 * physical description, each place with a description, and each object with a
 * description becomes a ground-truth fact. `locked` canon is flagged
 * `canonical: true` so downstream contradiction checks (PR 2) treat it as
 * authoritative rather than just one more observation.
 */
export function seedFactsFromCanon(canon) {
  const out = [];
  const push = (kind, entry, description) => {
    const subject = clampStr(entry?.name, SUBJECT_MAX);
    const statement = clampStr(description, STATEMENT_MAX);
    if (!subject || !statement) return;
    out.push({
      category: CANON_KIND_CATEGORY[kind],
      subject,
      statement,
      source: 'canon',
      canonical: entry?.locked === true,
      canonKind: kind,
      canonEntryId: typeof entry?.id === 'string' ? entry.id : null,
      issueNumber: null,
      anchorQuote: null,
    });
  };
  // Characters: `physicalDescription` with the legacy `description` read-fallback
  // (mirrors universeCanon.js / canonPrompt.js) so existing installs that stored
  // canon under `description` still seed — and edits to it move sourceCanonHash.
  for (const c of Array.isArray(canon?.characters) ? canon.characters : []) push('character', c, c?.physicalDescription || c?.description);
  for (const p of Array.isArray(canon?.places) ? canon.places : []) push('place', p, p?.description);
  for (const o of Array.isArray(canon?.objects) ? canon.objects : []) push('object', o, o?.description);
  return out;
}

// ---------- sanitize LLM output ----------

// Shape one prose-extracted fact. Returns null for anything missing a category,
// subject, or statement so the ledger never carries half-facts.
function sanitizeProseFact(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const category = typeof raw.category === 'string' && CATEGORY_IDS.has(raw.category) ? raw.category : null;
  const subject = clampStr(raw.subject, SUBJECT_MAX);
  const statement = clampStr(raw.statement, STATEMENT_MAX);
  if (!category || !subject || !statement) return null;
  return {
    category,
    subject,
    statement,
    source: 'prose',
    canonical: false,
    canonKind: null,
    canonEntryId: null,
    issueNumber: Number.isInteger(raw.issueNumber) ? raw.issueNumber : null,
    anchorQuote: clampStr(raw.anchorQuote, ANCHOR_MAX) || null,
  };
}

/**
 * Merge canon-seeded facts with prose-extracted facts. Canon facts come first
 * (ground truth), then prose facts whose (category, subject, statement) key
 * isn't already present. Ids are assigned stably by final position. Exported
 * via __testing.
 */
function buildFacts(canonFacts, parsed) {
  const merged = [];
  const seen = new Set();
  const add = (f) => {
    const key = factKey(f);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(f);
  };
  for (const f of Array.isArray(canonFacts) ? canonFacts : []) add(f);
  const rawProse = Array.isArray(parsed?.facts) ? parsed.facts : [];
  for (const raw of rawProse) {
    if (merged.length >= MAX_FACTS) break;
    const f = sanitizeProseFact(raw);
    if (f) add(f);
  }
  return merged
    .slice(0, MAX_FACTS)
    .map((f, idx) => ({ id: `fact-${String(idx + 1).padStart(3, '0')}`, ...f }));
}

// ---------- storage ----------

const emptyLedger = () => ({ schemaVersion: SCHEMA_VERSION, status: 'none', facts: [] });

async function readLedger(seriesId) {
  // `null` = file absent (distinct from a present-but-empty ledger).
  const raw = await readJSONFile(ledgerPath(seriesId), null);
  if (raw == null || typeof raw !== 'object') return null;
  return raw;
}

async function writeLedger(seriesId, ledger) {
  await atomicWrite(ledgerPath(seriesId), ledger);
}

// ---------- input corpus + hashes ----------

// Stitch the drafted manuscript into one corpus + the number→section map. The
// canon is hashed off a stable shape (the seeded facts) so a canon edit that
// changes a description flips the ledger to stale just like a prose edit.
async function buildInputs(seriesId) {
  const sections = await collectManuscriptSections(seriesId);
  const byNumber = new Map(sections.map((s) => [s.number, s]));
  const series = await getSeries(seriesId).catch(() => null);
  const canon = series ? await getSeriesCanon(series).catch(() => null) : null;
  const canonFacts = seedFactsFromCanon(canon || {});
  return {
    series,
    corpus: sectionsCorpus(sections),
    byNumber,
    canonFacts,
    canonHash: contentHash(JSON.stringify(canonFacts)),
  };
}

// ---------- generation ----------

/**
 * Generate (or refresh) the continuity-bible facts ledger for a series. Returns
 * the stored ledger, a `{ status:'no-content' }` marker when there's no canon
 * AND no drafted prose to learn from, or the cached ledger when both inputs are
 * unchanged and `!force`.
 *
 * @param {string} seriesId
 * @param {object} [options]
 *   - providerId / model — forwarded to the LLM stage (autopilot/manual override)
 *   - force — re-extract even when both input hashes are unchanged
 *   - signal — AbortSignal checked before the persist
 */
export async function generateContinuityBible(seriesId, { providerId, model, force = false, signal } = {}) {
  assertValidSeriesId(seriesId);
  const { series, corpus, byNumber, canonFacts, canonHash } = await buildInputs(seriesId);
  const hasProse = corpus.trim().length > 0;
  if (!hasProse && canonFacts.length === 0) return { seriesId, status: 'no-content' };

  const hash = contentHash(corpus);
  const existing = await readLedger(seriesId);
  if (
    !force && existing && existing.status === 'complete' &&
    existing.sourceContentHash === hash && existing.sourceCanonHash === canonHash
  ) {
    return { ...existing, stale: false, cached: true };
  }

  // Extract facts from prose only when there's prose to read; an empty draft
  // still produces a canon-only ledger (no wasted LLM call).
  let parsed = { facts: [] };
  let result = { providerId, model, runId: null };
  let truncated = false;
  if (hasProse) {
    const characterNames = (canonFacts.filter((f) => f.canonKind === 'character').map((f) => f.subject)).slice(0, 60);
    const { contextWindow } = await resolveStageContext(STAGE, { providerOverride: providerId, modelOverride: model });
    const overheadTokens = 1_500 + estimateTokens([series?.name || '', characterNames.join(', ')].join(' '));
    const contentMax = manuscriptContentBudgetChars({
      contextWindow,
      overheadTokens,
      outputReserveTokens: LEDGER_OUTPUT_RESERVE_TOKENS,
    });
    truncated = corpus.length > contentMax;

    const vars = {
      series: { name: series?.name || 'Untitled series', styleNotes: series?.styleNotes || '' },
      knownCharacters: characterNames.length ? characterNames.join(', ') : '(none on record)',
      categories: FACT_CATEGORIES.map((c) => `- ${c.id}: ${c.label}`).join('\n'),
      manuscript: truncated
        ? `${corpus.slice(0, contentMax)}\n\n[manuscript truncated for analysis — ${corpus.length} chars total]`
        : corpus,
    };

    result = await runStagedLLM(STAGE, vars, {
      returnsJson: true,
      providerOverride: providerId,
      modelOverride: model,
      source: 'pipeline-continuity-bible',
    });
    parsed = result.content;
    if (signal?.aborted) return { seriesId, status: 'canceled' };
    // Drop any model-reported issueNumber that doesn't match a real manuscript
    // section, so a hallucinated number can't render a dead "Open issue" deep-link.
    if (parsed && Array.isArray(parsed.facts)) {
      for (const f of parsed.facts) {
        if (f && Number.isInteger(f.issueNumber) && !byNumber.has(f.issueNumber)) f.issueNumber = null;
      }
    }
  }

  const facts = buildFacts(canonFacts, parsed);
  const ledger = {
    seriesId,
    schemaVersion: SCHEMA_VERSION,
    status: 'complete',
    sourceContentHash: hash,
    sourceCanonHash: canonHash,
    truncated,
    providerId: result.providerId || providerId || null,
    model: result.model || model || null,
    runId: result.runId || null,
    generatedAt: nowIso(),
    facts,
  };
  await queueLedgerWrite(seriesId, () => writeLedger(seriesId, ledger));
  const canonCount = facts.filter((f) => f.source === 'canon').length;
  console.log(`📖 continuity bible: series=${String(seriesId).slice(0, 12)} facts=${facts.length} (canon=${canonCount}, prose=${facts.length - canonCount})`);
  return { ...ledger, stale: false };
}

// Single source of truth for staleness — a stored hash no longer matches its
// current input (manuscript or canon). A legacy ledger missing a hash is treated
// as not-stale for that input (can't tell).
function isLedgerStale(ledger, { hash, canonHash }) {
  if (!ledger || ledger.status !== 'complete') return false;
  if (ledger.sourceContentHash && ledger.sourceContentHash !== hash) return true;
  if (ledger.sourceCanonHash && ledger.sourceCanonHash !== canonHash) return true;
  return false;
}

/**
 * Read the stored ledger with a `stale` flag. Returns a shell (never null) when
 * one has never been generated, so the route/UI has a consistent shape — and
 * distinguishes `none` (no ledger yet, but there IS canon or draftable prose)
 * from `no-content` (nothing to build a ledger from at all).
 */
export async function getContinuityBible(seriesId) {
  assertValidSeriesId(seriesId);
  const ledger = await readLedger(seriesId);
  const { corpus, canonFacts, canonHash } = await buildInputs(seriesId);
  const hasContent = corpus.trim().length > 0 || canonFacts.length > 0;
  // Ship the category list with every response so the view renders the labels
  // the server defines (mirrors reverseOutline shipping `plotlines`) — no
  // hand-synced copy on the client to drift when a category is added/renamed.
  if (!ledger) {
    return { ...emptyLedger(), seriesId, categories: FACT_CATEGORIES, status: hasContent ? 'none' : 'no-content' };
  }
  return { ...ledger, seriesId, categories: FACT_CATEGORIES, stale: isLedgerStale(ledger, { hash: contentHash(corpus), canonHash }) };
}

/**
 * Canonical facts-ledger accessor for downstream editorial checks (PR 2:
 * canon-contradiction, timeline, knowledge-leak, wardrobe/prop/injury). Returns
 * the stored facts (empty when never generated) plus a `stale` flag so a
 * consumer can decide whether to trust or regenerate.
 */
export async function getFactsLedger(seriesId) {
  const ledger = await getContinuityBible(seriesId);
  return {
    seriesId,
    facts: ledger.facts || [],
    status: ledger.status || 'none',
    stale: ledger.stale === true,
  };
}

// ---------------------------------------------------------------------------
// SSE run-tracking — shared lifecycle via createSseRunner (server/lib/sseUtils.js),
// the same factory backing reverseOutline + editorial/checkRunner.
// ---------------------------------------------------------------------------

const runner = createSseRunner({ logLabel: 'continuity bible' });

export function isContinuityBibleActive(seriesId) {
  return runner.isActive(seriesId);
}

export function attachClient(seriesId, res) {
  return runner.attachClient(seriesId, res);
}

export function cancelContinuityBible(seriesId) {
  return runner.cancel(seriesId);
}

/**
 * Kick off a streamed continuity-bible generation. Returns the runId
 * immediately; progress + the terminal frame land via SSE. Re-calling while a
 * run is in flight resolves to the existing runId.
 */
export function startContinuityBibleRun(seriesId, options = {}) {
  return runner.start(seriesId, async ({ runId, signal, record, broadcast }) => {
    broadcast({ type: 'start', runId });
    const result = await generateContinuityBible(seriesId, {
      providerId: options.providerId,
      model: options.model,
      force: options.force,
      signal,
    });
    if (record.cancelRequested || result.status === 'canceled') {
      broadcast({ type: 'canceled', runId, canceledAt: nowIso() });
      console.log(`📖 continuity bible canceled — series=${String(seriesId).slice(0, 12)}`);
      return;
    }
    if (result.status === 'no-content') {
      broadcast({ type: 'complete', runId, status: 'no-content', factCount: 0, completedAt: nowIso() });
      return;
    }
    broadcast({
      type: 'complete',
      runId,
      status: 'complete',
      factCount: result.facts?.length || 0,
      completedAt: nowIso(),
    });
  });
}

// Export internals for tests.
export const __testing = { seedFactsFromCanon, sanitizeProseFact, buildFacts, isLedgerStale, contentHash, factKey, runs: runner.runs };
