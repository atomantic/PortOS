import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';
import { parseCodexRollout } from '../lib/providerTranscriptUsage.js';

const DAY_MS = 86_400_000;
const CODEX_PREVIEW_LIMITS = Object.freeze({
  files: 10_000, entries: 100_000, decodedBytes: 256 * 1024 * 1024,
  records: 100_000, lineBytes: 1024 * 1024, milliseconds: 30_000, depth: 16
});
const COUNTERS = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
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
function accountingRecord(entry, ids) {
  if (!isObject(entry)) throw problem('malformed');
  const payload = entry.payload;
  if (entry.type === 'session_meta') {
    if (!isObject(payload) || typeof payload.id !== 'string' || !payload.id || payload.id.length > 256) throw problem('malformed');
    const id = hash(payload.id);
    ids.add(id);
    const model = projectModel(payload.model);
    return { type: 'session_meta', payload: { id, ...(model ? { model } : {}) } };
  }
  if (entry.type === 'turn_context') {
    const model = projectModel(payload?.model);
    return model ? { type: 'turn_context', payload: { model } } : null;
  }
  if (payload?.type !== 'token_count' && payload?.type !== 'agent_message') return null;
  const timestamp = entry.timestamp;
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) throw problem('malformed');
  if (payload.type === 'agent_message') return { timestamp, payload: { type: 'agent_message' } };
  // Codex also writes rate-limit updates with info:null, without usage counters.
  if (payload.info == null) return null;
  const total = payload.info.total_token_usage;
  if (!isObject(total) || total.input_tokens == null || total.output_tokens == null) throw problem('malformed');
  const usage = {};
  for (const key of COUNTERS) {
    const value = total[key] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) throw problem('malformed');
    usage[key] = value;
  }
  if (usage.cached_input_tokens > usage.input_tokens || usage.reasoning_output_tokens > usage.output_tokens) throw problem('malformed');
  return { timestamp, payload: { type: 'token_count', info: { total_token_usage: usage } } };
}

function projectModel(model) {
  if (model == null) return null;
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(model)) throw problem('malformed');
  return model;
}

function scanLimits(overrides) {
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in CODEX_PREVIEW_LIMITS) || !Number.isSafeInteger(value) || value < 1 || value > CODEX_PREVIEW_LIMITS[key]) throw problem('INVALID_LIMIT');
  }
  return { ...CODEX_PREVIEW_LIMITS, ...overrides };
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
      if (state.coverage.filesDiscovered >= state.limits.files) throw problem('file_limit');
      state.coverage.filesDiscovered++;
      yield path;
    } else if (entry.isSymbolicLink()) state.issue('unsupported_entry');
  }
}

function unchanged(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function inspectFile(path, state, range, decompress) {
  const ids = new Set();
  const records = [];
  const fingerprint = createHash('sha256');
  const issues = new Set();
  const compressed = path.endsWith('.zst');
  const addLine = bytes => {
    state.check();
    if (bytes.length > state.limits.lineBytes) throw problem('line_limit');
    // JSON and UTF-8 errors are source defects, not silently skipped lines.
    try {
      const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
      if (!line) return;
      const record = accountingRecord(JSON.parse(line), ids);
      if (!record) return;
      if (++state.coverage.recordsRead > state.limits.records) throw problem('record_limit');
      records.push(record);
      fingerprint.update(`${JSON.stringify(record)}\n`);
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
        for await (const chunk of chunks) {
          state.check();
          state.coverage.decodedBytes += chunk.length;
          if (state.coverage.decodedBytes > state.limits.decodedBytes) throw problem('decoded_byte_limit');
          const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
          let start = 0;
          let end;
          while ((end = data.indexOf(10, start)) !== -1) {
            addLine(data.subarray(start, end));
            start = end + 1;
          }
          pending = Buffer.from(data.subarray(start));
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
    if (['cancelled', 'time_limit', 'decoded_byte_limit', 'record_limit'].includes(reason)) state.stopped = reason;
    issues.add(['cancelled', 'time_limit', 'decoded_byte_limit', 'record_limit', 'line_limit', 'unsupported_compression', 'unsupported_entry'].includes(reason)
      ? reason : compressed ? 'invalid_compression' : 'unreadable_source');
  } finally {
    await handle?.close();
  }
  if (ids.size !== 1) issues.add(ids.size ? 'conflicting_identity' : 'missing_identity');
  for (const issue of issues) state.issue(issue);
  return { ids, valid: !issues.size, fingerprint: fingerprint.digest('hex'), byModel: issues.size ? {} : parseCodexRollout(records, range).byModel };
}

/** Explicit, read-only aggregate preview; no ledger or provider dependencies.
 * Limits may be lowered, never disabled. All returned fields are path/text-free.
 * An invalid copy taints every identity it names, including earlier good copies.
 */
export async function previewCodexUsage({ from, to, home = homedir(), limits: overrides = {}, signal,
  decompress = zlib.createZstdDecompress } = {}) {
  const range = codexPreviewRange(from, to);
  const limits = scanLimits(overrides);
  if (typeof home !== 'string' || !home) throw problem('INVALID_HOME');
  const controller = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), limits.milliseconds);
  const coverage = { complete: false, filesDiscovered: 0, filesInspected: 0, entriesVisited: 0,
    decodedBytes: 0, recordsRead: 0, logicalSessions: 0, resolvedSessions: 0, unresolvedSessions: 0, duplicateCopies: 0, issues: {} };
  const state = {
    limits, coverage, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    stopped: null,
    stopReason: () => signal?.aborted ? 'cancelled' : controller.signal.aborted || performance.now() - started >= limits.milliseconds ? 'time_limit' : null,
    check() { const reason = this.stopped || this.stopReason(); if (reason) throw problem(reason); },
    issue(reason) { coverage.issues[reason] = (coverage.issues[reason] ?? 0) + 1; }
  };
  const sessions = new Map();
  try {
    // Refuse symlinked source roots as well as symlinked descendants.
    const codex = join(home, '.codex');
    const root = await lstat(codex).catch(error => {
      if (error.code !== 'ENOENT') state.issue('unreadable_directory');
      return null;
    });
    if (root && (!root.isDirectory() || root.isSymbolicLink())) state.issue('unsupported_entry');
    else if (root) for (const directory of ['sessions', 'archived_sessions']) {
      for await (const path of discover(join(codex, directory), state)) {
        const source = await inspectFile(path, state, range, decompress);
        coverage.filesInspected++;
        for (const id of source.ids) {
          const previous = sessions.get(id);
          if (!previous) sessions.set(id, { valid: source.valid, fingerprint: source.fingerprint, byModel: source.byModel });
          else {
            coverage.duplicateCopies++;
            if (previous.fingerprint !== source.fingerprint) { state.issue('conflicting_copies'); previous.valid = false; }
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
  coverage.complete = !Object.keys(coverage.issues).length;
  return { range: { from, to, timezone: 'UTC', inclusive: true }, limits,
    coverage, stopped: state.stopped, compressionSupported: typeof decompress === 'function',
    totals: overflow ? null : totals, byModel: overflow ? {} : byModel,
    ledgerOverlap: 'unknown', missingUsage: null,
    notice: 'Observed counters from resolved sources are not proven missing usage. Prior ledger attribution is unknown; incomplete coverage may hide additional copies or conflicts.' };
}
