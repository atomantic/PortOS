import { opendir, open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { safeParse } from '../lib/streamJsonParser.js';
import { canonicalStringify } from '../lib/objects.js';
import { GROK_USAGE_FIELDS, GROK_USAGE_RECORD_LIMIT, unionNativeGrokRecords } from '../lib/nativeGrokUsageRecords.js';

const LIMITS = { bytes: 128 * 1024 * 1024, lineBytes: 1024 * 1024, entries: 30000, records: 100000, milliseconds: 5000, depth: 8 };
const counter = value => Number.isSafeInteger(value) && value >= 0;
const identity = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
const hash = value => createHash('sha256').update(canonicalStringify(value)).digest('hex');
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const valuesOf = record => GROK_USAGE_FIELDS.map(field => counter(record?.[field]) ? record[field] : null);
const validCounters = record => {
  const [input, output, cached, , reasoning, total] = valuesOf(record);
  return valuesOf(record).every(value => value !== null) && total === input + output && cached <= input && reasoning <= output;
};

/** Bounded read-only usage.json snapshots as emitted by Grok 1.0.77. No CLI,
 * auth, updates.jsonl, model inference, billing conversion or legacy ledger reads.
 * Runtime version of historical records and deleted/custom-root history are unknown.
 */
export async function getNativeGrokUsageCoverage({ home = homedir(), limits: overrides = {} } = {}) {
  const limits = { ...LIMITS, ...overrides };
  // Bound in-memory observations too, including arbitrarily many copied files.
  limits.records = Math.min(limits.records, GROK_USAGE_RECORD_LIMIT + 1);
  const coverage = { files: 0, records: 0, measuredRecords: 0, missingUsageRecords: 0, missingIdentityRecords: 0,
    duplicateRecords: 0, conflictingRecords: 0, invalidLines: 0, undatedRecords: 0, unreadableFiles: 0,
    skippedLinks: 0, missingSource: false, capped: false, stoppedEarly: false, oversizedLines: 0, streamingSupersededRecords: 0,
    unfinalizedRecords: 0, fieldInconsistentRecords: 0, runtimeVersions: [], steps: null, cacheOverlap: null, costTickRecords: null,
    firstObservedAt: null, lastObservedAt: null, retention: 'unknown' };
  const nativeUsageCoverage = { validSnapshots: 0, invalidSnapshots: 0, sessionsWithoutUsage: 0 };
  const projections = [];
  const started = Date.now();
  let bytes = 0;
  let entries = 0;
  const stop = () => { coverage.capped = true; coverage.stoppedEarly = true; };
  const exhausted = () => {
    if (Date.now() - started >= limits.milliseconds || bytes >= limits.bytes || entries >= limits.entries || coverage.records >= limits.records) stop();
    return coverage.stoppedEarly;
  };
  const consume = text => {
    const snapshot = safeParse(text);
    if (!snapshot || !Array.isArray(snapshot.turns) || !snapshot.session) { coverage.invalidLines++; nativeUsageCoverage.invalidSnapshots++; return; }
    if (!identity(snapshot.sessionId)) { coverage.missingIdentityRecords++; nativeUsageCoverage.invalidSnapshots++; return; }
    const turns = snapshot.turns;
    const turnNumbers = turns.map(turn => turn?.turnNumber);
    const valid = validCounters(snapshot.session) && snapshot.session.turnCount === turns.length
      && turnNumbers.every(number => counter(number) && number > 0) && new Set(turnNumbers).size === turns.length
      && turns.every(turn => validCounters(turn) && turn.turnCount === 1)
      && GROK_USAGE_FIELDS.every(field => {
        const sum = turns.reduce((total, turn) => total + turn[field], 0);
        return counter(sum) && sum === snapshot.session[field];
      });
    nativeUsageCoverage[valid ? 'validSnapshots' : 'invalidSnapshots']++;
    for (const turn of turns) {
      if (exhausted()) break;
      coverage.records++;
      const values = valuesOf(turn);
      if (values.some(value => value === null)) coverage.missingUsageRecords++;
      if (!valid) coverage.fieldInconsistentRecords++;
      if (!counter(turn?.turnNumber) || !turn.turnNumber) { coverage.missingIdentityRecords++; continue; }
      const at = date(turn.endedAt);
      if (!at) coverage.undatedRecords++;
      else {
        if (!coverage.firstObservedAt || at < coverage.firstObservedAt) coverage.firstObservedAt = at;
        if (!coverage.lastObservedAt || at > coverage.lastObservedAt) coverage.lastObservedAt = at;
      }
      const recordKey = hash(['portos-grok-session-turn/1', snapshot.sessionId, turn.turnNumber]);
      projections.push({ records: [{ recordKey, values, at, costUsdTicks: counter(turn.costUsdTicks) ? turn.costUsdTicks : null,
        costConflict: false, conflict: false, inconsistent: !valid }] });
    }
  };
  const read = async path => {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
    if (!handle) { coverage.unreadableFiles++; return; }
    const stat = await handle.stat().catch(() => null);
    if (!stat?.isFile()) { coverage.unreadableFiles++; await handle.close(); return; }
    coverage.files++;
    if (stat.size > limits.lineBytes) { coverage.capped = true; coverage.oversizedLines++; await handle.close(); return; }
    const chunks = [];
    let size = 0;
    const stream = handle.createReadStream({ highWaterMark: 64 * 1024, autoClose: true });
    await (async () => {
      for await (const chunk of stream) {
        size += chunk.length;
        bytes += chunk.length;
        if (exhausted()) break;
        if (size > limits.lineBytes) { coverage.capped = true; coverage.oversizedLines++; break; }
        chunks.push(chunk);
      }
      if (!coverage.stoppedEarly && size <= limits.lineBytes) consume(Buffer.concat(chunks).toString('utf8'));
    })().catch(() => { coverage.unreadableFiles++; });
    stream.destroy();
  };
  const walk = async (path, depth = 0) => {
    const info = await lstat(path).catch(error => { if (!depth && error.code === 'ENOENT') coverage.missingSource = true; return null; });
    if (!info) { if (!coverage.missingSource) coverage.unreadableFiles++; return; }
    if (info.isSymbolicLink()) { coverage.skippedLinks++; return; }
    const dir = await opendir(path).catch(() => null);
    if (!dir) { coverage.unreadableFiles++; return; }
    let usageFound = false;
    await (async () => {
      for await (const entry of dir) {
        entries++;
        if (exhausted()) break;
        if (entry.isSymbolicLink()) { coverage.skippedLinks++; continue; }
        if (depth === 2 && entry.name === 'usage.json') {
          usageFound = true;
          if (entry.isFile()) await read(join(path, entry.name));
          else coverage.unreadableFiles++;
        } else if (depth < 2 && entry.isDirectory()) {
          if (depth + 1 >= limits.depth) { stop(); break; }
          await walk(join(path, entry.name), depth + 1);
        }
      }
    })().catch(() => { coverage.unreadableFiles++; });
    if (depth === 2 && !usageFound && !coverage.stoppedEarly) nativeUsageCoverage.sessionsWithoutUsage++;
  };
  await walk(join(home, '.grok', 'sessions'));
  const union = unionNativeGrokRecords(projections);
  // Preserve excluded identities as tombstones so a clean peer copy cannot hide
  // a locally contradictory session. Deterministic, with no arbitrary winner.
  const byKey = new Map(projections.flatMap(({ records }) => records).map(record => [record.recordKey, record]));
  const accepted = new Map(union.records.map(record => [record.recordKey, record]));
  const records = [...byKey.keys()].sort().map(recordKey => accepted.get(recordKey) ?? {
    recordKey, values: [null, null, null, null, null, null, null], costUsdTicks: null, costConflict: false, conflict: true, inconsistent: false, at: null,
  });
  coverage.measuredRecords = union.coverage.measuredRecords;
  coverage.duplicateRecords = union.coverage.duplicateRecords;
  coverage.conflictingRecords = union.coverage.excluded['conflicting-records'] ?? 0;
  coverage.costTickRecords = union.cost.nativeCostSignal.measuredRecords;
  const summary = union.totals ? Object.fromEntries(['totalTokens', 'tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheWriteTokens'].map(field => [field, union.totals[field]])) : null;
  return {
    status: coverage.records ? 'partial' : 'unavailable', summary, coverage, nativeUsageCoverage,
    source: 'grok:persisted-session-usage', validator: 'grok-persisted-turns/1',
    recordProjection: { version: 1, identityScheme: 'sha256-grok-session-turn/1', truncated: coverage.records > GROK_USAGE_RECORD_LIMIT,
      records: records.slice(0, GROK_USAGE_RECORD_LIMIT) },
    cost: union.cost, findings: union.findings,
  };
}
