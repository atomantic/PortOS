import { copyFile, mkdtemp, readdir, rm, stat } from 'fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { decodeMessage } from '../lib/protobufWire.js';
import { PATHS, tryReadFile } from '../lib/fileUtils.js';
import { UNKNOWN_MODEL, codexServiceTier, parseGrokTurns, parseJsonLines, decodeGrokSessionDir, grokEventMs, totalTranscriptTokens } from '../lib/providerTranscriptUsage.js';
import { claudeNativeUsageStore } from './claudeCodeTranscriptUsage.js';
import { readCodexAccountingSources } from './codexUsageSources.js';
import { createNativeUsageStore } from './nativeUsageDayStore.js';
import { nativeUsageEvents } from './nativeUsageEvents.js';
import { overlayNativeUsage } from '../lib/nativeUsageOverlay.js';
import { familyForProvider, familyLabel } from '../lib/providerFamilies.js';

/**
 * The per-day, per-model token history each provider app records about itself,
 * read from the app's own files and kept after the app prunes them. This is the
 * Usage page's source of truth for Claude Code, Codex and Grok tokens (see
 * `lib/nativeUsageOverlay.js` for how it replaces the PortOS ledger's counts).
 *
 *   claude — `~/.claude/projects/**\/*.jsonl` (claudeCodeTranscriptUsage.js)
 *   codex  — `~/.codex/sessions` + `archived_sessions`, plain or `.zst`
 *            (codexUsageSources.js handles forks, copies and compression)
 *   grok   — `~/.grok/sessions/<cwd>/<session>/updates.jsonl` turn usage; a
 *            subagent is its own session folder (the parent's
 *            `subagents/<id>/meta.json` only links it and carries no usage)
 *   agy    — `~/.gemini/antigravity-cli/conversations/<id>.db` step metadata,
 *            else the conversation's `brain/<id>` transcript
 *
 * Every store keeps the same `input/output/cacheRead/cacheWrite` counters
 * (`input` excludes cache reads, as each tier is priced separately). Grok also
 * keeps the long-context subset, which is priced a second time. Codex and Grok
 * keep Fast and Ultrafast subsets (`fast*` / `ultrafast*`), priced from the
 * published API schedule when the transcript recorded the tier.
 *
 * Scans read local files only — no provider calls, no tokens spent.
 */

const DAY_MS = 86_400_000;
const BASE_FIELDS = ['messages', 'input', 'output', 'cacheRead', 'cacheWrite'];
const LONG_FIELDS = ['longInput', 'longOutput', 'longCacheRead', 'longCacheWrite'];
const SPEED_FIELDS = [
  'fastInput', 'fastOutput', 'fastCacheRead', 'fastCacheWrite',
  'ultrafastInput', 'ultrafastOutput', 'ultrafastCacheRead', 'ultrafastCacheWrite',
];
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayStartMs = (day) => Date.parse(`${day}T00:00:00.000Z`);
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/** Fold one model's parsed buckets (ledger field names) into a store day. */
function addBuckets(days, day, model, buckets) {
  if (totalTranscriptTokens(buckets) <= 0) return;
  days[day] ??= {};
  const row = days[day][model] ??= {};
  const add = (field, value) => { row[field] = (row[field] || 0) + (value || 0); };
  add('messages', buckets.messages);
  add('input', buckets.tokensIn);
  add('output', buckets.tokensOut);
  add('cacheRead', buckets.cacheReadTokens);
  add('cacheWrite', buckets.cacheWriteTokens);
  if ('longTokensIn' in buckets) {
    add('longInput', buckets.longTokensIn);
    add('longOutput', buckets.longTokensOut);
    add('longCacheRead', buckets.longCacheReadTokens);
    add('longCacheWrite', buckets.longCacheWriteTokens);
  }
  if ('fastTokensIn' in buckets) {
    add('fastInput', buckets.fastTokensIn);
    add('fastOutput', buckets.fastTokensOut);
    add('fastCacheRead', buckets.fastCacheReadTokens);
    add('fastCacheWrite', buckets.fastCacheWriteTokens);
  }
  if ('ultrafastTokensIn' in buckets) {
    add('ultrafastInput', buckets.ultrafastTokensIn);
    add('ultrafastOutput', buckets.ultrafastTokensOut);
    add('ultrafastCacheRead', buckets.ultrafastCacheReadTokens);
    add('ultrafastCacheWrite', buckets.ultrafastCacheWriteTokens);
  }
}

/** UTC days touched by `[firstMs, lastMs]`, starting no earlier than `from`. */
function daysBetween(firstMs, lastMs, from) {
  const out = [];
  const start = Math.max(firstMs, from ? dayStartMs(from) : -Infinity);
  for (let cursor = Math.floor(start / DAY_MS) * DAY_MS; cursor <= lastMs; cursor += DAY_MS) out.push(dayOf(cursor));
  return out;
}

/** Split one parsed session into UTC days with a windowed parser `(entries, window) => { byModel }`. */
function addSessionDays(days, entries, stamps, from, parse) {
  if (!stamps.length) return;
  for (const day of daysBetween(Math.min(...stamps), Math.max(...stamps), from)) {
    const start = dayStartMs(day);
    for (const [model, buckets] of Object.entries(parse(entries, { from: start, to: start + DAY_MS - 1 }).byModel || {})) {
      addBuckets(days, day, model, buckets);
    }
  }
}

// A live rollout appended to mid-read is re-read by the next pass, and the
// store keeps the larger count, so that alone does not hold a fold back. Any
// other gap (an unreadable or undecoded source) would drop sessions for good
// once they age out of the lookback window, so it holds the pass.
const TOLERATED_CODEX_ISSUES = new Set(['source_changed']);
// Decoding a large archive is budgeted per pass; consecutive passes resume from
// the persisted inventory cache, so a first scan converges without a wait.
const CODEX_INDEXING_PASSES = 20;

/**
 * One record per model call in a projected rollout: `{ ms, model, signature, usage }`.
 *
 * A call's cost is its `last_token_usage`. The cumulative `total_token_usage`
 * is only a fallback for rollouts that predate the per-call field: it repeats
 * unchanged on rate-limit updates, can reset, and a fork's first total already
 * includes the parent's tokens, so summing or differencing it over-counts forks
 * and drops a session's first call.
 */
function codexCalls(entries) {
  const calls = [];
  let model = null;
  let previous = null;
  let tier = 'standard';
  for (const entry of entries) {
    if (entry.type === 'session_meta') { model ??= entry.payload?.model ?? null; continue; }
    // The model a call used is the latest turn context before it.
    if (entry.type === 'turn_context') { model = entry.payload?.model ?? model; continue; }
    if (entry.payload?.type === 'thread_settings_applied') {
      tier = codexServiceTier(entry.payload.service_tier ?? entry.payload.thread_settings?.service_tier);
      continue;
    }
    if (entry.payload?.type !== 'token_count') continue;
    const total = entry.payload.info?.total_token_usage;
    const last = entry.payload.info?.last_token_usage ?? null;
    if (!total) continue;
    // A rate-limit refresh repeats the last total; it is not another call.
    if (previous && previous.total_tokens === total.total_tokens && previous.input_tokens === total.input_tokens
      && previous.output_tokens === total.output_tokens) continue;
    const fallback = !previous || total.total_tokens < previous.total_tokens ? total
      : Object.fromEntries(Object.keys(total).map((key) => [key, Math.max(0, total[key] - (previous[key] || 0))]));
    previous = total;
    const ms = Date.parse(entry.timestamp);
    if (!Number.isFinite(ms)) continue;
    calls.push({ ms, model, tier, usage: last ?? fallback,
      signature: `${last?.total_tokens ?? ''}:${last?.input_tokens ?? ''}:${last?.output_tokens ?? ''}:${total.total_tokens}` });
  }
  return calls;
}

async function readCodexInventory(home, modifiedSince) {
  let inventory;
  for (let pass = 0; pass < CODEX_INDEXING_PASSES; pass += 1) {
    inventory = await readCodexAccountingSources({ home, modifiedSince });
    if (!inventory.coverage.issues.indexing_pending) break;
    await yieldToEventLoop();
  }
  const blocking = Object.keys(inventory.coverage.issues).filter((issue) => !TOLERATED_CODEX_ISSUES.has(issue));
  return { inventory, incomplete: blocking.length ? blocking.sort().join(', ') : null };
}

async function loadCodexSessions(sources, wanted = null) {
  const sessions = [];
  for (const session of sources) {
    // Inventory ids are the same hashed identity the records carry.
    if (wanted && !wanted.has(session.id)) continue;
    const entries = await session.loadRecords();
    const meta = entries.find((entry) => entry.type === 'session_meta')?.payload;
    sessions.push({ id: meta?.id ?? session.id, forkedFrom: meta?.forkedFrom ?? null, calls: codexCalls(entries) });
    await yieldToEventLoop();
  }
  return sessions;
}

async function scanCodex({ from, home = homedir() }) {
  const modifiedSince = from ? dayStartMs(from) : null;
  const { inventory, incomplete } = await readCodexInventory(home, modifiedSince);
  if (incomplete) return { incomplete, filesScanned: inventory.coverage.filesInspected };
  const sessions = await loadCodexSessions(inventory.sessions);
  // An incremental pass skips an unchanged parent while still reading its new
  // fork; without the parent a replayed event would be counted (and the
  // max-merge would keep it), so read the missing parents from the full inventory.
  const known = new Set(sessions.map((session) => session.id));
  const missing = new Set(sessions.map((session) => session.forkedFrom).filter((id) => id && !known.has(id)));
  if (missing.size && modifiedSince != null) {
    const full = await readCodexInventory(home, null);
    if (full.incomplete) return { incomplete: full.incomplete, filesScanned: full.inventory.coverage.filesInspected };
    const parents = await loadCodexSessions(full.inventory.sessions, missing);
    // Parents only lend signatures: their own calls are outside this pass.
    for (const parent of parents) sessions.push({ ...parent, signaturesOnly: true });
  }
  // Some older forks replay the parent's events under new timestamps; those
  // calls are the parent's and are already counted there.
  const signatures = new Map(sessions.map((session) => [session.id, new Set(session.calls.map((call) => call.signature))]));
  const floor = from ? dayStartMs(from) : -Infinity;
  const days = {};
  for (const session of sessions) {
    if (session.signaturesOnly) continue;
    const parent = session.forkedFrom ? signatures.get(session.forkedFrom) : null;
    for (const call of session.calls) {
      if (call.ms < floor || parent?.has(call.signature)) continue;
      const cached = call.usage.cached_input_tokens || 0;
      const cacheWrite = call.usage.cache_write_input_tokens || 0;
      // Codex's input includes the cached read and any cache write (two disjoint
      // parts); each tier is priced on its own. A fast or ultrafast call's
      // whole bucket is that subset; the tier applies to this call only.
      const buckets = {
        messages: 1, tokensIn: Math.max(0, (call.usage.input_tokens || 0) - cached - cacheWrite), tokensOut: call.usage.output_tokens || 0,
        cacheReadTokens: cached, cacheWriteTokens: cacheWrite,
      };
      if (call.tier === 'fast' || call.tier === 'ultrafast') {
        buckets[`${call.tier}TokensIn`] = buckets.tokensIn;
        buckets[`${call.tier}TokensOut`] = buckets.tokensOut;
        buckets[`${call.tier}CacheReadTokens`] = buckets.cacheReadTokens;
        buckets[`${call.tier}CacheWriteTokens`] = buckets.cacheWriteTokens;
      }
      addBuckets(days, dayOf(call.ms), call.model || UNKNOWN_MODEL, buckets);
    }
  }
  return { days, filesScanned: inventory.coverage.filesInspected };
}

async function listSubdirs(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function scanGrok({ from, home = homedir() }) {
  const root = join(home, '.grok', 'sessions');
  const floor = from ? dayStartMs(from) : null;
  const days = {};
  let filesScanned = 0;
  for (const dirName of await listSubdirs(root)) {
    if (decodeGrokSessionDir(dirName) == null) continue;
    for (const sessionId of await listSubdirs(join(root, dirName))) {
      const path = join(root, dirName, sessionId, 'updates.jsonl');
      const info = await stat(path).catch(() => null);
      if (!info || (floor != null && info.mtimeMs < floor)) continue;
      const text = await tryReadFile(path);
      if (!text) continue;
      filesScanned += 1;
      const entries = parseJsonLines(text);
      const stamps = entries.map(grokEventMs).filter((ms) => Number.isFinite(ms));
      addSessionDays(days, entries, stamps, from, parseGrokTurns);
      await yieldToEventLoop();
    }
  }
  return { days, filesScanned };
}

// Antigravity CLI conversation DB `steps.metadata`: 1 = created (Timestamp),
// 9 = usage. Usage input excludes the cache read; output includes thinking.
// The DB's `gen_metadata` table repeats the same totals with no dates, and
// misses checkpoint steps, so it is not read.
const AGY_STEP_METADATA = {
  created: { no: 1, type: 'message', schema: { seconds: { no: 1, type: 'varint' } } },
  usage: { no: 9, type: 'message', schema: {
    input: { no: 2, type: 'varint' }, output: { no: 3, type: 'varint' },
    cacheWrite: { no: 4, type: 'varint' }, cacheRead: { no: 5, type: 'varint' },
  } },
};
const AGY_MAX_METADATA_BYTES = 1024 * 1024;

/**
 * Dated usage steps from one conversation DB, read from a private copy so a
 * live conversation is never locked or given new WAL/SHM files.
 */
async function readAgySteps(path, scratch) {
  const copy = join(scratch, 'conversation.db');
  await Promise.all(['', '-wal', '-shm'].map((suffix) => rm(`${copy}${suffix}`, { force: true })));
  await copyFile(path, copy);
  await copyFile(`${path}-wal`, `${copy}-wal`).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  const db = new DatabaseSync(copy);
  let rows;
  try {
    rows = db.prepare('SELECT metadata FROM steps WHERE length(metadata) <= ? ORDER BY idx').all(AGY_MAX_METADATA_BYTES);
  } finally {
    db.close();
  }
  const steps = [];
  for (const { metadata } of rows) {
    if (!metadata) continue;
    const { created, usage } = decodeMessage(AGY_STEP_METADATA, metadata);
    const ms = Number(created?.seconds) * 1000;
    if (usage && Number.isFinite(ms)) steps.push({ ms, usage });
  }
  return steps;
}

/** Latest mtime of a SQLite file and its WAL, or null when the file is gone. */
async function databaseMtime(path) {
  const [main, wal] = await Promise.all([path, `${path}-wal`].map((file) => stat(file).then((info) => info.mtimeMs, () => null)));
  return main == null ? null : Math.max(main, wal ?? main);
}

/**
 * Antigravity's conversation DB records measured tokens on every planner and
 * checkpoint step, with its date, from September 2026 on. The transcript's
 * `PLANNER_RESPONSE` steps hold the same counts only from mid-October, so it
 * is read only for a conversation without a readable DB. Neither names a model.
 */
async function scanAgy({ from, home = homedir() }) {
  const root = join(home, '.gemini', 'antigravity-cli');
  const floor = from ? dayStartMs(from) : null;
  const days = {};
  let filesScanned = 0;
  const add = (ms, { input, output, cacheRead, cacheWrite }) => {
    if (!Number.isFinite(ms) || (floor != null && ms < floor)) return;
    addBuckets(days, dayOf(ms), UNKNOWN_MODEL, {
      messages: 1, tokensIn: Math.max(0, input || 0), tokensOut: Math.max(0, output || 0),
      cacheReadTokens: Math.max(0, cacheRead || 0), cacheWriteTokens: Math.max(0, cacheWrite || 0),
    });
  };

  // Conversations a DB answers for, read or unchanged since `from`.
  const fromDatabase = new Set();
  const databases = join(root, 'conversations');
  const names = (await readdir(databases).catch(() => [])).filter((name) => name.endsWith('.db'));
  let scratch = null;
  try {
    for (const name of names) {
      const path = join(databases, name);
      const conversation = name.slice(0, -3);
      const mtime = await databaseMtime(path);
      if (mtime == null) continue;
      if (floor != null && mtime < floor) { fromDatabase.add(conversation); continue; }
      scratch ??= await mkdtemp(join(tmpdir(), 'portos-agy-usage-'));
      // A copy torn by a live write fails to open or decode; that conversation
      // falls back to its transcript and the next pass reads the DB again.
      const steps = await readAgySteps(path, scratch).catch((err) => {
        console.log(`⏭️ Antigravity conversation DB unreadable (${err.code ?? 'unknown'}); using its transcript`);
        return null;
      });
      if (!steps) continue;
      fromDatabase.add(conversation);
      filesScanned += 1;
      for (const { ms, usage } of steps) add(ms, usage);
      await yieldToEventLoop();
    }
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }

  const brain = join(root, 'brain');
  for (const conversation of await listSubdirs(brain)) {
    if (fromDatabase.has(conversation)) continue;
    const path = join(brain, conversation, '.system_generated', 'logs', 'transcript.jsonl');
    const info = await stat(path).catch(() => null);
    if (!info || (floor != null && info.mtimeMs < floor)) continue;
    const text = await tryReadFile(path);
    if (!text) continue;
    filesScanned += 1;
    const seen = new Set();
    for (const [index, step] of parseJsonLines(text).entries()) {
      if (step?.type !== 'PLANNER_RESPONSE' || (typeof step.input_tokens !== 'number' && typeof step.output_tokens !== 'number')) continue;
      const key = Number.isFinite(step.step_index) ? step.step_index : `#${index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      add(Date.parse(step.created_at), { input: step.input_tokens, output: step.output_tokens, cacheRead: step.cache_read_tokens });
    }
    await yieldToEventLoop();
  }
  return { days, filesScanned };
}

export const NATIVE_USAGE_STORES = Object.freeze({
  claude: claudeNativeUsageStore,
  codex: createNativeUsageStore({
    // 2: Fast/Ultrafast subsets. A stored day without them is rescanned once.
    family: 'codex', file: join(PATHS.data, 'codex-native-usage.json'), fields: [...BASE_FIELDS, ...SPEED_FIELDS], scan: scanCodex, scanVersion: 2,
  }),
  grok: createNativeUsageStore({
    // 2: Grok 4.7 Fast subset, same rescan as Codex.
    family: 'grok', file: join(PATHS.data, 'grok-native-usage.json'), fields: [...BASE_FIELDS, ...LONG_FIELDS, ...SPEED_FIELDS], scan: scanGrok, scanVersion: 2,
  }),
  agy: createNativeUsageStore({
    // 2: the conversation DB, which dates tokens the transcript never recorded.
    family: 'agy', file: join(PATHS.data, 'agy-native-usage.json'), fields: BASE_FIELDS, scan: scanAgy, scanVersion: 2,
  }),
});


let snapshot = null;

/** Read every store into the in-memory snapshot the usage report overlays. */
async function loadNativeUsageSnapshot() {
  const next = {};
  for (const [family, store] of Object.entries(NATIVE_USAGE_STORES)) {
    // An unreadable store leaves that family on the PortOS ledger rather than
    // failing the whole report.
    next[family] = await store.read().catch((err) => {
      console.error(`❌ Native ${family} usage history unreadable: ${err.message}`);
      return null;
    });
  }
  snapshot = next;
  return snapshot;
}

/** Last loaded stores, `{ [family]: { days, updatedAt, coverageStart } | null }`, or `{}` before the first load. */
function getNativeUsageSnapshot() {
  return snapshot || {};
}

/**
 * Refresh every store (each skips itself while fresh unless `force`). One
 * family's failure never stops the others.
 */
export async function refreshNativeUsageHistory({ force = false, home } = {}) {
  const results = {};
  let changed = false;
  for (const [family, store] of Object.entries(NATIVE_USAGE_STORES)) {
    const options = { force, ...(home && family !== 'claude' ? { home } : {}), ...(home && family === 'claude' ? { root: join(home, '.claude', 'projects') } : {}) };
    try {
      const result = await store.refresh(options);
      results[family] = { refreshed: result.refreshed, updatedAt: result.updatedAt, coverageStart: result.coverageStart, ...(result.incomplete ? { incomplete: result.incomplete } : {}) };
      if (result.refreshed) changed = true;
      if (result.incomplete) console.log(`⏭️ Native ${family} usage held for an incomplete read: ${result.incomplete}`);
    } catch (err) {
      results[family] = { refreshed: false, error: err.message };
      console.error(`❌ Native ${family} usage refresh failed: ${err.message}`);
    }
  }
  if (changed || !snapshot) await loadNativeUsageSnapshot();
  if (changed) nativeUsageEvents.emit('updated');
  return results;
}

/** Background keep-fresh so the report and peers stay current without opening the page. */
export function startNativeUsageRefresh({ intervalMs = 30 * 60_000, firstDelayMs = 60_000 } = {}) {
  const run = () => refreshNativeUsageHistory({ force: true }).catch((err) => {
    console.error(`❌ Native usage refresh failed: ${err.message}`);
  });
  loadNativeUsageSnapshot().catch(() => {});
  setTimeout(run, firstDelayMs).unref();
  setInterval(run, intervalMs).unref();
}

const providerSignature = (providers) => (providers || [])
  .map((provider) => [provider.id, provider.type, provider.enabled !== false, familyForProvider(provider)]);

/** A key that moves whenever a store's contents do, for callers that memoize a report. */
export function nativeUsageSignature() {
  return Object.entries(getNativeUsageSnapshot()).map(([family, store]) => `${family}:${store?.updatedAt ?? ''}:${store?.coverageStart ?? ''}`).join('|');
}

let reportedMemo = null;

/**
 * The ledger as the Usage report should read it: `usage` with its
 * `dailyActivity` overlaid by the provider apps' own history. Memoized on the
 * ledger revision, the stores and the provider configuration.
 */
export function withNativeUsage(usage, providers = []) {
  if (!usage) return usage;
  const key = JSON.stringify([usage.lastUpdated ?? null, nativeUsageSignature(), providerSignature(providers)]);
  if (reportedMemo?.usage === usage && reportedMemo.key === key) return reportedMemo.value;
  const dailyActivity = overlayNativeUsage(usage.dailyActivity, { stores: getNativeUsageSnapshot(), providers });
  const earliest = Object.keys(dailyActivity).sort()[0];
  const value = dailyActivity === usage.dailyActivity ? usage : {
    ...usage,
    dailyActivity,
    earliestActivityDay: earliest && (!usage.earliestActivityDay || earliest < usage.earliestActivityDay) ? earliest : usage.earliestActivityDay ?? null,
  };
  reportedMemo = { usage, key, value };
  return value;
}

/** What this machine's report reads from each provider app, for the Usage page's coverage note. */
export function describeNativeUsageSources() {
  return Object.entries(getNativeUsageSnapshot()).map(([family, store]) => ({
    family,
    label: familyLabel(family),
    coverageStart: store?.coverageStart ?? null,
    updatedAt: store?.updatedAt ?? null,
    hasHistory: Boolean(store && Object.keys(store.days || {}).length),
  }));
}
