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
const RUNTIME_VERSION = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,32}$/;
const MAX_RUNTIME_VERSIONS = 32;
const date = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

function project(family, entry, parts) {
  if (family === 'claude') {
    if (entry?.type !== 'assistant') return null;
    const usage = entry.message?.usage;
    const breakdown = usage?.cache_creation;
    return { key: identity(entry.message?.id) ? entry.message.id : null, at: date(entry.timestamp),
      values: ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].map(key => usage?.[key]),
      requestId: identity(entry.requestId) ? entry.requestId : null, final: identity(entry.message?.stop_reason),
      version: entry.version,
      inconsistent: Boolean(breakdown) && (breakdown.ephemeral_5m_input_tokens ?? 0) + (breakdown.ephemeral_1h_input_tokens ?? 0) !== usage.cache_creation_input_tokens };
  }
  if (family === 'agy') {
    if (entry?.type !== 'PLANNER_RESPONSE') return null;
    return { key: counter(entry.step_index) ? [parts[0], entry.step_index] : null, at: date(entry.created_at),
      values: ['input_tokens', 'output_tokens', 'cache_read_tokens'].map(key => entry[key]) };
  }
  const update = entry?.params?.update;
  if (update?.sessionUpdate !== 'turn_completed') return null;
  const timestamp = entry.params?._meta?.agentTimestampMs ?? (typeof entry.timestamp === 'number' ? entry.timestamp * (entry.timestamp < 1e11 ? 1000 : 1) : null);
  const usage = update.usage;
  return { costTicks: counter(usage?.costUsdTicks),
    // Grok documents input/output as including cached/reasoning, so these are contract breaks.
    inconsistent: [usage?.inputTokens, usage?.outputTokens, usage?.totalTokens].every(counter)
      && (usage.totalTokens !== usage.inputTokens + usage.outputTokens || usage.cachedReadTokens > usage.inputTokens),
    key: identity(entry.params?.sessionId) && identity(update.prompt_id) ? [entry.params.sessionId, update.prompt_id] : null,
    at: date(timestamp), values: ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cacheCreationTokens'].map(key => update.usage?.[key]),
    // Model counters have no validated additive contract either. Include a stable
    // fingerprint so contradictory duplicate emissions cannot look identical.
    modelUsage: update.usage?.modelUsage ?? null };
}

/** Claude rewrites one API response as it streams: same message and request, same
 * input/cache counters, output growing, and only the final emission carries
 * stop_reason. Resolved to that final emission whatever order files are read in, so
 * a copy with a different request or input stays a real conflict.
 */
function reconcileStreamed(prior, next, signature) {
  if (!prior.requestId || prior.requestId !== next.requestId || !prior.measured || !next.measured) return false;
  if (![0, 2, 3].every(index => prior.values[index] === next.values[index])) return false;
  if (prior.final && next.final) return false;
  const adopt = () => { prior.values = next.values; prior.signature = signature; };
  if (prior.final) return next.values[1] <= prior.values[1];
  if (next.final) {
    if (next.values[1] < prior.values[1]) return false;
    adopt();
    prior.final = true;
    return true;
  }
  if (next.values[1] > prior.values[1]) adopt();
  prior.partialsDiffer = true;
  return true;
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
    skippedLinks: 0, missingSource: false, capped: false, stoppedEarly: false, oversizedLines: 0, streamingSupersededRecords: 0,
    unfinalizedRecords: 0, fieldInconsistentRecords: 0, runtimeVersions: [], steps: null, cacheOverlap: null, costTickRecords: null,
    firstObservedAt: null, lastObservedAt: null, retention: 'unknown' };
  const started = Date.now();
  let bytes = 0;
  let entries = 0;
  const records = new Map();
  const versions = new Set();
  const conversations = new Map();
  const conversation = id => {
    if (!conversations.has(id)) conversations.set(id, { steps: new Set(), measured: 0, unmeasured: 0 });
    return conversations.get(id);
  };
  const stop = () => { coverage.capped = true; coverage.stoppedEarly = true; };
  const exhausted = () => {
    if (Date.now() - started >= limits.milliseconds || bytes >= limits.bytes || entries >= limits.entries || coverage.records >= limits.records) stop();
    return coverage.stoppedEarly;
  };
  const consume = (line, parts) => {
    if (!line.trim()) return;
    const entry = safeParse(line);
    if (!entry || typeof entry !== 'object') { coverage.invalidLines++; return; }
    if (family === 'agy' && counter(entry.step_index)) conversation(parts[0]).steps.add(entry.step_index);
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
    if (record.inconsistent) coverage.fieldInconsistentRecords++;
    if (RUNTIME_VERSION.test(record.version ?? '') && versions.size < MAX_RUNTIME_VERSIONS) versions.add(record.version);
    if (!record.key) { coverage.missingIdentityRecords++; return; }
    const key = hash(record.key);
    const signature = hash([record.values, record.modelUsage]);
    const prior = records.get(key);
    if (prior) {
      coverage.duplicateRecords++;
      if (prior.signature === signature) prior.final ||= record.final === true;
      else if (!prior.conflict) {
        if (family === 'claude' && reconcileStreamed(prior, { ...record, measured }, signature)) coverage.streamingSupersededRecords++;
        else { prior.conflict = true; coverage.conflictingRecords++; }
      }
    } else {
      records.set(key, { signature, values: record.values.map(value => counter(value) ? value : null), measured, conflict: false,
        requestId: record.requestId ?? null, final: record.final === true, partialsDiffer: false, costTicks: record.costTicks === true });
      if (family === 'agy') { const tally = conversation(parts[0]); if (measured) tally.measured++; else tally.unmeasured++; }
    }
  };
  const read = async (path, parts) => {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
    if (!handle) { coverage.unreadableFiles++; return; }
    const stat = await handle.stat().catch(() => null);
    if (!stat?.isFile()) { coverage.unreadableFiles++; await handle.close(); return; }
    coverage.files++;
    const stream = handle.createReadStream({ highWaterMark: 64 * 1024, autoClose: true });
    let pending = Buffer.alloc(0);
    // One oversized record must not end the scan: most are attachments that carry
    // no usage. It stays reported, because this line was not read.
    let skippingLine = false;
    const oversized = () => { coverage.capped = true; coverage.oversizedLines++; };
    await (async () => {
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (exhausted()) break;
        pending = Buffer.concat([pending, chunk]);
        let newline;
        while ((newline = pending.indexOf(10)) !== -1) {
          if (skippingLine) skippingLine = false;
          else if (newline > limits.lineBytes) oversized();
          else consume(pending.subarray(0, newline).toString('utf8'), parts);
          pending = pending.subarray(newline + 1);
          if (exhausted()) break;
        }
        if (pending.length > limits.lineBytes) {
          if (!skippingLine) oversized();
          skippingLine = true;
          pending = Buffer.alloc(0);
        }
        if (exhausted()) break;
      }
      // A trailing non-newline record may be an in-progress append, not a
      // completed emission. Never silently count it as authoritative.
      if (!coverage.stoppedEarly && !skippingLine && pending.length) coverage.invalidLines++;
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
          if (next.length >= limits.depth) { stop(); break; }
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
  const overlap = { cacheExceedsInputRecords: 0, cacheWithinInputRecords: 0 };
  let costTickRecords = 0;
  for (const record of records.values()) {
    // Differing partials with no final emission leave the output count unknowable.
    if (record.partialsDiffer && !record.final && !record.conflict) { record.conflict = true; coverage.conflictingRecords++; }
    if (record.costTicks) costTickRecords++;
    if (!record.measured || record.conflict) continue;
    coverage.measuredRecords++;
    if (family === 'claude' && !record.final) coverage.unfinalizedRecords++;
    if (family === 'agy') overlap[record.values[2] > record.values[0] ? 'cacheExceedsInputRecords' : 'cacheWithinInputRecords']++;
    record.values.forEach((value, index) => { totals[index] += counter(value) ? value : 0; });
  }
  coverage.runtimeVersions = [...versions].sort();
  if (family === 'grok') coverage.costTickRecords = costTickRecords;
  if (family === 'agy') {
    coverage.cacheOverlap = overlap;
    // Step indexes start at 0, so a hole below the highest seen index is a known gap.
    // Steps after the last retained one cannot be detected.
    const gaps = [...conversations.values()].map(({ steps }) => (steps.size ? [...steps].reduce((high, step) => Math.max(high, step), 0) + 1 - steps.size : 0));
    coverage.steps = { conversations: conversations.size,
      conversationsWithStepGaps: gaps.filter(Boolean).length,
      missingStepIndexes: gaps.reduce((sum, gap) => sum + gap, 0),
      conversationsPartiallyMeasured: [...conversations.values()].filter(({ measured, unmeasured }) => measured && unmeasured).length };
  }
  const totalTokens = totals.reduce((sum, value) => sum + value, 0);
  const overflow = !totals.every(counter) || (family === 'claude' && !counter(totalTokens));
  const partial = coverage.capped || coverage.missingUsageRecords || coverage.missingIdentityRecords || coverage.conflictingRecords
    || coverage.invalidLines || coverage.unreadableFiles || coverage.undatedRecords || coverage.skippedLinks || coverage.unfinalizedRecords
    || coverage.fieldInconsistentRecords || coverage.steps?.missingStepIndexes || overflow || family === 'grok';
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
