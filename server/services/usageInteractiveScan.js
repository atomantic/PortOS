import { readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { basename, join } from 'path';
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
async function loadRunWindows(runsDir, from, now, pick = () => true) {
  const byCwd = new Map();
  for (const name of await listSubdirs(runsDir)) {
    const dir = join(runsDir, name);
    // A run directory untouched since before the window cannot overlap it.
    const info = await stat(dir).catch(() => null);
    if (!info || info.mtimeMs < from - DAY_MS) continue;
    const metadata = await readJSONFile(join(dir, 'metadata.json'), null);
    const start = Date.parse(metadata?.startTime || '');
    if (!metadata?.workspacePath || Number.isNaN(start) || !pick(metadata)) continue;
    // No endTime yet: the run is still going, so its window is open-ended.
    const end = Date.parse(metadata.endTime || '');
    const window = [start - WINDOW_SLACK_MS, (Number.isNaN(end) ? now : end) + WINDOW_SLACK_MS];
    if (!byCwd.has(metadata.workspacePath)) byCwd.set(metadata.workspacePath, []);
    byCwd.get(metadata.workspacePath).push(window);
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
    const root = join(cliHome(home, 'CODEX_HOME', '.codex'), 'sessions');
    for (const path of await listJsonl(root)) {
      if (basename(path).startsWith('rollout-')) await add(null, path);
    }
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
  const text = await tryReadFile(session.path);
  if (!text) return [];
  // Parsed once and windowed per day slice: re-splitting a multi-MB file per
  // slice would cost ~35 parses of it on a first scan.
  const entries = parseJsonLines(text);
  const cwd = session.cwd ?? cwdFromEntries(family, entries);
  // A file cannot hold anything before it existed or after it was last written.
  // A birth time AFTER the last write means the file was copied or restored, so
  // it says nothing about when its content began — read from the window start.
  const lo = session.birthMs <= session.mtimeMs ? Math.max(from, session.birthMs - DAY_MS) : from;
  const hi = Math.min(to, session.mtimeMs + WINDOW_SLACK_MS);
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
 * Bill every un-launched Claude Code / Codex / Grok / Antigravity session since
 * the last scan.
 *
 * Resolves with `{ families: { [family]: { days, tokens } } }`. A family with no
 * configured provider is skipped WITHOUT advancing its watermark, so enabling
 * one later still bills what was skipped (within the first-scan lookback).
 */
// A const, not a function declaration: the boot timer below is its only production
// caller, and tests drive it directly with a fixture home/runs dir.
export const refreshInteractiveUsage = ({ home = homedir(), runsDir = PATHS.runs, providers = null, now = Date.now() } = {}) => (
  withLock(async () => {
    // Strict legacy read: a damaged watermark file must fail the scan, not read as
    // empty and re-bill 35 days. Only consulted until usage.json holds the state.
    const state = await getInteractiveScanState()
      ?? await readJSONFile(INTERACTIVE_SCAN_FILE, { watermarks: {} }, { strict: true });
    const watermarks = { ...(state?.watermarks || {}) };
    const to = now - SETTLE_MS;
    // Not caught: a provider-list failure must surface, not read as "none configured".
    const providerList = providers ?? await import('./providers.js').then((m) => m.listProviders());
    const summary = { families: {} };
    const byCwd = await loadRunWindows(runsDir, now - FIRST_SCAN_LOOKBACK_DAYS * DAY_MS, now);

    let sidechainRepairedAt = state?.sidechainRepairedAt ?? null;
    // Snapshot handed to each commit: the state as it would stand once that write lands.
    const snapshot = () => ({ watermarks: { ...watermarks }, sidechainRepairedAt, updatedAt: new Date(now).toISOString() });
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
      if (to < from) continue;

      const perDay = new Map();
      const seen = new Set();
      for (const session of await listSessions(family, home, from)) {
        for (const { day, model, buckets, repairIds, source } of await parseSession(family, session, from, to, byCwd, seen)) {
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
    console.error(`❌ Interactive usage scan failed: ${err.message}`);
  });
  setTimeout(run, firstDelayMs).unref();
  setInterval(run, intervalMs).unref();
}
