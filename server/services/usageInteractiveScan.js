import { stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { atomicWrite, PATHS, readJSONFile, tryReadFile } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import {
  UNKNOWN_MODEL,
  decodeGrokSessionDir,
  parseAgyHistory,
  parseAgyTranscript,
  parseGrokTurns,
  parseJsonLines,
  totalTranscriptTokens
} from '../lib/providerTranscriptUsage.js';
import {
  WINDOW_SLACK_MS,
  agyEstimatedBuckets,
  cwdMatches,
  listSubdirs,
  recordsFromMeasured,
  resolveFamilyProvider
} from './usageReconciler.js';
import { applyHistoricalUsageCorrections, forgetSiblingReconciledUsageRuns } from './usage.js';

/**
 * Attribute Grok and Antigravity sessions that PortOS never launched.
 *
 * `usageReconciler.js` only reads a CLI's session store inside a PortOS run's
 * own workspace and time window, so everything the user does in a terminal —
 * the interactive `grok` / `agy` sessions that actually burn the weekly quota —
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

export const INTERACTIVE_SCAN_FILE = join(PATHS.data, 'usage-interactive-scan.json');

const FAMILIES = ['grok', 'agy'];
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
async function loadRunWindows(runsDir, from, now) {
  const byCwd = new Map();
  for (const name of await listSubdirs(runsDir)) {
    const dir = join(runsDir, name);
    // A run directory untouched since before the window cannot overlap it.
    const info = await stat(dir).catch(() => null);
    if (!info || info.mtimeMs < from - DAY_MS) continue;
    const metadata = await readJSONFile(join(dir, 'metadata.json'), null);
    const start = Date.parse(metadata?.startTime || '');
    if (!metadata?.workspacePath || Number.isNaN(start)) continue;
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
  for (const [workspacePath, windows] of byCwd) {
    if (cwdMatches(sessionCwd, workspacePath)) out.push(...windows);
  }
  return out;
};

/** Session files written since `from`: `{ cwd, path, mtimeMs, birthMs }`. */
async function listSessions(family, home, from) {
  const sessions = [];
  const add = async (cwd, path) => {
    const info = await stat(path).catch(() => null);
    if (!info || info.mtimeMs < from) return;
    sessions.push({ cwd, path, mtimeMs: info.mtimeMs, birthMs: info.birthtimeMs || info.mtimeMs });
  };
  if (family === 'grok') {
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
    const historyText = await tryReadFile(join(root, 'history.jsonl'));
    for (const conversation of historyText ? parseAgyHistory(historyText) : []) {
      await add(conversation.workspace, join(root, 'brain', conversation.conversationId, '.system_generated', 'logs', 'transcript.jsonl'));
    }
  }
  return sessions;
}

const BUCKET_FIELDS = ['messages', 'tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheWriteTokens'];
const addBuckets = (target, buckets) => {
  for (const field of BUCKET_FIELDS) target[field] = (target[field] || 0) + (buckets[field] || 0);
};

/** One session file's billed buckets per `{ day, model }` inside `[from, to]`, minus run windows. */
async function parseSession(family, session, from, to, byCwd) {
  const text = await tryReadFile(session.path);
  if (!text) return [];
  // Parsed once and windowed per day slice: re-splitting a multi-MB file per
  // slice would cost ~35 parses of it on a first scan.
  const entries = parseJsonLines(text);
  // A file cannot hold anything before it existed or after it was last written.
  // A birth time AFTER the last write means the file was copied or restored, so
  // it says nothing about when its content began — read from the window start.
  const lo = session.birthMs <= session.mtimeMs ? Math.max(from, session.birthMs - DAY_MS) : from;
  const hi = Math.min(to, session.mtimeMs + WINDOW_SLACK_MS);
  const results = [];
  for (const [a, b] of subtractWindows(lo, hi, windowsFor(byCwd, session.cwd))) {
    for (const slice of splitByUtcDay(a, b)) {
      if (family === 'grok') {
        const parsed = parseGrokTurns(entries, { from: slice.from, to: slice.to });
        for (const [model, buckets] of Object.entries(parsed.byModel)) {
          if (totalTranscriptTokens(buckets) > 0) results.push({ day: slice.day, model, buckets });
        }
      } else {
        const buckets = agyEstimatedBuckets(parseAgyTranscript(entries, { from: slice.from, to: slice.to }));
        if (totalTranscriptTokens(buckets) > 0) results.push({ day: slice.day, model: UNKNOWN_MODEL, buckets });
      }
    }
  }
  return results;
}

/**
 * Bill every un-launched Grok / Antigravity session since the last scan.
 *
 * Resolves with `{ families: { [family]: { days, tokens } } }`. A family with no
 * configured provider is skipped WITHOUT advancing its watermark, so enabling
 * one later still bills what was skipped (within the first-scan lookback).
 */
// A const, not a function declaration: the boot timer below is its only production
// caller, and tests drive it directly with a fixture home/runs dir.
export const refreshInteractiveUsage = ({ home = homedir(), runsDir = PATHS.runs, providers = null, now = Date.now() } = {}) => (
  withLock(async () => {
    // Strict: a damaged watermark must fail the scan, not read as empty and re-bill 35 days.
    const state = await readJSONFile(INTERACTIVE_SCAN_FILE, { watermarks: {} }, { strict: true });
    const watermarks = { ...(state?.watermarks || {}) };
    const to = now - SETTLE_MS;
    // Not caught: a provider-list failure must surface, not read as "none configured".
    const providerList = providers ?? await import('./providers.js').then((m) => m.listProviders());
    const summary = { families: {} };
    const byCwd = await loadRunWindows(runsDir, now - FIRST_SCAN_LOOKBACK_DAYS * DAY_MS, now);

    for (const family of FAMILIES) {
      if (!resolveFamilyProvider(providerList, family)) continue;
      const from = watermarks[family] != null ? watermarks[family] + 1 : now - FIRST_SCAN_LOOKBACK_DAYS * DAY_MS;
      if (to < from) continue;

      const perDay = new Map();
      for (const session of await listSessions(family, home, from)) {
        for (const { day, model, buckets } of await parseSession(family, session, from, to, byCwd)) {
          if (!perDay.has(day)) perDay.set(day, { byModel: {} });
          const dayTotals = perDay.get(day);
          addBuckets(dayTotals, buckets);
          dayTotals.byModel[model] ??= {};
          addBuckets(dayTotals.byModel[model], buckets);
        }
        // A first scan parses many multi-MB files back to back; let the server breathe.
        await yieldToEventLoop();
      }

      const corrections = [];
      let tokens = 0;
      for (const [day, totals] of perDay) {
        const measured = { ...totals, source: family === 'grok' ? 'measured' : 'estimate', model: null };
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
          siblingScanned: true
        });
      }
      if (corrections.length) {
        await applyHistoricalUsageCorrections(corrections);
        // The watermark, not these ids, prevents re-billing — don't leave a key per scan behind.
        await forgetSiblingReconciledUsageRuns(corrections.map((c) => c.runId));
      }
      watermarks[family] = to;
      summary.families[family] = { days: corrections.length, tokens };
      if (tokens > 0) console.log(`💸 Interactive ${family} usage billed: ${tokens} tokens over ${corrections.length} day(s)`);
    }

    await atomicWrite(INTERACTIVE_SCAN_FILE, { watermarks, updatedAt: new Date(now).toISOString() });
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
