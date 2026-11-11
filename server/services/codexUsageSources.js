import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';
import { parseCodexRollout } from '../lib/providerTranscriptUsage.js';
import { fingerprintRecords, readInventorySource, trimInventoryCache, writeInventorySource } from './codexInventoryCache.js';

// Verified metadata only, never records: path -> { revision, source }. Oldest
// entries age out, which costs one store read; the persisted store owns the records.
const sourceInventory = new Map();
const SOURCE_INVENTORY_ENTRIES = 100_000;
// path -> the decode running right now. Keyed to a revision, so a joiner never gets
// bytes older than the stat it just took; that is why the walk itself is not shared.
const decodesInFlight = new Map();
export const codexSessionClaimKey = id => `codex-session:v1:${id}`;
export const codexIdentityHash = value => hash(value);

const DAY_MS = 86_400_000;
const GIB = 1024 * 1024 * 1024;
// decodedBytes is a CPU backstop, not a memory bound: skipped lines are never
// buffered, and retained memory is bounded by `records`. A heavy install decodes
// tens of GB per week of mostly tool output, so `milliseconds` is the operative
// ceiling; docs/CODEX_USAGE_PREVIEW.md records why 256 MiB was not kept.
const CODEX_PREVIEW_LIMITS = Object.freeze({
  files: 10_000, entries: 100_000, decodedBytes: 256 * GIB,
  records: 100_000, lineBytes: 1024 * 1024, milliseconds: 30_000, depth: 16
});
// Routine accounting converges across passes, so only decoding spends a budget:
// - cold*: decoding a pass admits. A source already started finishes; the rest wait.
// - records, decodedBytes, lineBytes: per source. Over them only that source is held.
// - files, entries: ceilings on the walk and on per-source metadata held for a pass.
const CODEX_ROUTINE_LIMITS = Object.freeze({
  files: 250_000, entries: 1_000_000, depth: 16, milliseconds: 30_000,
  decodedBytes: 256 * GIB, records: 100_000, lineBytes: 1024 * 1024,
  coldFiles: 5_000, coldBytes: 64 * GIB, coldMilliseconds: 20_000,
  cacheBytes: 256 * 1024 * 1024
});
// What ends one caller's pass, as opposed to describing the source being read.
const PASS_STOPS = ['cancelled', 'time_limit'];
const BUDGET_STOPS = ['decoded_byte_limit', 'record_limit'];
// Envelopes that accountingRecord always drops, recognized from the serialized
// prefix so tool output and images are neither parsed nor held in memory. Any
// other shape falls through to the strict parse, so unknown lines still fail closed.
const NON_ACCOUNTING_LINE = /^\{(?:"[a-z_]{1,32}":(?:"[^"]{0,64}"|\d{1,20}),){0,4}"type":"(?:compacted"|(?:response_item|event_msg)","payload":\{"type":"(?!token_count"|agent_message"|thread_settings_applied")[^"]{1,64}")/;
const LINE_PREFIX_BYTES = 256;
const isNonAccountingLine = bytes => NON_ACCOUNTING_LINE.test(bytes.latin1Slice(0, Math.min(bytes.length, LINE_PREFIX_BYTES)));
const PROBLEM_SOURCE_SAMPLE = 5;
// `cache_write_input_tokens` (a few 0.145-era CLIs only) is a separate part of
// `input_tokens`, disjoint from the cached read; `total_tokens` stays input + output.
const COUNTERS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const emptyTotals = () => ({ messages: 0, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const problem = code => Object.assign(new Error(code), { code });
const hash = value => createHash('sha256').update(value).digest('hex');
const isObject = value => value != null && typeof value === 'object' && !Array.isArray(value);

function codexPreviewRange(from, to) {
  const day = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw problem('INVALID_DATE_RANGE');
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw problem('INVALID_DATE_RANGE');
    return ms;
  };
  const start = day(from);
  const end = day(to);
  if (end < start || end - start >= 366 * DAY_MS) throw problem('INVALID_DATE_RANGE');
  return { from: start, to: end + DAY_MS - 1 };
}

// Project BEFORE retaining or fingerprinting: no cwd, prompt, tool output or
// assistant text survives a line. Hash identities; only model slugs can escape.
function accountingRecord(entry, ids, lineage) {
  if (!isObject(entry)) throw problem('malformed');
  const payload = entry.payload;
  if (entry.type === 'session_meta') {
    if (!isObject(payload) || typeof payload.id !== 'string' || !payload.id || payload.id.length > 256) throw problem('malformed');
    // A forked subagent rollout embeds the parent's meta right after its own. That
    // names its ancestry, not a second identity; the parent's counters are not here.
    if (payload.id === lineage.forkedFrom) return null;
    lineage.forkedFrom ??= payload.forked_from_id;
    const id = hash(payload.id);
    ids.add(id);
    const model = projectModel(payload.model);
    // The parent's id (hashed like every identity) lets a reader recognize the
    // parent events an older fork replays under new timestamps.
    const forkedFrom = typeof payload.forked_from_id === 'string' && payload.forked_from_id ? hash(payload.forked_from_id) : null;
    return { type: 'session_meta', payload: { id, ...(model ? { model } : {}), ...(forkedFrom ? { forkedFrom } : {}) } };
  }
  if (entry.type === 'turn_context') {
    const model = projectModel(payload?.model);
    return model ? { type: 'turn_context', payload: { model } } : null;
  }
  if (payload?.type === 'thread_settings_applied') {
    // The tier is the only setting accounting may keep. cwd, account ids and
    // the rest of thread_settings stay in the source file. A missing tier is
    // a reset to standard: dropping the event would leave an earlier Fast
    // tier in effect for every later count.
    const tier = payload.service_tier ?? payload.thread_settings?.service_tier;
    const timestamp = entry.timestamp;
    if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return null;
    if (tier == null || tier === '') {
      return { timestamp, payload: { type: 'thread_settings_applied', service_tier: 'standard' } };
    }
    if (typeof tier !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(tier)) return null;
    return { timestamp, payload: { type: 'thread_settings_applied', service_tier: tier } };
  }
  if (payload?.type !== 'token_count' && payload?.type !== 'agent_message') return null;
  const timestamp = entry.timestamp;
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) throw problem('malformed');
  if (payload.type === 'agent_message') return { timestamp, payload: { type: 'agent_message' } };
  // Codex also writes rate-limit updates with info:null, without usage counters.
  if (payload.info == null) return null;
  const total = payload.info.total_token_usage;
  if (!isObject(total) || total.input_tokens == null || total.output_tokens == null) throw problem('malformed');
  const counters = (source) => {
    const usage = {};
    for (const key of COUNTERS) {
      const value = source[key] ?? 0;
      if (!Number.isSafeInteger(value) || value < 0) throw problem('malformed');
      usage[key] = value;
    }
    if (usage.cached_input_tokens + usage.cache_write_input_tokens > usage.input_tokens || usage.reasoning_output_tokens > usage.output_tokens) throw problem('malformed');
    return usage;
  };
  const last = payload.info.last_token_usage;
  // The per-call counters are what a call cost; the cumulative ones can start
  // from a base a fork inherited. Optional: older rollouts may lack them.
  const lastUsage = isObject(last) && last.input_tokens != null && last.output_tokens != null ? counters(last) : null;
  return { timestamp, payload: { type: 'token_count', info: { total_token_usage: counters(total), ...(lastUsage ? { last_token_usage: lastUsage } : {}) } } };
}

function projectModel(model) {
  if (model == null) return null;
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(model)) throw problem('malformed');
  return model;
}

function scanLimits(overrides, ceilings) {
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in ceilings) || !Number.isSafeInteger(value) || value < 1 || value > ceilings[key]) throw problem('INVALID_LIMIT');
  }
  return { ...ceilings, ...overrides };
}

async function* discover(directory, state, depth = 0) {
  state.check();
  const info = await lstat(directory).catch(error => {
    if (error.code === 'ENOENT' && depth === 0) return null;
    state.issue('unreadable_directory');
    return null;
  });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) { state.issue('unsupported_entry'); return; }
  if (depth > state.limits.depth) { state.issue('depth_limit'); return; }
  const dir = await opendir(directory).catch(() => { state.issue('unreadable_directory'); return null; });
  if (!dir) return;
  for await (const entry of dir) {
    state.check();
    if (++state.coverage.entriesVisited > state.limits.entries) throw problem('entry_limit');
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* discover(path, state, depth + 1);
    else if (entry.isFile() && /\.jsonl(?:\.zst)?$/.test(entry.name)) {
      yield path;
    } else if (entry.isSymbolicLink()) state.issue('unsupported_entry');
  }
}

function unchanged(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function inspectFile(path, state, range, decompress) {
  let cwd = null;
  const ids = new Set();
  const lineage = { forkedFrom: null };
  const records = [];
  const issues = new Set();
  const compressed = path.endsWith('.zst');
  // Routine limits apply per source; preview's are cumulative over the scan.
  const baseRecords = state.routine ? state.coverage.recordsRead : 0;
  const baseBytes = state.routine ? state.coverage.decodedBytes : 0;
  const addLine = bytes => {
    state.check();
    if (isNonAccountingLine(bytes)) return;
    if (bytes.length > state.limits.lineBytes) throw problem('line_limit');
    // JSON and UTF-8 errors are source defects, not silently skipped lines.
    try {
      const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
      if (!line) return;
      const entry = JSON.parse(line);
      const record = accountingRecord(entry, ids, lineage);
      if (!record) return;
      if (record.type === 'session_meta' && typeof entry.payload.cwd === 'string') cwd = entry.payload.cwd;
      if (++state.coverage.recordsRead - baseRecords > state.limits.records) throw problem('record_limit');
      records.push(record);
    } catch (error) {
      if (error.code === 'record_limit') throw error;
      issues.add('malformed');
    }
  };
  let handle;
  try {
    state.check();
    if (compressed && typeof decompress !== 'function') throw problem('unsupported_compression');
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile()) throw problem('unsupported_entry');
    if (before.size) {
      // Read only the captured extent; appends cannot turn this into an endless
      // scan. A second stat invalidates the source rather than trusting a prefix.
      const input = handle.createReadStream({ autoClose: false, end: before.size - 1, highWaterMark: 64 * 1024 });
      const consume = async chunks => {
        let pending = Buffer.alloc(0);
        let skipping = false;
        for await (const chunk of chunks) {
          state.check();
          state.coverage.decodedBytes += chunk.length;
          if (state.coverage.decodedBytes - baseBytes > state.limits.decodedBytes) throw problem('decoded_byte_limit');
          let tail = chunk;
          if (skipping) {
            const newline = chunk.indexOf(10);
            if (newline === -1) continue;
            tail = chunk.subarray(newline + 1);
            skipping = false;
          }
          const data = pending.length ? Buffer.concat([pending, tail]) : tail;
          let start = 0;
          let end;
          while ((end = data.indexOf(10, start)) !== -1) {
            addLine(data.subarray(start, end));
            start = end + 1;
          }
          const rest = data.subarray(start);
          skipping = isNonAccountingLine(rest);
          pending = skipping ? Buffer.alloc(0) : Buffer.from(rest);
          if (pending.length > state.limits.lineBytes) throw problem('line_limit');
        }
        if (pending.length) addLine(pending);
      };
      await pipeline(...[input, ...(compressed ? [decompress()] : []), consume], { signal: state.signal });
    } else if (compressed) issues.add('invalid_compression');
    const after = await lstat(path);
    if (!unchanged(before, await handle.stat()) || !unchanged(before, after)) issues.add('source_changed');
  } catch (error) {
    const reason = state.stopReason() || error.code;
    if (PASS_STOPS.includes(reason) || (!state.routine && BUDGET_STOPS.includes(reason))) state.stopped = reason;
    issues.add([...PASS_STOPS, ...BUDGET_STOPS, 'line_limit', 'unsupported_compression', 'unsupported_entry'].includes(reason)
      ? reason : compressed ? 'invalid_compression' : 'unreadable_source');
  } finally {
    await handle?.close();
  }
  if (ids.size !== 1) issues.add(ids.size ? 'conflicting_identity' : 'missing_identity');
  return { ids, records, cwd, issues: [...issues], valid: !issues.size, fingerprint: fingerprintRecords(records),
    byModel: issues.size || !range ? {} : parseCodexRollout(records, range).byModel, loadRecords: async () => records };
}

const inventoryIncomplete = (issues, { stopped = null, problemSources = [], progress = null } = {}) => {
  const reasons = Object.entries(issues).map(([reason, count]) => `${reason}=${count}`).join(', ') || 'unknown';
  // Reasons and counts only: this message reaches the logs. Source names stay on the error.
  const indexed = progress ? ` (${progress.indexed} of ${progress.total} sources indexed)` : '';
  return Object.assign(new Error(`Codex source inventory is incomplete: ${reasons}${indexed}`), {
    code: 'CODEX_SOURCES_INCOMPLETE', issues: { ...issues }, stopped, problemSources, progress
  });
};

function storedSource(path, revision, { id, cwd, fingerprint }) {
  const source = {
    ids: new Set([id]), cwd, issues: [], valid: true, fingerprint, byModel: {},
    // Read per session so a pass never holds a whole window's records at once.
    loadRecords: async () => {
      const stored = await readInventorySource(hash(path), revision);
      if (stored?.fingerprint === fingerprint) return stored.records;
      if (sourceInventory.get(path)?.source === source) sourceInventory.delete(path);
      throw inventoryIncomplete({ source_changed: 1 });
    }
  };
  sourceInventory.delete(path);
  sourceInventory.set(path, { revision, source });
  if (sourceInventory.size > SOURCE_INVENTORY_ENTRIES) sourceInventory.delete(sourceInventory.keys().next().value);
  return source;
}

async function decodeAndStore(path, revision, info, state, decompress) {
  const source = await inspectFile(path, state, null, decompress);
  if (!source.valid) {
    sourceInventory.delete(path);
    return source;
  }
  const [id] = source.ids;
  const projection = { revision, id, cwd: source.cwd, fingerprint: source.fingerprint };
  if (await writeInventorySource(hash(path), { ...projection, records: source.records, sourceMtimeMs: info.mtimeMs })) {
    return storedSource(path, revision, projection);
  }
  state.retainedRecords += source.records.length;
  if (state.retainedRecords > state.limits.records) throw problem('record_limit');
  return source;
}

const coldBudgetSpent = ({ coverage, limits, started }) => coverage.filesInspected - coverage.filesCached >= limits.coldFiles
  || coverage.decodedBytes >= limits.coldBytes || performance.now() - started >= limits.coldMilliseconds;

/** A verified source, or null when this pass's cold budget leaves it for a later one. */
async function readRoutineSource(path, revision, info, state, decompress) {
  const { coverage, limits } = state;
  // A runtime without the decoder must report that, not coast on an earlier decode.
  if (!path.endsWith('.zst') || typeof decompress === 'function') {
    const known = sourceInventory.get(path);
    if (known?.revision === revision) {
      coverage.filesCached++;
      return known.source;
    }
    const stored = await readInventorySource(hash(path), revision);
    if (stored) {
      coverage.filesCached++;
      return storedSource(path, revision, stored);
    }
  }
  const running = decodesInFlight.get(path);
  if (running?.revision === revision && running.decompress === decompress
    && running.lineBytes === limits.lineBytes && running.records === limits.records && running.decodedBytes === limits.decodedBytes) {
    const shared = await running.result;
    // The owner's deadline or cancellation says nothing about this source.
    if (!shared.issues.some(issue => PASS_STOPS.includes(issue))) {
      coverage.filesCached++;
      return shared;
    }
  }
  if (coldBudgetSpent(state)) {
    coverage.filesPending++;
    return null;
  }
  const result = decodeAndStore(path, revision, info, state, decompress);
  const entry = { revision, decompress, lineBytes: limits.lineBytes, records: limits.records, decodedBytes: limits.decodedBytes, result };
  decodesInFlight.set(path, entry);
  try {
    return await result;
  } finally {
    if (decodesInFlight.get(path) === entry) decodesInFlight.delete(path);
  }
}

/** Explicit, read-only aggregate preview; no ledger or provider dependencies.
 * Limits may be lowered, never disabled. All returned fields are path/text-free.
 * An invalid copy taints every identity it names, including earlier good copies.
 * `modifiedSince` skips files last written before it: they cannot hold a later
 * record, so lifetime history does not spend a recent window's budget.
 */
async function scanCodexSources({ from, to, home = homedir(), limits: overrides = {}, signal,
  decompress = zlib.createZstdDecompress, accounting = false, cache = false, modifiedSince = null } = {}) {
  const range = accounting ? null : codexPreviewRange(from, to);
  const floor = accounting ? modifiedSince : range.from;
  const routine = accounting && cache;
  const limits = scanLimits(overrides, routine ? CODEX_ROUTINE_LIMITS : CODEX_PREVIEW_LIMITS);
  if (typeof home !== 'string' || !home) throw problem('INVALID_HOME');
  const controller = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), limits.milliseconds);
  const coverage = { complete: false, filesDiscovered: 0, filesInspected: 0, filesCached: 0, filesPending: 0, entriesVisited: 0,
    decodedBytes: 0, recordsRead: 0, logicalSessions: 0, resolvedSessions: 0, unresolvedSessions: 0, duplicateCopies: 0, issues: {} };
  const state = {
    limits, coverage, routine, started, retainedRecords: 0, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    stopped: null,
    stopReason: () => signal?.aborted ? 'cancelled' : controller.signal.aborted || performance.now() - started >= limits.milliseconds ? 'time_limit' : null,
    check() { const reason = this.stopped || this.stopReason(); if (reason) throw problem(reason); },
    issue(reason) { coverage.issues[reason] = (coverage.issues[reason] ?? 0) + 1; }
  };
  const sessions = new Map();
  const revisions = [];
  const problemSources = [];
  try {
    // Refuse symlinked source roots as well as symlinked descendants.
    const codex = home === homedir() && process.env.CODEX_HOME || join(home, '.codex');
    const root = await lstat(codex).catch(error => {
      if (error.code !== 'ENOENT') state.issue('unreadable_directory');
      return null;
    });
    if (root && (!root.isDirectory() || root.isSymbolicLink())) state.issue('unsupported_entry');
    else if (root) for (const directory of ['sessions', 'archived_sessions']) {
      for await (const path of discover(join(codex, directory), state)) {
        const info = await lstat(path).catch(() => null);
        if (info && floor != null && info.mtimeMs < floor) continue;
        if (coverage.filesDiscovered >= limits.files) throw problem('file_limit');
        coverage.filesDiscovered++;
        const revision = info ? [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':') : 'missing';
        const source = routine
          ? await readRoutineSource(path, revision, info, state, decompress)
          : await inspectFile(path, state, range, decompress);
        if (!source) continue;
        for (const issue of source.issues) state.issue(issue);
        revisions.push([hash(path), revision, source.fingerprint, source.valid]);
        coverage.filesInspected++;
        if (!source.valid && problemSources.length < PROBLEM_SOURCE_SAMPLE) problemSources.push({ source: relative(codex, path), issues: source.issues });
        for (const id of source.ids) {
          const previous = sessions.get(id);
          if (!previous) sessions.set(id, { id, valid: source.valid, fingerprint: source.fingerprint, byModel: source.byModel, loadRecords: source.loadRecords, cwd: source.cwd, paths: [path] });
          else {
            coverage.duplicateCopies++;
            previous.paths.push(path);
            if (previous.fingerprint !== source.fingerprint || previous.cwd !== source.cwd) { state.issue('conflicting_copies'); previous.valid = false; }
            previous.valid &&= source.valid;
          }
        }
        state.check();
      }
    }
    state.check();
  } catch (error) {
    const reason = state.stopReason() || error.code;
    state.stopped = ['cancelled', 'time_limit', 'file_limit', 'entry_limit', 'decoded_byte_limit', 'record_limit'].includes(reason) ? reason : 'discovery_failed';
    if (!coverage.issues[state.stopped]) state.issue(state.stopped);
  } finally {
    clearTimeout(timer);
  }
  const byModel = Object.create(null);
  const totals = emptyTotals();
  for (const session of sessions.values()) {
    coverage.logicalSessions++;
    if (!session.valid) { coverage.unresolvedSessions++; continue; }
    coverage.resolvedSessions++;
    for (const [model, counts] of Object.entries(session.byModel)) {
      byModel[model] ??= emptyTotals();
      for (const key of Object.keys(totals)) { byModel[model][key] += counts[key]; totals[key] += counts[key]; }
    }
  }
  const overflow = Object.values(totals).some(value => !Number.isSafeInteger(value));
  if (overflow) state.issue('counter_overflow');
  if (coverage.filesPending) {
    coverage.issues.indexing_pending = coverage.filesPending;
    state.stopped ??= 'indexing_pending';
  }
  coverage.complete = !Object.keys(coverage.issues).length;
  if (routine) await trimInventoryCache(limits.cacheBytes);
  if (accounting) return {
    sessions: [...sessions.values()].filter(session => session.valid), coverage, stopped: state.stopped, problemSources,
    revision: hash(JSON.stringify([revisions.sort((a, b) => a[0].localeCompare(b[0])), coverage.issues]))
  };
  return { range: { from, to, timezone: 'UTC', inclusive: true }, limits,
    coverage, stopped: state.stopped, compressionSupported: typeof decompress === 'function',
    totals: overflow ? null : totals, byModel: overflow ? {} : byModel,
    ledgerOverlap: 'unknown', missingUsage: null,
    notice: 'Observed counters from resolved sources are not proven missing usage. Prior ledger attribution is unknown; incomplete coverage may hide additional copies or conflicts.' };
}

/** Internal accounting metadata only. Never expose paths/cwd/records in routes.
 * The projection store is disposable; persisted claims remain authoritative.
 * Fresh scans are used by explicit preview/apply to reject changed evidence.
 * A session's `loadRecords()` rejects CODEX_SOURCES_INCOMPLETE once its stored
 * projection is gone; callers must not advance anything until every load succeeded.
 */
export const readCodexAccountingSources = options => scanCodexSources({ ...options, accounting: true, cache: options?.cache ?? true });
export const previewCodexUsage = options => scanCodexSources(options);

/** Never reserve or replace trustworthy counts from an incomplete inventory; say which sources held it back. */
export function assertCodexInventoryComplete({ coverage, stopped = null, problemSources = [] }) {
  if (coverage.complete) return;
  throw inventoryIncomplete(coverage.issues, { stopped, problemSources, progress: { indexed: coverage.filesInspected, total: coverage.filesDiscovered } });
}
