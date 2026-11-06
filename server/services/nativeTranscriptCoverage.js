import { opendir, open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { safeParse } from '../lib/streamJsonParser.js';

// Diagnostic reads only. No ledger, reconciliation, estimates, or provider calls.
const LIMITS = { bytes: 128 * 1024 * 1024, lineBytes: 1024 * 1024, entries: 30000, records: 100000, milliseconds: 5000, depth: 8 };
const roots = { claude: ['.claude', 'projects'], grok: ['.grok', 'sessions'], agy: ['.gemini', 'antigravity-cli', 'brain'] };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
const counter = value => Number.isSafeInteger(value) && value >= 0;
const date = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

function project(family, entry, parts) {
  if (family === 'claude') {
    if (entry?.type !== 'assistant') return null;
    return { key: identity(entry.message?.id) ? entry.message.id : null, at: date(entry.timestamp),
      values: ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].map(key => entry.message?.usage?.[key]) };
  }
  if (family === 'agy') {
    if (entry?.type !== 'PLANNER_RESPONSE') return null;
    return { key: counter(entry.step_index) ? [parts[0], entry.step_index] : null, at: date(entry.created_at),
      values: ['input_tokens', 'output_tokens', 'cache_read_tokens'].map(key => entry[key]) };
  }
  const update = entry?.params?.update;
  if (update?.sessionUpdate !== 'turn_completed') return null;
  const timestamp = entry.params?._meta?.agentTimestampMs ?? (typeof entry.timestamp === 'number' ? entry.timestamp * (entry.timestamp < 1e11 ? 1000 : 1) : null);
  return { key: identity(entry.params?.sessionId) && identity(update.prompt_id) ? [entry.params.sessionId, update.prompt_id] : null,
    at: date(timestamp), values: ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cacheCreationTokens'].map(key => update.usage?.[key]),
    // Model counters have no validated additive contract either. Include a stable
    // fingerprint so contradictory duplicate emissions cannot look identical.
    modelUsage: update.usage?.modelUsage ?? null };
}

function isTranscript(family, parts) {
  if (family === 'claude') return parts.at(-1).endsWith('.jsonl');
  if (family === 'grok') return parts.length === 3 && parts[2] === 'updates.jsonl';
  return parts.length === 4 && parts[1] === '.system_generated' && parts[2] === 'logs' && parts[3] === 'transcript.jsonl';
}

/** Bounded streaming projection of retained files. Historical gaps remain unknown,
 * even after an exhaustive scan of today's files. Internal limits are injectable
 * for synthetic boundary tests; no HTTP parameter can change roots or limits.
 */
export async function getNativeTranscriptCoverage(family, { home = homedir(), limits: overrides = {} } = {}) {
  if (!Object.hasOwn(roots, family)) throw new Error('Unsupported native transcript family');
  const limits = { ...LIMITS, ...overrides };
  const coverage = { files: 0, records: 0, measuredRecords: 0, missingUsageRecords: 0, missingIdentityRecords: 0,
    duplicateRecords: 0, conflictingRecords: 0, invalidLines: 0, undatedRecords: 0, unreadableFiles: 0,
    skippedLinks: 0, missingSource: false, capped: false, firstObservedAt: null, lastObservedAt: null, retention: 'unknown' };
  const started = Date.now();
  let bytes = 0;
  let entries = 0;
  const records = new Map();
  const exhausted = () => {
    if (Date.now() - started >= limits.milliseconds || bytes >= limits.bytes || entries >= limits.entries || coverage.records >= limits.records) coverage.capped = true;
    return coverage.capped;
  };
  const consume = (line, parts) => {
    if (!line.trim()) return;
    const entry = safeParse(line);
    if (!entry || typeof entry !== 'object') { coverage.invalidLines++; return; }
    const record = project(family, entry, parts);
    if (!record) return;
    coverage.records++;
    if (!record.at) coverage.undatedRecords++;
    else {
      if (!coverage.firstObservedAt || record.at < coverage.firstObservedAt) coverage.firstObservedAt = record.at;
      if (!coverage.lastObservedAt || record.at > coverage.lastObservedAt) coverage.lastObservedAt = record.at;
    }
    const measured = family === 'grok' ? record.values.slice(0, 2).every(counter) : record.values.every(counter);
    if (!measured) coverage.missingUsageRecords++;
    if (!record.key) { coverage.missingIdentityRecords++; return; }
    const key = hash(record.key);
    const signature = hash([record.values, record.modelUsage]);
    const prior = records.get(key);
    if (prior) {
      coverage.duplicateRecords++;
      if (prior.signature !== signature && !prior.conflict) { prior.conflict = true; coverage.conflictingRecords++; }
    } else records.set(key, { signature, values: record.values.map(value => counter(value) ? value : null), measured, conflict: false });
  };
  const read = async (path, parts) => {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
    if (!handle) { coverage.unreadableFiles++; return; }
    const stat = await handle.stat().catch(() => null);
    if (!stat?.isFile()) { coverage.unreadableFiles++; await handle.close(); return; }
    coverage.files++;
    const stream = handle.createReadStream({ highWaterMark: 64 * 1024, autoClose: true });
    let pending = Buffer.alloc(0);
    await (async () => {
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (exhausted()) break;
        pending = Buffer.concat([pending, chunk]);
        let newline;
        while ((newline = pending.indexOf(10)) !== -1) {
          if (newline > limits.lineBytes) { coverage.capped = true; break; }
          consume(pending.subarray(0, newline).toString('utf8'), parts);
          pending = pending.subarray(newline + 1);
          if (exhausted()) break;
        }
        if (pending.length > limits.lineBytes) coverage.capped = true;
        if (exhausted()) break;
      }
      // A trailing non-newline record may be an in-progress append, not a
      // completed emission. Never silently count it as authoritative.
      if (!coverage.capped && pending.length) coverage.invalidLines++;
    })().catch(() => { coverage.unreadableFiles++; });
    stream.destroy();
  };
  const walk = async (path, parts = []) => {
    const info = await lstat(path).catch(error => {
      if (!parts.length && error.code === 'ENOENT') coverage.missingSource = true;
      return null;
    });
    if (!info) { if (!coverage.missingSource) coverage.unreadableFiles++; return; }
    if (info?.isSymbolicLink()) { coverage.skippedLinks++; return; }
    const dir = await opendir(path).catch(() => null);
    if (!dir) { coverage.unreadableFiles++; return; }
    await (async () => {
      for await (const entry of dir) {
        entries++;
        if (exhausted()) break;
        const next = [...parts, entry.name];
        if (entry.isSymbolicLink()) { coverage.skippedLinks++; continue; }
        if (entry.isDirectory()) {
          if (next.length >= limits.depth) { coverage.capped = true; break; }
          await walk(join(path, entry.name), next);
        } else if (entry.isFile() && isTranscript(family, next)) await read(join(path, entry.name), next);
        if (exhausted()) break;
      }
    })().catch(() => { coverage.unreadableFiles++; });
  };
  const root = family === 'claude' && process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, 'projects') : join(home, ...roots[family]);
  await walk(root);
  const totals = [0, 0, 0, 0];
  for (const record of records.values()) {
    if (!record.measured || record.conflict) continue;
    coverage.measuredRecords++;
    record.values.forEach((value, index) => { totals[index] += counter(value) ? value : 0; });
  }
  const totalTokens = totals.reduce((sum, value) => sum + value, 0);
  const overflow = !totals.every(counter) || (family === 'claude' && !counter(totalTokens));
  const partial = coverage.capped || coverage.missingUsageRecords || coverage.missingIdentityRecords || coverage.conflictingRecords
    || coverage.invalidLines || coverage.unreadableFiles || coverage.undatedRecords || coverage.skippedLinks || overflow || family === 'grok';
  const unavailableReason = coverage.capped
    ? 'The scan reached a safety limit before finding usable native records. Retained coverage remains unknown.'
    : coverage.missingSource ? 'No retained native history directory was found. Missing or deleted history remains unknown.'
      : coverage.unreadableFiles || coverage.skippedLinks ? 'The retained native source could not be fully read. No usable records were found; coverage remains unknown.'
        : coverage.invalidLines ? 'Retained files contained invalid or incomplete records, with no usable native records found. Coverage remains unknown.'
          : 'No matching native usage records were found in the retained source. This does not establish zero historical usage.';
  return {
    status: coverage.records ? (partial ? 'partial' : 'available') : 'unavailable',
    source: `${family}:retained-transcripts`, scope: 'local-retained-transcripts', accountIdentity: null,
    aggregation: 'do-not-sum-across-instances', fetchedAt: new Date().toISOString(), completeness: 'unknown',
    semantics: family === 'grok' ? 'unvalidated-turn-counters' : 'measured-record-subset',
    summary: family === 'grok' || !coverage.measuredRecords || overflow ? null : {
      totalTokens: family === 'claude' ? totalTokens : null,
      tokensIn: totals[0], tokensOut: totals[1], cacheReadTokens: totals[2], cacheWriteTokens: family === 'agy' ? null : totals[3],
    },
    coverage, cost: { usd: null, kind: 'unknown' },
    reason: !coverage.records ? unavailableReason : family === 'grok'
      ? 'Turn counters are retained, but per-turn versus cumulative semantics are unvalidated. No authoritative total is calculated.'
      : family === 'agy' ? 'Only planner steps with all three token fields are included. Input/cache overlap, model attribution, deleted history and cost remain unknown; no combined total is calculated.'
        : 'Only uniquely identified records with all required token fields are summed. Missing or deleted history, account coverage and cost remain unknown.',
  };
}
