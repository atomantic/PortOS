/**
 * CoS agent-run churn detector.
 *
 * A scheduled / perpetual task that finishes the SAME work over and over in
 * short-lived agent runs (last night's branch-reconcile loop: dozens of
 * identical findings, each a couple of minutes) is a defect — not something
 * Layered Intelligence should have to notice by reading telemetry. This module
 * watches every agent completion, decides from the task-type recency ring
 * whether the type is churning, parks a looping coordinator so it stops
 * burning quota, and files ONE tracker issue so a human / coding agent can
 * fix the root cause.
 *
 * Detection is deterministic (counts + durations + inter-arrival gaps). No
 * LLM call — safe under the cold-bootstrap AI policy.
 */

import { join } from 'path';
import { PATHS, readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { extractTaskType, loadLearningData } from './taskLearning/store.js';
import { NON_COMMITTING_COORDINATOR_TASK_TYPES } from './taskTypeHooks.js';
import { runCli } from './layeredIntelligence/runCli.js';
import { formatDurationShort } from './autonomousJobs/selfDiagnostics.js';

// Tight window: the failure mode is a burst overnight, not a busy week of
// legitimate drain. Eight completions is already more than a healthy
// coordinator should need to re-state the same finding.
export const CHURN_WINDOW_MS = 6 * 60 * 60 * 1000;
export const SHORT_LIVED_MS = 5 * 60 * 1000;
export const CHURN_MIN_RUNS = 8;
export const CHURN_SHORT_LIVED_RATIO = 0.7;
export const RAPID_GAP_MS = 15 * 60 * 1000;
export const CHURN_ALERT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const CHURN_SLUG_PREFIX = 'cos-churn';

export const alertsPath = (cosDir = PATHS.cos) => join(cosDir, 'churn-alerts.json');

const slugMarker = (taskType) => `<!-- lil-slug: ${CHURN_SLUG_PREFIX}:${taskType} -->`;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Window a recent-outcomes ring and summarize duration + spacing. Pure.
 * Samples without a parseable timestamp are dropped (they cannot contribute
 * to a recency burst). Duration stats are null when no sample carried `d`,
 * so pre-instrumentation history is distinguishable from "every run was instant".
 */
export function summarizeRecentRuns(recentOutcomes, {
  now = Date.now(),
  windowMs = CHURN_WINDOW_MS
} = {}) {
  const ring = Array.isArray(recentOutcomes) ? recentOutcomes : [];
  const cutoff = now - windowMs;
  const windowed = ring.filter((o) => {
    const t = Date.parse(o?.t);
    return Number.isFinite(t) && t >= cutoff;
  });
  const durations = windowed
    .map((o) => o?.d)
    .filter((d) => Number.isFinite(d) && d >= 0);
  const shortLivedCount = durations.filter((d) => d < SHORT_LIVED_MS).length;
  const times = windowed
    .map((o) => Date.parse(o?.t))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  return {
    windowCompleted: windowed.length,
    windowMs,
    shortLivedCount,
    shortLivedSampleSize: durations.length,
    shortLivedRatio: durations.length > 0 ? shortLivedCount / durations.length : null,
    averageDurationMs: durations.length
      ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
      : null,
    medianDurationMs: median(durations),
    medianGapMs: median(gaps)
  };
}

/**
 * Classify a task-type recency ring as churning or not. Pure.
 *
 * Two independent signals, either of which is enough once the run-count floor
 * is met:
 *   - short-lived-burst — enough of the measured runs finished under
 *     SHORT_LIVED_MS (the last-night shape: coordinator reports the same
 *     finding and exits in a couple of minutes).
 *   - rapid-succession — no duration data (pre-instrumentation ring) but the
 *     completions are packed tighter than RAPID_GAP_MS. The timestamp cadence
 *     is the only honest proxy when `d` was never recorded.
 *
 * A healthy drain of real work (a handful of long runs, or many long runs
 * spaced out) does not flag.
 */
export function computeChurn(recentOutcomes, opts = {}) {
  const stats = summarizeRecentRuns(recentOutcomes, opts);
  let reason = null;
  if (stats.windowCompleted >= CHURN_MIN_RUNS) {
    if (stats.shortLivedRatio !== null && stats.shortLivedRatio >= CHURN_SHORT_LIVED_RATIO) {
      reason = 'short-lived-burst';
    } else if (stats.shortLivedRatio === null && stats.medianGapMs !== null && stats.medianGapMs < RAPID_GAP_MS) {
      reason = 'rapid-succession';
    }
  }
  return { ...stats, flagged: reason !== null, reason };
}

export function buildChurnIssueTitle(taskType) {
  return `CoS churn: ${taskType} is looping on short-lived executions`;
}

function formatWindow(ms) {
  const hours = Math.round((Number(ms) || 0) / 3600000);
  return hours <= 1 ? '1h' : `${hours}h`;
}

/**
 * Markdown body for the auto-filed churn issue. Pure. No hostnames, branch
 * names, paths, or other live-instance data — only the task-type slug and
 * the numeric burst.
 */
export function buildChurnIssueBody({ taskType, churn, signatureRepeatCount = null, generatedAt = new Date().toISOString() } = {}) {
  const windowLabel = formatWindow(churn?.windowMs);
  const lines = [
    `_Automated CoS churn alert — a scheduled task completed an excessive number of short-lived runs without making progress. Do not hand-edit the marker at the bottom._`,
    '',
    `**Task type:** \`${taskType || 'unknown'}\``,
    `**Signal:** ${churn?.reason || 'unknown'}`,
    `**Runs in last ${windowLabel}:** ${churn?.windowCompleted ?? 0}`,
    `**Short-lived (< ${formatDurationShort(SHORT_LIVED_MS)}):** ${churn?.shortLivedCount ?? 0}`
      + (churn?.shortLivedSampleSize
        ? ` of ${churn.shortLivedSampleSize} timed runs`
        : ' (no per-run duration recorded — used completion spacing)'),
    `**Median duration:** ${formatDurationShort(churn?.medianDurationMs)}`,
    `**Median gap between completions:** ${formatDurationShort(churn?.medianGapMs)}`
  ];
  if (Number.isFinite(signatureRepeatCount) && signatureRepeatCount > 1) {
    lines.push(`**Same-finding park count:** ${signatureRepeatCount} (the actionable set did not change)`);
  }
  lines.push('');
  lines.push('This is the failure mode where a perpetual coordinator (for example branch-reconcile) re-reports the same finding over and over instead of parking or advancing. Fix the drain so an unchanged finding parks for the recheck cadence and does not spawn another short-lived agent.');
  lines.push('');
  lines.push(`_Detected: ${generatedAt}_`);
  lines.push('');
  lines.push(slugMarker(taskType));
  return lines.join('\n');
}

export function shouldFileChurnAlert(alerts, taskType, { now = Date.now(), cooldownMs = CHURN_ALERT_COOLDOWN_MS } = {}) {
  const rec = alerts?.byTaskType?.[taskType];
  if (!rec?.filedAt) return true;
  const filedAt = Date.parse(rec.filedAt);
  if (!Number.isFinite(filedAt)) return true;
  return (now - filedAt) >= cooldownMs;
}

async function readAlerts(cosDir) {
  const parsed = await readJSONFile(alertsPath(cosDir), null);
  const byTaskType = (parsed?.byTaskType && typeof parsed.byTaskType === 'object' && !Array.isArray(parsed.byTaskType))
    ? parsed.byTaskType
    : {};
  return { byTaskType };
}

async function writeAlert(cosDir, taskType, rec) {
  const current = await readAlerts(cosDir);
  current.byTaskType[taskType] = rec;
  await atomicWrite(alertsPath(cosDir), current);
  return current;
}

function scheduledTypeOf(task) {
  return task?.metadata?.analysisType || task?.metadata?.taskAnalysisType || null;
}

function appIdOf(task) {
  return task?.metadata?.app || task?.metadata?.taskApp || null;
}

/**
 * Locate an already-open churn issue for this task type (slug marker in the
 * body, falling back to the stable title). `ok: false` means the list FAILED
 * — do not then create, or a gh blip duplicates the issue.
 */
export async function findOpenChurnIssue(taskType, { cwd = PATHS.root, exec = runCli } = {}) {
  const { code, stdout } = await exec('gh',
    ['issue', 'list', '--state', 'open', '--limit', '50', '--search', `${buildChurnIssueTitle(taskType)} in:title`, '--json', 'number,title,body,url'],
    { cwd });
  if (code !== 0) return { ok: false, issue: null };
  if (!stdout.trim()) return { ok: true, issue: null };
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return { ok: false, issue: null }; }
  if (!Array.isArray(parsed)) return { ok: false, issue: null };
  const marker = slugMarker(taskType);
  const title = buildChurnIssueTitle(taskType);
  const ours = parsed.find((i) => (i.body || '').includes(marker))
    || parsed.find((i) => i.title === title)
    || null;
  return {
    ok: true,
    issue: ours
      ? { number: ours.number ?? null, title: ours.title || '', url: ours.url || null }
      : null
  };
}

/**
 * File or refresh the churn issue. Injectable exec/cwd for tests.
 */
export async function fileChurnIssue({ taskType, churn, signatureRepeatCount = null, cwd = PATHS.root, exec = runCli, now = () => new Date().toISOString() } = {}) {
  const title = buildChurnIssueTitle(taskType);
  const body = buildChurnIssueBody({ taskType, churn, signatureRepeatCount, generatedAt: now() });
  const found = await findOpenChurnIssue(taskType, { cwd, exec });
  if (!found.ok) return { ok: false, issue: null, reason: 'list-failed' };
  if (found.issue?.number) {
    const { code, stderr } = await exec('gh',
      ['issue', 'edit', String(found.issue.number), '--body', body],
      { cwd });
    if (code !== 0) {
      console.warn(`⚠️ CoS churn: failed to update issue #${found.issue.number}: ${(stderr || '').trim()}`);
      return { ok: false, issue: found.issue, reason: 'edit-failed' };
    }
    return { ok: true, issue: found.issue, created: false };
  }
  const { code, stdout, stderr } = await exec('gh',
    ['issue', 'create', '--title', title, '--body', body],
    { cwd });
  if (code !== 0) {
    console.warn(`⚠️ CoS churn: failed to create issue: ${(stderr || '').trim()}`);
    return { ok: false, issue: null, reason: 'create-failed' };
  }
  const url = ((stdout || '').trim().match(/(https?:\/\/\S+)/) || [])[1] || (stdout || '').trim();
  const number = Number((url.match(/(\d+)\s*$/) || [])[1]) || null;
  return { ok: true, issue: { number, url, title }, created: true };
}

/**
 * Watch one completed agent run. Call AFTER `recordTaskCompletion` so this
 * run is already on the recency ring. Never throws — callers at the
 * agent-completed boundary must stay up if filing or parking fails.
 */
export async function observeAgentChurn(agent, task, {
  loadLearning = loadLearningData,
  now = Date.now,
  exec = runCli,
  cwd = PATHS.root,
  cosDir = PATHS.cos,
  park = null,
  readPark = null,
  forgeGate = null
} = {}) {
  const taskType = extractTaskType(task);
  if (!taskType) return { flagged: false };
  const clock = typeof now === 'function' ? now() : now;
  const nowMs = typeof clock === 'number' ? clock : Date.parse(clock);
  const effectiveNow = Number.isFinite(nowMs) ? nowMs : Date.now();

  const data = await loadLearning();
  const churn = computeChurn(data?.byTaskType?.[taskType]?.recentOutcomes, { now: effectiveNow });
  if (!churn.flagged) return { flagged: false, taskType, churn };

  const analysisType = scheduledTypeOf(task);
  const appId = appIdOf(task);
  console.warn(`⚠️ CoS churn: ${taskType} ${churn.reason} (${churn.windowCompleted} runs in ${formatWindow(churn.windowMs)})`);

  let parked = false;
  if (NON_COMMITTING_COORDINATOR_TASK_TYPES.has(analysisType)) {
    const parkFn = park || (async (...args) => {
      const { parkPerpetual } = await import('./taskSchedule.js');
      return parkPerpetual(...args);
    });
    await parkFn(analysisType, appId, { reason: 'churn-detected', actionableCount: churn.windowCompleted });
    parked = true;
    console.warn(`⚠️ CoS churn: parked ${analysisType} so the loop stops burning quota`);
  }

  let signatureRepeatCount = null;
  if (analysisType && appId) {
    const read = readPark || (async (type, id) => {
      const { getPerpetualParkInfo } = await import('./taskSchedule.js');
      return getPerpetualParkInfo(type, id);
    });
    const parkInfo = await read(analysisType, appId).catch(() => null);
    if (Number.isFinite(parkInfo?.signatureRepeatCount)) signatureRepeatCount = parkInfo.signatureRepeatCount;
  }

  const alerts = await readAlerts(cosDir);
  if (!shouldFileChurnAlert(alerts, taskType, { now: effectiveNow })) {
    return { flagged: true, filed: false, parked, taskType, churn, reason: 'cooldown' };
  }

  const gate = forgeGate || (async () => {
    const { ensureForgeReachable } = await import('./github.js');
    return ensureForgeReachable('cos-churn');
  });
  const forge = await gate();
  if (!forge?.ok) {
    return { flagged: true, filed: false, parked, taskType, churn, reason: 'forge-unavailable' };
  }

  const isoNow = () => new Date(effectiveNow).toISOString();
  const filed = await fileChurnIssue({
    taskType,
    churn,
    signatureRepeatCount,
    cwd,
    exec,
    now: isoNow
  });
  if (filed.ok) {
    await writeAlert(cosDir, taskType, {
      filedAt: isoNow(),
      issueNumber: filed.issue?.number ?? null,
      url: filed.issue?.url ?? null,
      reason: churn.reason,
      windowCompleted: churn.windowCompleted
    });
    console.log(`🔁 CoS churn: ${filed.created ? 'filed' : 'updated'} issue ${filed.issue?.url || `#${filed.issue?.number}`} for ${taskType}`);
  }
  return { flagged: true, filed: !!filed.ok, created: !!filed.created, parked, taskType, churn, issue: filed.issue || null };
}
