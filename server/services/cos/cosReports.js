/**
 * CoS Reports Module
 *
 * Reports, briefings, and activity tracking extracted from cos.js.
 * Handles daily reports, briefings, activity summaries, and recent tasks.
 */

import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadState, ensureDirectories, REPORTS_DIR, isDaemonRunning } from './cosState.js';
import { readArchivedAgentMetadata, selectArchivedCompletions } from './cosAgentIndex.js';
import { projectArchivedAgent } from '../../lib/cos/cosAgentCompletionOrder.js';
import { formatDuration } from '../../lib/fileUtils.js';
import { isAgentHandoff } from '../../lib/agent/agentOutcome.js';

// Completed-agent records for a set of UTC date buckets (YYYY-MM-DD), merged
// from live in-memory state and the on-disk date-bucket archive. `accept(agent)`
// filters both sources identically.
//
// `state.agents` stays authoritative for every id it still holds — it carries the
// freshest result/feedback for a run whose archive was written back at completion
// time — so the archive is consulted only for ids the date-bucket INDEX lists and
// state has already evicted. The index is a tiny in-memory id→date map, so a date
// whose agents are all still live costs zero disk reads, while a date already
// swept out of state.json by `archiveStaleAgents` resolves from disk instead of
// reading as empty (issue #3501: reports for past dates came back all-zero, and
// every dashboard refresh linearly rescanned the whole agent history).
//
// HANDOFF records are dropped from both sources. Every caller here is building
// outcome statistics — succeeded vs failed, accomplishments vs incidents — and a
// record `resumeAgent` retired to requeue its own task has no outcome yet: the
// continuation it handed the task to records that. Counting it booked one failed
// task per provider swap in the daily report and the "While You Were Away"
// briefing, which is the failure a user sees for pressing Relaunch.
async function collectCompletedAgents(dates, state, accept) {
  // One predicate over the projection, both sources: the live and archived arms are the same
  // question asked of two stores, and writing it twice is how they drift.
  const keep = (projection) => !!projection.completedAt && !projection.handoff && accept(projection);
  const liveIds = new Set(Object.keys(state.agents));
  const collected = [];
  for (const agent of Object.values(state.agents)) {
    const projection = projectArchivedAgent(agent);
    if (keep(projection)) collected.push({ id: agent.id, projection, agent });
  }

  // The archive answers from the completion-order projection (#17309): no metadata.json is parsed
  // here. `selectArchivedCompletions` only returns ids the date-bucket index owns, so non-indexed
  // strays stay out, and an id still in state is skipped because its live copy wins.
  const archived = await selectArchivedCompletions({ dates, includeIncomplete: true });
  for (const { id, day, projection } of archived) {
    if (liveIds.has(id) || !keep(projection)) continue;
    collected.push({ id, day, projection });
  }
  return collected;
}

// Work duration from a projection: `result.duration` when recorded, else completedAt − startedAt.
// Clamped to >=0 so a clock-skewed record can't surface a negative duration.
function projectionDurationMs(p) {
  const d = p.resultDuration
    || (p.completedAt && p.startedAt ? new Date(p.completedAt).getTime() - new Date(p.startedAt).getTime() : 0);
  return d > 0 ? d : 0;
}

// Full records for the few entries a response actually renders. A live entry already holds its
// record; an archived one is read once, without summary repair. A record that vanished or went
// unparseable since projection is dropped rather than rendered blank.
async function hydrateEntries(entries) {
  const records = await Promise.all(entries.map(entry => entry.agent
    ? entry.agent
    : readArchivedAgentMetadata(entry.day, entry.id, { repairSummaries: false })));
  return records.filter(Boolean);
}

const byCompletionDesc = (a, b) => new Date(b.projection.completedAt) - new Date(a.projection.completedAt);

export async function listBriefings() {
  await ensureDirectories();

  const files = await readdir(REPORTS_DIR);
  return files
    .filter(f => f.endsWith('-briefing.md'))
    .map(f => {
      const date = f.replace('-briefing.md', '');
      return { date, filename: f };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

export async function getBriefing(date) {
  const briefingFile = join(REPORTS_DIR, `${date}-briefing.md`);

  if (!existsSync(briefingFile)) {
    return null;
  }

  const content = await readFile(briefingFile, 'utf-8');
  return { date, content };
}

/**
 * The Daily Briefing's generated image (`dailyImage`, #17398) as a structured
 * notification attachment, so Telegram delivers it inline. The briefing agent
 * writes the image-gen result path (`/data/images/<file>.png`) into the report;
 * only that path is surfaced here, and the Telegram forward still jails it
 * before any upload. Best-effort: a missing/unreadable report or no image
 * yields no attachment, never a lost notification.
 *
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<Array<{ path: string, kind: 'photo', caption: string }>>}
 */
export async function getBriefingImageAttachments(date) {
  const briefing = await getBriefing(date).catch((err) => {
    console.log(`📋 Daily briefing image lookup skipped: ${err.message}`);
    return null;
  });
  const { firstImagePath } = await import('../../lib/telegramDeliverables.js');
  const imagePath = firstImagePath(briefing?.content);
  return imagePath ? [{ path: imagePath, kind: 'photo', caption: `Daily Image — ${date}` }] : [];
}

export async function getLatestBriefing() {
  const briefings = await listBriefings();
  if (briefings.length === 0) return null;
  return getBriefing(briefings[0].date);
}

export async function getTodayActivity() {
  const state = await loadState();
  const today = new Date().toISOString().split('T')[0];

  // Agents completed today, from today's date bucket (index-gated) + live state
  const todayAgents = await collectCompletedAgents(
    [today],
    state,
    p => p.completedAt.startsWith(today)
  );

  const succeeded = todayAgents.filter(e => e.projection.success);
  const failed = todayAgents.filter(e => !e.projection.success);

  // Calculate total time worked (sum of agent durations)
  const totalDurationMs = todayAgents.reduce((sum, e) => sum + projectionDurationMs(e.projection), 0);

  // Get currently running agents
  const runningAgents = Object.values(state.agents).filter(a => a.status === 'running');
  const activeTimeMs = runningAgents.reduce((sum, a) => {
    if (!a.startedAt) return sum;
    return sum + (Date.now() - new Date(a.startedAt).getTime());
  }, 0);

  // Get top accomplishments (successful tasks with description snippets)
  const accomplishments = (await hydrateEntries(succeeded.sort(byCompletionDesc).slice(0, 5)))
    .map(a => ({
      id: a.id,
      taskId: a.taskId,
      description: a.metadata?.taskDescription?.substring(0, 100) || a.taskId,
      taskType: a.metadata?.analysisType || a.metadata?.taskType || 'task',
      duration: projectionDurationMs(projectArchivedAgent(a)),
      completedAt: a.completedAt
    }));

  // Calculate success rate
  const successRate = todayAgents.length > 0
    ? Math.round((succeeded.length / todayAgents.length) * 100)
    : 0;

  return {
    date: today,
    stats: {
      completed: todayAgents.length,
      succeeded: succeeded.length,
      failed: failed.length,
      successRate,
      running: runningAgents.length
    },
    time: {
      totalDurationMs,
      totalDuration: formatDuration(totalDurationMs),
      activeDurationMs: activeTimeMs,
      activeDuration: formatDuration(activeTimeMs),
      combinedMs: totalDurationMs + activeTimeMs,
      combined: formatDuration(totalDurationMs + activeTimeMs)
    },
    accomplishments,
    lastEvaluation: state.stats.lastEvaluation,
    isRunning: isDaemonRunning(),
    isPaused: state.paused
  };
}

// Build a compact accomplishment/incident card for the "While You Were Away"
// briefing. Pure shaping helper — no I/O — so it's trivially unit-testable.
async function summarizeAwayActivity(entries, sinceIso) {
  const succeeded = entries.filter(e => e.projection.success);
  const failed = entries.filter(e => !e.projection.success);

  const toCard = (a) => {
    const durationMs = projectionDurationMs(projectArchivedAgent(a));
    return {
      id: a.id,
      taskId: a.taskId,
      description: a.metadata?.taskDescription?.substring(0, 120) || a.taskId,
      taskType: a.metadata?.analysisType || a.metadata?.taskType || 'task',
      app: a.metadata?.app || null,
      success: a.result?.success || false,
      durationMs,
      durationFormatted: formatDuration(durationMs),
      completedAt: a.completedAt,
      completedRelative: formatRelativeTime(a.completedAt)
    };
  };

  // Aggregates come from the projection; full records are read only for the cards returned.
  const totalDurationMs = entries.reduce((sum, e) => sum + projectionDurationMs(e.projection), 0);
  const [accomplishments, incidents] = await Promise.all([
    hydrateEntries(succeeded.sort(byCompletionDesc).slice(0, 8)),
    hydrateEntries(failed.sort(byCompletionDesc).slice(0, 8)),
  ]);

  return {
    sinceIso,
    stats: {
      completed: entries.length,
      succeeded: succeeded.length,
      failed: failed.length,
      successRate: entries.length > 0
        ? Math.round((succeeded.length / entries.length) * 100)
        : 0
    },
    time: {
      totalDurationMs,
      totalDuration: formatDuration(totalDurationMs)
    },
    accomplishments: accomplishments.map(toCard),
    incidents: incidents.map(toCard)
  };
}

// "What did agents do while I was away?" — completed agent runs since a
// client-supplied `sinceIso` (the browser's last-visit marker). Reads
// in-memory state for fresh runs PLUS the date-bucket archives for any day
// touched by the window, so a multi-day absence still surfaces work that
// has already been archived off the live state.
//
// Invalid/absent `sinceIso` falls back to the last 24h so the card always
// renders something useful rather than erroring. The window is clamped to a
// 30-day lookback to bound the number of archive buckets we read.
const AWAY_MAX_LOOKBACK_MS = 30 * 86400000;
export async function getWhileAwayActivity(sinceIso) {
  const now = Date.now();
  const parsed = sinceIso ? new Date(sinceIso).getTime() : NaN;
  // Clamp: a missing/garbage marker → 24h; a marker older than 30d → 30d ago;
  // a future marker → 24h (a clock-skewed client shouldn't blank the card).
  let sinceMs = Number.isFinite(parsed) ? parsed : now - 86400000;
  if (sinceMs > now) sinceMs = now - 86400000;
  if (sinceMs < now - AWAY_MAX_LOOKBACK_MS) sinceMs = now - AWAY_MAX_LOOKBACK_MS;
  const effectiveSinceIso = new Date(sinceMs).toISOString();

  const inWindow = (p) => {
    if (!p.completedAt) return false;
    const t = new Date(p.completedAt).getTime();
    return Number.isFinite(t) && t >= sinceMs && t <= now;
  };

  // Every UTC day string the window spans — each is a date bucket to consider.
  const dates = [];
  const startDay = new Date(sinceMs);
  const endDay = new Date(now);
  for (let d = new Date(Date.UTC(startDay.getUTCFullYear(), startDay.getUTCMonth(), startDay.getUTCDate()));
    d.getTime() <= endDay.getTime();
    d = new Date(d.getTime() + 86400000)) {
    dates.push(d.toISOString().slice(0, 10));
  }

  const state = await loadState();
  const agents = await collectCompletedAgents(
    dates,
    state,
    p => p.completed && inWindow(p)
  );

  const summary = await summarizeAwayActivity(agents, effectiveSinceIso);
  return { ...summary, isRunning: isDaemonRunning(), isPaused: state.paused };
}

// Returns recently completed tasks from in-memory state only.
// Agents older than the retention window are archived to date-bucketed dirs
// and are not included here — use getAgentsByDate() for historical lookups.
export async function getRecentTasks(limit = 10) {
  const state = await loadState();

  const completedAgents = Object.values(state.agents)
    // Same exclusion the date-bucket collector above applies, for the same
    // reason: this returns a succeeded/failed split, and a record `resumeAgent`
    // retired to requeue its own task reached no verdict. It reads live state
    // directly rather than through that collector (no date window to gate on),
    // so the rule has to be stated here too — which is why it is the one place
    // that still showed a provider swap as a failed task after the rest of the
    // file stopped.
    .filter(a => a.status === 'completed' && a.completedAt && !isAgentHandoff(a))
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
    .slice(0, limit);

  // Transform to compact task summaries
  const tasks = completedAgents.map(a => ({
    id: a.id,
    taskId: a.taskId,
    description: a.metadata?.taskDescription?.substring(0, 120) || a.taskId,
    taskType: a.metadata?.analysisType || a.metadata?.taskType || 'task',
    app: a.metadata?.app || null,
    success: a.result?.success || false,
    duration: a.result?.duration || 0,
    durationFormatted: formatDuration(a.result?.duration || 0),
    completedAt: a.completedAt,
    completedRelative: formatRelativeTime(a.completedAt)
  }));

  // Calculate summary stats
  const successCount = tasks.filter(t => t.success).length;
  const failCount = tasks.filter(t => !t.success).length;

  return {
    tasks,
    summary: {
      total: tasks.length,
      succeeded: successCount,
      failed: failCount,
      successRate: tasks.length > 0 ? Math.round((successCount / tasks.length) * 100) : 0
    }
  };
}

export function formatRelativeTime(timestamp) {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
