import { opendir, open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { safeParse } from '../lib/streamJsonParser.js';
import { canonicalStringify } from '../lib/objects.js';
import { GROK_USAGE_FIELDS, GROK_USAGE_RECORD_LIMIT, unionNativeGrokRecords } from '../lib/nativeGrokUsageRecords.js';
import { compactNativeCoverage, emptyNativeCoverage, foldNativeCounts } from '../lib/nativeUsageSourceFold.js';
import { buildNativeUsageRollup, grokModelEvidence, joinModelEvidence } from '../lib/nativeUsageRollups.js';

const LIMITS = { bytes: 128 * 1024 * 1024, lineBytes: 1024 * 1024, entries: 30000, records: 100000, milliseconds: 5000, depth: 8 };
const counter = value => Number.isSafeInteger(value) && value >= 0;
const identity = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
const hash = value => createHash('sha256').update(canonicalStringify(value)).digest('hex');
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const valuesOf = record => GROK_USAGE_FIELDS.map(field => counter(record?.[field]) ? record[field] : null);
const emptyNativeUsageCoverage = () => ({ validSnapshots: 0, invalidSnapshots: 0, sessionsWithoutUsage: 0 });
const validCounters = record => {
  const [input, output, cached, , reasoning, total] = valuesOf(record);
  return valuesOf(record).every(value => value !== null) && total === input + output && cached <= input && reasoning <= output;
};

/** Bounded read-only usage.json snapshots as emitted by Grok 1.0.77. No CLI,
 * auth, updates.jsonl, model inference, billing conversion or legacy ledger reads.
 * Runtime version of historical records and deleted/custom-root history are unknown.
 */
export async function getNativeGrokUsageCoverage({ home, sessionsRoot, limits: overrides = {}, deadline = Infinity, modelLimits, sources = null } = {}) {
  const limits = { ...LIMITS, ...overrides };
  const coverage = emptyNativeCoverage();
  const nativeUsageCoverage = emptyNativeUsageCoverage();
  const projections = [];
  const modelEvidence = new Map();
  // incompleteTurns: vendor-flagged known under-count (subagent usage not applied); counters stay in the total.
  const whole = { coverage, nativeUsageCoverage, projections, modelEvidence, incompleteTurns: 0 };
  // Readers write here. Per-source collection points it at one source at a time.
  let sink = whole;
  const started = Date.now();
  let bytes = 0;
  let entries = 0;
  let scannedRecords = 0;
  const stop = () => { coverage.capped = true; coverage.stoppedEarly = true; };
  const exhausted = () => {
    if (Date.now() >= deadline || Date.now() - started >= limits.milliseconds || bytes >= limits.bytes || entries >= limits.entries || scannedRecords >= limits.records) stop();
    return coverage.stoppedEarly;
  };
  const consume = text => {
    const snapshot = safeParse(text);
    if (!snapshot || !Array.isArray(snapshot.turns) || !snapshot.session) { sink.coverage.invalidLines++; sink.nativeUsageCoverage.invalidSnapshots++; return; }
    if (!identity(snapshot.sessionId)) { sink.coverage.missingIdentityRecords++; sink.nativeUsageCoverage.invalidSnapshots++; return; }
    const turns = snapshot.turns;
    const turnNumbers = turns.map(turn => turn?.turnNumber);
    const valid = validCounters(snapshot.session) && snapshot.session.turnCount === turns.length
      && turnNumbers.every(number => counter(number) && number > 0) && new Set(turnNumbers).size === turns.length
      && turns.every(turn => validCounters(turn) && turn.turnCount === 1)
      && GROK_USAGE_FIELDS.every(field => {
        const sum = turns.reduce((total, turn) => total + turn[field], 0);
        return counter(sum) && sum === snapshot.session[field];
      });
    sink.nativeUsageCoverage[valid ? 'validSnapshots' : 'invalidSnapshots']++;
    for (const turn of turns) {
      if (exhausted()) break;
      scannedRecords++;
      sink.coverage.records++;
      const values = valuesOf(turn);
      if (values.some(value => value === null)) sink.coverage.missingUsageRecords++;
      if (!valid) sink.coverage.fieldInconsistentRecords++;
      if (!counter(turn?.turnNumber) || !turn.turnNumber) { sink.coverage.missingIdentityRecords++; continue; }
      const at = date(turn.endedAt);
      if (!at) sink.coverage.undatedRecords++;
      else {
        if (!sink.coverage.firstObservedAt || at < sink.coverage.firstObservedAt) sink.coverage.firstObservedAt = at;
        if (!sink.coverage.lastObservedAt || at > sink.coverage.lastObservedAt) sink.coverage.lastObservedAt = at;
      }
      if (turn.usageIsIncomplete === true) sink.incompleteTurns++;
      const recordKey = hash(['portos-grok-session-turn/1', snapshot.sessionId, turn.turnNumber]);
      const prior = sink.modelEvidence.get(recordKey);
      sink.modelEvidence.set(recordKey, { evidence: joinModelEvidence(prior?.evidence, grokModelEvidence(turn, modelLimits)),
        incomplete: prior?.incomplete === true || turn.usageIsIncomplete === true });
      sink.projections.push({ records: [{ recordKey, values, at, costUsdTicks: counter(turn.costUsdTicks) ? turn.costUsdTicks : null,
        costConflict: false, conflict: false, inconsistent: !valid }] });
    }
  };
  const read = async path => {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
    if (!handle) { sink.coverage.unreadableFiles++; return; }
    const stat = await handle.stat().catch(() => null);
    if (!stat?.isFile()) { sink.coverage.unreadableFiles++; await handle.close(); return; }
    sink.coverage.files++;
    if (stat.size > limits.lineBytes) { sink.coverage.capped = true; sink.coverage.oversizedLines++; await handle.close(); return; }
    const chunks = [];
    let size = 0;
    const stream = handle.createReadStream({ highWaterMark: 64 * 1024, autoClose: true });
    await (async () => {
      for await (const chunk of stream) {
        size += chunk.length;
        bytes += chunk.length;
        if (exhausted()) break;
        if (size > limits.lineBytes) { sink.coverage.capped = true; sink.coverage.oversizedLines++; break; }
        chunks.push(chunk);
      }
      if (!coverage.stoppedEarly && size <= limits.lineBytes) consume(Buffer.concat(chunks).toString('utf8'));
    })().catch(() => { sink.coverage.unreadableFiles++; });
    stream.destroy();
  };
  const readStored = async (path, parts) => {
    const facts = await sources.check(parts, path);
    if (!facts) return;
    const source = { coverage: emptyNativeCoverage(), nativeUsageCoverage: emptyNativeUsageCoverage(), projections: [], modelEvidence: new Map(), incompleteTurns: 0 };
    sink = source;
    await read(path);
    sink = whole;
    // An unfinished read saves nothing: the source is read again next run, and any
    // earlier projection of it keeps counting meanwhile.
    coverage.unreadableFiles += source.coverage.unreadableFiles;
    if (coverage.stoppedEarly || source.coverage.unreadableFiles) return;
    await sources.save(facts, { coverage: compactNativeCoverage(source.coverage), nativeUsageCoverage: source.nativeUsageCoverage,
      incompleteTurns: source.incompleteTurns, modelEvidence: [...source.modelEvidence], records: source.projections.flatMap(({ records }) => records) });
  };
  const walk = async (path, depth = 0, parts = []) => {
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
          if (entry.isFile()) await (sources ? readStored(join(path, entry.name), [...parts, entry.name]) : read(join(path, entry.name)));
          else coverage.unreadableFiles++;
        } else if (depth < 2 && entry.isDirectory()) {
          if (depth + 1 >= limits.depth) { stop(); break; }
          await walk(join(path, entry.name), depth + 1, [...parts, entry.name]);
        }
      }
    })().catch(() => { coverage.unreadableFiles++; });
    if (depth === 2 && !usageFound && !coverage.stoppedEarly) nativeUsageCoverage.sessionsWithoutUsage++;
  };
  await walk(sessionsRoot ?? join(home ?? homedir(), '.grok', 'sessions'));
  let collectionFindings = [];
  if (sources) {
    const collected = await sources.load(coverage);
    collectionFindings = collected.findings;
    for (const { projection } of collected.stored) {
      foldNativeCounts(nativeUsageCoverage, projection.nativeUsageCoverage);
      whole.incompleteTurns += projection.incompleteTurns;
      for (const [recordKey, { evidence, incomplete }] of projection.modelEvidence) {
        const prior = modelEvidence.get(recordKey);
        modelEvidence.set(recordKey, { evidence: joinModelEvidence(prior?.evidence, evidence), incomplete: prior?.incomplete === true || incomplete });
      }
      projections.push({ records: projection.records });
    }
  }
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
    cost: union.cost,
    findings: [...union.findings, ...(whole.incompleteTurns ? ['native-usage-incomplete'] : []), ...collectionFindings],
    rollup: buildNativeUsageRollup('grok', union.records.map(({ recordKey, values, at }) => ({ at, values, ...modelEvidence.get(recordKey) })), modelLimits),
  };
}
