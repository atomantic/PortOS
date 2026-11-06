import { assertCodexInventoryComplete, readCodexAccountingSources } from './codexUsageSources.js';
import { readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { PATHS, readJSONFile, tryReadFile } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import {
  UNKNOWN_MODEL,
  decodeGrokSessionDir,
  parseAgyTranscript,
  parseClaudeTranscript,
  parseCodexRollout,
  parseGrokTurns,
  parseJsonLines,
  totalTranscriptTokens
} from '../lib/providerTranscriptUsage.js';
import {
  WINDOW_SLACK_MS,
  agyEstimatedBuckets,
  cwdMatches,
  listAgyConversations,
  listSubdirs,
  recordsFromMeasured,
  resolveFamilyProvider
} from './usageReconciler.js';
import {
  applyHistoricalUsageCorrections,
  forgetSiblingReconciledUsageRuns,
  getInteractiveScanState,
  setInteractiveScanState
} from './usage.js';
import { grokTurnRepairId } from './grokUsageRepair.js';
import { isUsageCutoverFenced } from './usageCutoverBarrier.js';
import { diffRunRecord } from '../lib/agentRunReconcile.js';

/**
 * Attribute Claude Code, Codex, Grok and Antigravity sessions that PortOS never
 * launched.
 *
 * `usageReconciler.js` only reads a CLI's session store inside a PortOS run's
 * own workspace and time window, so everything the user does in a terminal —
 * the interactive `claude` / `codex` / `grok` / `agy` sessions (and the desktop
 * apps that write the same session stores) that actually burn the weekly quota —
 * never reached the cost report, and both plans read as far cheaper than their
 * subscription. This scan walks every session on the machine and bills what the
 * run path did NOT.
 *
 * Exclusivity with the run path is by TIME, not by ledger: a run's claim ledger
 * is in-memory and lost on restart, so a message is billed here only when its
 * timestamp falls outside every PortOS run window (widened by the same slack the
 * run path uses) in that session's cwd. A per-family watermark then makes each
 * scan cover only new time, so nothing is billed by two scans. Reads local files
 * only — no provider calls.
 *
 * The exclusion is only as tight as the run path's own window: both use
 * `WINDOW_SLACK_MS`, so widening one without the other opens a gap or an overlap.
 *
 * Results land per UTC day through `applyHistoricalUsageCorrections` (its
 * sibling-add path), so a first scan over past weeks fills the right days
 * instead of dumping a month onto today.
 */

// Legacy home of the scan state. It now lives in usage.json (`interactiveScan`) so
// a watermark commits atomically with its counts; this file is only read, once,
// to adopt an older install's watermarks, and is left on disk.
export const INTERACTIVE_SCAN_FILE = join(PATHS.data, 'usage-interactive-scan.json');

const FAMILIES = ['claude', 'codex', 'grok', 'agy'];
const DAY_MS = 86_400_000;
// A CLI flushes an event slightly after it stamps it; leaving the newest few
// minutes for the next scan keeps a still-being-written turn from being cut.
const SETTLE_MS = 5 * 60_000;
// First scan reaches back this far; later scans start at the stored watermark.
const FIRST_SCAN_LOOKBACK_DAYS = 35;

const withLock = createMutex();
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/** Pure: `[from, to]` minus every window, as inclusive ms intervals. */
function subtractWindows(from, to, windows) {
  let pieces = [[from, to]];
  for (const [ws, we] of windows) {
    pieces = pieces.flatMap(([a, b]) => {
      if (we < a || ws > b) return [[a, b]];
      const out = [];
      if (ws > a) out.push([a, ws - 1]);
      if (we < b) out.push([we + 1, b]);
      return out;
    });
  }
  return pieces.filter(([a, b]) => b >= a);
}

/** Merge overlapping coverage before parsing, so retries never count a slice twice. */
function mergeIntervals(intervals) {
  const merged = [];
  for (const [from, to] of intervals.filter(([a, b]) => a <= b).sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/** Pure: split an inclusive interval at UTC midnights → `[{ day, from, to }]`. */
function splitByUtcDay(from, to) {
  const out = [];
  for (let cursor = from; cursor <= to;) {
    const dayStart = Math.floor(cursor / DAY_MS) * DAY_MS;
    const end = Math.min(to, dayStart + DAY_MS - 1);
    out.push({ day: new Date(dayStart).toISOString().slice(0, 10), from: cursor, to: end });
    cursor = end + 1;
  }
  return out;
}

/** Every PortOS run's `[start, end]` (slack applied) by workspace, for runs touching `[from, now]`. */
async function loadRunWindows(runsDir, from, now, pick = () => true, projections = new Map(), unresolved = [], observed = new Set()) {
  const byCwd = new Map();
  for (const name of await listSubdirs(runsDir)) {
    const dir = join(runsDir, name);
    // Directory mtime cannot rule out an unfinished run: its metadata file
    // can change without touching the directory, or remain stale after death.
    const info = await stat(dir).catch(() => null);
    if (!info) continue;
    const metadata = await readJSONFile(join(dir, 'metadata.json'), null, { strict: true });
    const start = Date.parse(metadata?.startTime || '');
    if (!metadata?.workspacePath || Number.isNaN(start) || !pick(metadata)) continue;
    observed.add(metadata.id || name);
    // Only a lifecycle observation can bound a missing endTime. Absence from
    // an in-memory registry after restart does not establish when a run ended.
    let end = Date.parse(metadata.endTime || '');
    if (Number.isNaN(end)) {
      const diff = diffRunRecord(projections.get(metadata.id || name), metadata);
      const observedEnd = Date.parse(diff?.finding === 'record-open' ? diff.detail.ledgerEndedAt : '');
      if (Number.isFinite(observedEnd) && observedEnd >= start) end = observedEnd;
      else unresolved.push({ runId: metadata.id || name, workspacePath: metadata.workspacePath, from: start - WINDOW_SLACK_MS, to: now });
    }
    if (Number.isFinite(end) && end + WINDOW_SLACK_MS < from) continue;
    const window = [start - WINDOW_SLACK_MS, (Number.isNaN(end) ? now : end) + WINDOW_SLACK_MS];
    if (!byCwd.has(metadata.workspacePath)) byCwd.set(metadata.workspacePath, []);
    byCwd.get(metadata.workspacePath).push(window);
    await yieldToEventLoop();
  }
  return byCwd;
}

const windowsFor = (byCwd, sessionCwd) => {
  const out = [];
  // Unknown cwd (an agy conversation history never logged): any PortOS run
  // window may own it, so subtract them all rather than risk double-billing.
  if (!sessionCwd) return [...byCwd.values()].flat();
  for (const [workspacePath, windows] of byCwd) {
    if (cwdMatches(sessionCwd, workspacePath)) out.push(...windows);
  }
  return out;
};

// The CLI's own override applies only to the real home; a fixture home wins.
const cliHome = (home, envVar, dirName) => (home === homedir() && process.env[envVar]) || join(home, dirName);

/** Every `.jsonl` under `root`, at any depth (Claude sidechains, Codex date dirs). */
async function listJsonl(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

/**
 * Session files written since `from`: `{ cwd, path, mtimeMs, birthMs }`. A null
 * `cwd` on a Claude or Codex file is read from its own content in `parseSession`.
 */
async function listSessions(family, home, from) {
  const sessions = [];
  const add = async (cwd, path) => {
    const info = await stat(path).catch(() => null);
    if (!info || info.mtimeMs < from) return;
    sessions.push({ cwd, path, mtimeMs: info.mtimeMs, birthMs: info.birthtimeMs || info.mtimeMs });
  };
  if (family === 'claude') {
    const root = join(cliHome(home, 'CLAUDE_CONFIG_DIR', '.claude'), 'projects');
    for (const path of await listJsonl(root)) await add(null, path);
  } else if (family === 'codex') {
    const inventory = await readCodexAccountingSources({ home, modifiedSince: from });
    assertCodexInventoryComplete(inventory);
    for (const session of inventory.sessions) sessions.push({ cwd: session.cwd, entries: session.records });
  } else if (family === 'grok') {
    const root = join(home, '.grok', 'sessions');
    for (const dirName of await listSubdirs(root)) {
      const cwd = decodeGrokSessionDir(dirName);
      const cwdDir = join(root, dirName);
      for (const sessionId of await listSubdirs(cwdDir)) {
        await add(cwd, join(cwdDir, sessionId, 'updates.jsonl'));
      }
    }
  } else {
    const root = join(home, '.gemini', 'antigravity-cli');
    for (const conversation of await listAgyConversations(root)) {
      await add(conversation.workspace, join(root, 'brain', conversation.conversationId, '.system_generated', 'logs', 'transcript.jsonl'));
    }
  }
  return sessions;
}

const BUCKET_FIELDS = [
  'messages', 'tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheWriteTokens',
  'longTokensIn', 'longTokensOut', 'longCacheReadTokens', 'longCacheWriteTokens',
];
const addBuckets = (target, buckets) => {
  for (const field of BUCKET_FIELDS) target[field] = (target[field] || 0) + (buckets[field] || 0);
};

/** The working directory a Claude transcript or Codex rollout records about itself. */
function cwdFromEntries(family, entries) {
  for (const entry of entries) {
    if (family === 'codex' && entry.type === 'session_meta' && typeof entry.payload?.cwd === 'string') return entry.payload.cwd;
    if (family === 'claude' && typeof entry.cwd === 'string' && entry.cwd) return entry.cwd;
  }
  return null;
}

/**
 * One slice's billed buckets per model. `seen` is the scan-wide set of Claude
 * message keys already counted: a resumed or forked session replays earlier
 * messages into a NEW file under their original ids and timestamps.
 */
function parseSlice(family, entries, slice, seen) {
  if (family === 'claude') {
    const parsed = parseClaudeTranscript(entries, { from: slice.from, to: slice.to, exclude: seen });
    for (const key of parsed.countedKeys) seen.add(key);
    return { byModel: parsed.byModel, repairIds: [] };
  }
  // A rollout's totals are cumulative; a windowed read is the slice's delta.
  if (family === 'codex') return { byModel: parseCodexRollout(entries, { from: slice.from, to: slice.to }).byModel, repairIds: [] };
  if (family === 'grok') {
    const parsed = parseGrokTurns(entries, { from: slice.from, to: slice.to });
    return {
      byModel: parsed.byModel,
      // Registered in the same correction save as the long-context subset, so
      // a later repair of turns already at or behind the watermark does not
      // add that premium a second time.
      repairIds: (parsed.longTurns || []).map((turn) => grokTurnRepairId(turn.sessionId, turn.key)),
      source: 'measured',
    };
  }
  const parsed = parseAgyTranscript(entries, { from: slice.from, to: slice.to });
  const buckets = agyEstimatedBuckets(parsed);
  return { byModel: { [UNKNOWN_MODEL]: buckets }, repairIds: [], source: buckets.source };
}

/** One session file's billed buckets per `{ day, model }` inside `[from, to]`, minus run windows. */
async function parseSession(family, session, from, to, byCwd, seen, regionsOf = (lo, hi, cwd) => subtractWindows(lo, hi, windowsFor(byCwd, cwd))) {
  const text = session.entries ? null : await tryReadFile(session.path);
  if (!session.entries && !text) return [];
  // Parsed once and windowed per day slice: re-splitting a multi-MB file per
  // slice would cost ~35 parses of it on a first scan.
  const entries = session.entries ?? parseJsonLines(text);
  const cwd = session.cwd ?? cwdFromEntries(family, entries);
  // A file cannot hold anything before it existed or after it was last written.
  // A birth time AFTER the last write means the file was copied or restored, so
  // it says nothing about when its content began — read from the window start.
  const lo = !session.entries && session.birthMs <= session.mtimeMs ? Math.max(from, session.birthMs - DAY_MS) : from;
  const hi = session.entries ? to : Math.min(to, session.mtimeMs + WINDOW_SLACK_MS);
  const results = [];
  for (const [a, b] of regionsOf(lo, hi, cwd)) {
    for (const slice of splitByUtcDay(a, b)) {
      const parsed = parseSlice(family, entries, slice, seen);
      let attachedIds = false;
      for (const [model, buckets] of Object.entries(parsed.byModel)) {
        if (totalTranscriptTokens(buckets) <= 0) continue;
        const repairIds = attachedIds ? [] : (parsed.repairIds || []);
        attachedIds = true;
        results.push({ day: slice.day, model, buckets, repairIds, source: parsed.source });
      }
    }
  }
  return results;
}

const isSidechainPath = (path) => /[\\/]subagents[\\/]/.test(path);

/**
 * One-time repair for Claude runs reconciled before the run path read subagent
 * sidechains (`<session>/subagents/*.jsonl`). Those runs billed their parent
 * transcript only, and this scan skips every run window, so the sidechain turns
 * inside them were never billed by anything. Bills them once: sidechain messages
 * inside the windows of runs reconciled before `cutoff`. Runs reconciled since
 * (or not yet) read sidechains themselves, so their windows are carved out.
 */
async function repairSettledSidechains({ home, runsDir, providerList, now, cutoff, to, commitState }) {
  const from = now - FIRST_SCAN_LOOKBACK_DAYS * DAY_MS;
  const settledBefore = (metadata) => metadata.usageReconciled === true
    && Date.parse(metadata.usageReconciledAt || '') < cutoff;
  const settled = await loadRunWindows(runsDir, from, now, settledBefore);
  const others = await loadRunWindows(runsDir, from, now, (metadata) => !settledBefore(metadata));
  const regionsOf = (lo, hi, cwd) => {
    const outside = subtractWindows(lo, hi, windowsFor(settled, cwd));
    const inside = outside.reduce((pieces, [a, b]) => pieces.flatMap(([x, y]) => subtractWindows(x, y, [[a, b]])), [[lo, hi]]);
    return inside.flatMap(([a, b]) => subtractWindows(a, b, windowsFor(others, cwd)));
  };
  const perDay = new Map();
  const seen = new Set();
  const sessions = (await listSessions('claude', home, from)).filter((session) => isSidechainPath(session.path));
  for (const session of sessions) {
    for (const { day, model, buckets } of await parseSession('claude', session, from, to, settled, seen, regionsOf)) {
      if (!perDay.has(day)) perDay.set(day, { byModel: {} });
      const dayTotals = perDay.get(day);
      addBuckets(dayTotals, buckets);
      dayTotals.byModel[model] ??= {};
      addBuckets(dayTotals.byModel[model], buckets);
    }
    await yieldToEventLoop();
  }
  const corrections = [];
  for (const [day, totals] of perDay) {
    const measured = { ...totals, source: 'measured', model: null };
    const provider = resolveFamilyProvider(providerList, 'claude', measured);
    if (!provider) continue;
    corrections.push({
      runId: `sidechain-repair:${day}`,
      day,
      providerId: provider.id,
      siblings: recordsFromMeasured(provider.id, provider.defaultModel ?? null, measured, 'sibling'),
      siblingScanned: true,
      repairIds: [],
    });
  }
  // Marked repaired in the same write as its corrections; with none to apply,
  // the marker alone is committed so the repair is never re-run on a later boot.
  if (corrections.length) {
    await applyHistoricalUsageCorrections(corrections, { interactiveScan: commitState() });
    await forgetSiblingReconciledUsageRuns(corrections.map((c) => c.runId));
  } else {
    await setInteractiveScanState(commitState());
  }
  return corrections.reduce((sum, c) => sum + c.siblings.reduce((n, r) => n + (r.tokensOut || 0), 0), 0);
}

/**
 * An incomplete inventory is durable state the usage UI shows, not a line per scan:
 * it logs when its set of reasons changes. A live rollout appended to mid-read is
 * retried by the next scan, so that alone records nothing.
 */
async function recordCodexHold(current, err, now, snapshot) {
  const reasons = Object.keys(err.issues);
  if (reasons.every((reason) => reason === 'source_changed')) {
    console.log(`⏭️ Codex scan held for a live session write: ${err.message}`);
    return current;
  }
  const signature = (issues) => Object.keys(issues || {}).sort().join();
  const next = {
    since: current?.since ?? new Date(now).toISOString(),
    checkedAt: new Date(now).toISOString(),
    issues: err.issues,
    sources: err.problemSources
  };
  if (signature(current?.issues) !== signature(err.issues)) console.warn(`⚠️ Interactive usage holding Codex: ${err.message}`);
  await setInteractiveScanState({ ...snapshot(), codexCoverage: next });
  return next;
}

/**
 * Bill every un-launched Claude Code / Codex / Grok / Antigravity session since
 * the last scan.
 *
 * Resolves with `{ families: { [family]: { days, tokens } } }`. A family with no
 * configured provider is skipped WITHOUT advancing its watermark, so enabling
 * one later still bills what was skipped (within the first-scan lookback). Codex
 * reports `held: true` and keeps its watermark while its inventory is incomplete.
 */
// A const, not a function declaration: the boot timer below is its only production
// caller, and tests drive it directly with a fixture home/runs dir.
export const refreshInteractiveUsage = ({ home = homedir(), runsDir = PATHS.runs, providers = null, now = Date.now() } = {}) => (
  withLock(async () => {
    // Strict legacy read: a damaged watermark file must fail the scan, not read as
    // empty and re-bill 35 days. Only consulted until usage.json holds the state.
    const state = await getInteractiveScanState()
      ?? await readJSONFile(INTERACTIVE_SCAN_FILE, { watermarks: {} }, { strict: true });
    if (state?.coverageVersion != null && state.coverageVersion !== 1) throw new Error('Unsupported interactive usage coverage version');
    const watermarks = { ...(state?.watermarks || {}) };
    const deferred = structuredClone(state?.deferred || {});
    const to = now - SETTLE_MS;
    // Not caught: a provider-list failure must surface, not read as "none configured".
    const providerList = providers ?? await import('./providers.js').then((m) => m.listProviders());
    const summary = { families: {} };
    const { getRunProjections, MAX_READ_LIMIT } = await import('./agentRunEventLog.js');
    const projections = new Map((await getRunProjections({ limit: MAX_READ_LIMIT })).map((run) => [run.id, run]));
    const unresolved = [];
    const observed = new Set();
    const priorDeferred = Object.values(deferred).flat();
    const coverageFrom = Math.min(now - FIRST_SCAN_LOOKBACK_DAYS * DAY_MS, ...priorDeferred.map((window) => window.from));
    const byCwd = await loadRunWindows(runsDir, coverageFrom, now, undefined, projections, unresolved, observed);
    // Removing a run record is not evidence of its historical ownership. Keep
    // previously held regions recoverable until an authoritative bound exists.
    const missing = new Map();
    for (const old of priorDeferred) {
      if (observed.has(old.runId)) continue;
      const key = JSON.stringify([old.runId, old.workspacePath]);
      const previous = missing.get(key);
      missing.set(key, { ...old, from: Math.min(old.from, previous?.from ?? old.from), to: now });
    }
    for (const window of missing.values()) {
      unresolved.push(window);
      if (!byCwd.has(window.workspacePath)) byCwd.set(window.workspacePath, []);
      byCwd.get(window.workspacePath).push([window.from, now + WINDOW_SLACK_MS]);
    }
    summary.unresolved = unresolved;

    let sidechainRepairedAt = state?.sidechainRepairedAt ?? null;
    let codexCoverage = state?.codexCoverage ?? null;
    // Snapshot handed to each commit: the state as it would stand once that write lands.
    const snapshot = () => ({ coverageVersion: 1, watermarks: { ...watermarks }, deferred: structuredClone(deferred), unresolved, sidechainRepairedAt, codexCoverage, updatedAt: new Date(now).toISOString() });
    if (!sidechainRepairedAt && resolveFamilyProvider(providerList, 'claude')) {
      // Process start, not `now`: a run reconciled after boot already ran the fixed reader.
      const cutoff = now - process.uptime() * 1000;
      const repairedAt = new Date(now).toISOString();
      const outputTokens = await repairSettledSidechains({
        home, runsDir, providerList, now, cutoff, to,
        commitState: () => ({ ...snapshot(), sidechainRepairedAt: repairedAt })
      });
      sidechainRepairedAt = repairedAt;
      summary.sidechainRepair = { tokensOut: outputTokens };
      if (outputTokens > 0) console.log(`💸 Settled Claude subagent usage billed: ${outputTokens} output tokens`);
    }

    for (const family of FAMILIES) {
      if (!resolveFamilyProvider(providerList, family)) continue;
      const from = watermarks[family] != null ? watermarks[family] + 1 : now - FIRST_SCAN_LOOKBACK_DAYS * DAY_MS;
      const pending = deferred[family] || [];
      const scanFrom = Math.min(from, ...pending.map((window) => window.from));
      if (to < scanFrom) continue;
      // Pending regions were excluded from the same atomic count/cursor write.
      // Replay only those regions for their workspace; other sessions keep the
      // normal watermark even while one run's ownership remains unknown.
      const matches = (window, cwd) => !cwd || cwdMatches(cwd, window.workspacePath);
      const regionsOf = (lo, hi, cwd) => mergeIntervals([
        [Math.max(lo, from), hi],
        ...pending.filter((window) => matches(window, cwd)).map((window) => [Math.max(lo, window.from), Math.min(hi, window.to)])
      ]).flatMap(([a, b]) => subtractWindows(a, b, windowsFor(byCwd, cwd)));
      const nextPending = unresolved.flatMap((window) => [
        { ...window, from: Math.max(from, window.from), to: Math.min(to, window.to) },
        ...pending.filter((old) => cwdMatches(old.workspacePath, window.workspacePath) || cwdMatches(window.workspacePath, old.workspacePath))
          .map((old) => ({ ...window,
            workspacePath: cwdMatches(old.workspacePath, window.workspacePath) ? old.workspacePath : window.workspacePath,
            from: Math.max(old.from, window.from), to: Math.min(old.to, window.to)
          }))
      ].filter((window) => window.from <= window.to));
      // Compact successive scan intervals for each owner/workspace pair.
      const grouped = new Map();
      for (const window of nextPending) {
        const key = JSON.stringify([window.runId, window.workspacePath]);
        if (!grouped.has(key)) grouped.set(key, { window, intervals: [] });
        grouped.get(key).intervals.push([window.from, window.to]);
      }

      let familySessions;
      try {
        familySessions = await listSessions(family, home, scanFrom);
      } catch (err) {
        if (err.code !== 'CODEX_SOURCES_INCOMPLETE') throw err;
        // Hold only this family's watermark so the region is billed once the
        // inventory recovers; the other families keep their own scans.
        summary.families[family] = { days: 0, tokens: 0, held: true, issues: err.issues };
        codexCoverage = await recordCodexHold(codexCoverage, err, now, snapshot);
        continue;
      }
      if (family === 'codex' && codexCoverage) {
        console.log('✅ Codex source inventory is complete again; interactive usage resumed');
        codexCoverage = null;
      }

      const perDay = new Map();
      const seen = new Set();
      for (const session of familySessions) {
        for (const { day, model, buckets, repairIds, source } of await parseSession(family, session, scanFrom, to, byCwd, seen, regionsOf)) {
          if (!perDay.has(day)) perDay.set(day, { byModel: {}, repairIds: [], sources: new Set() });
          const dayTotals = perDay.get(day);
          addBuckets(dayTotals, buckets);
          dayTotals.byModel[model] ??= {};
          addBuckets(dayTotals.byModel[model], buckets);
          if (repairIds?.length) dayTotals.repairIds.push(...repairIds);
          if (source) dayTotals.sources.add(source);
        }
        // A first scan parses many multi-MB files back to back; let the server breathe.
        await yieldToEventLoop();
      }

      const corrections = [];
      let tokens = 0;
      for (const [day, totals] of perDay) {
        const source = totals.sources?.has('measured') && totals.sources?.has('estimate')
          ? 'mixed'
          : totals.sources?.values().next().value || (family === 'agy' ? 'estimate' : 'measured');
        const measured = { ...totals, source, model: null };
        const provider = resolveFamilyProvider(providerList, family, measured);
        if (!provider) continue;
        tokens += totalTranscriptTokens(totals);
        corrections.push({
          // Synthetic id: only satisfies the sibling-add path's idempotency marker
          // for the duration of one apply (forgotten right after).
          runId: `interactive:${family}:${day}:${from}-${to}`,
          day,
          providerId: provider.id,
          siblings: recordsFromMeasured(provider.id, provider.defaultModel ?? null, measured, 'sibling'),
          siblingScanned: true,
          repairIds: totals.repairIds || [],
        });
      }
      // The family's watermark commits in the same write as its counts.
      watermarks[family] = to;
      deferred[family] = [...grouped.values()].flatMap(({ window, intervals }) =>
        mergeIntervals(intervals).map(([from, to]) => ({ ...window, from, to })));
      if (corrections.length) {
        await applyHistoricalUsageCorrections(corrections, { interactiveScan: snapshot() });
        // The watermark, not these ids, prevents re-billing — don't leave a key per scan behind.
        await forgetSiblingReconciledUsageRuns(corrections.map((c) => c.runId));
      } else {
        await setInteractiveScanState(snapshot());
      }
      summary.families[family] = { days: corrections.length, tokens };
      if (tokens > 0) console.log(`💸 Interactive ${family} usage billed: ${tokens} tokens over ${corrections.length} day(s)`);
    }

    return summary;
  })
);

export function startInteractiveUsageRefresh({ intervalMs = 30 * 60_000, firstDelayMs = 90_000 } = {}) {
  const run = () => refreshInteractiveUsage().catch((err) => {
    if (isUsageCutoverFenced(err)) return console.log(`⏸️ Interactive usage scan held: ${err.message}`);
    console.error(`❌ Interactive usage scan failed: ${err.message}`);
  });
  setTimeout(run, firstDelayMs).unref();
  setInterval(run, intervalMs).unref();
}
