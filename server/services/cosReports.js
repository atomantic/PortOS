/**
 * CoS Reports Module
 *
 * Reports, briefings, and activity tracking extracted from cos.js.
 * Handles daily reports, briefings, activity summaries, and recent tasks.
 */

import { readFile, writeFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadState, ensureDirectories, REPORTS_DIR, isDaemonRunning } from './cosState.js';
import { getAgentsByDate } from './cosAgents.js';
import { formatDuration, safeJSONParse } from '../lib/fileUtils.js';

// A completed agent's work duration in ms: prefer the recorded `result.duration`,
// else derive from completedAt − startedAt. Clamped to >=0 so a clock-skewed
// record (completedAt < startedAt) can't surface a negative duration.
function agentDurationMs(a) {
  const d = a.result?.duration
    || (a.completedAt && a.startedAt
      ? new Date(a.completedAt).getTime() - new Date(a.startedAt).getTime()
      : 0);
  return d > 0 ? d : 0;
}

export async function generateReport(date = null) {
  const reportDate = date || new Date().toISOString().split('T')[0];
  const state = await loadState();

  // Filter agents completed on this date
  const completedAgents = Object.values(state.agents).filter(a => {
    if (!a.completedAt) return false;
    return a.completedAt.startsWith(reportDate);
  });

  const report = {
    date: reportDate,
    generated: new Date().toISOString(),
    summary: {
      tasksCompleted: completedAgents.filter(a => a.result?.success).length,
      tasksFailed: completedAgents.filter(a => !a.result?.success).length,
      totalAgents: completedAgents.length
    },
    agents: completedAgents.map(a => ({
      id: a.id,
      taskId: a.taskId,
      success: a.result?.success || false,
      duration: a.completedAt && a.startedAt
        ? new Date(a.completedAt) - new Date(a.startedAt)
        : 0
    }))
  };

  // Save report
  const reportFile = join(REPORTS_DIR, `${reportDate}.json`);
  await writeFile(reportFile, JSON.stringify(report, null, 2));

  return report;
}

export async function getReport(date) {
  const reportFile = join(REPORTS_DIR, `${date}.json`);

  if (!existsSync(reportFile)) {
    return null;
  }

  const content = await readFile(reportFile, 'utf-8');
  return safeJSONParse(content, null, { logError: true, context: `report ${date}` });
}

export async function getTodayReport() {
  const today = new Date().toISOString().split('T')[0];
  return (await getReport(today)) ?? generateReport(today);
}

export async function listReports() {
  await ensureDirectories();

  const files = await readdir(REPORTS_DIR);
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .sort()
    .reverse();
}

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

export async function getLatestBriefing() {
  const briefings = await listBriefings();
  if (briefings.length === 0) return null;
  return getBriefing(briefings[0].date);
}

export async function getTodayActivity() {
  const state = await loadState();
  const today = new Date().toISOString().split('T')[0];

  // Filter agents completed today
  const todayAgents = Object.values(state.agents).filter(a => {
    if (!a.completedAt) return false;
    return a.completedAt.startsWith(today);
  });

  const succeeded = todayAgents.filter(a => a.result?.success);
  const failed = todayAgents.filter(a => !a.result?.success);

  // Calculate total time worked (sum of agent durations)
  const totalDurationMs = todayAgents.reduce((sum, a) => sum + agentDurationMs(a), 0);

  // Get currently running agents
  const runningAgents = Object.values(state.agents).filter(a => a.status === 'running');
  const activeTimeMs = runningAgents.reduce((sum, a) => {
    if (!a.startedAt) return sum;
    return sum + (Date.now() - new Date(a.startedAt).getTime());
  }, 0);

  // Get top accomplishments (successful tasks with description snippets)
  const accomplishments = succeeded
    .map(a => ({
      id: a.id,
      taskId: a.taskId,
      description: a.metadata?.taskDescription?.substring(0, 100) || a.taskId,
      taskType: a.metadata?.analysisType || a.metadata?.taskType || 'task',
      duration: agentDurationMs(a),
      completedAt: a.completedAt
    }))
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
    .slice(0, 5);

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
function summarizeAwayActivity(agents, sinceIso) {
  const succeeded = agents.filter(a => a.result?.success);
  const failed = agents.filter(a => !a.result?.success);

  const toCard = (a) => {
    const durationMs = agentDurationMs(a);
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

  // Most-recent first so the freshest work tops each list.
  const byRecency = (a, b) => new Date(b.completedAt) - new Date(a.completedAt);
  const totalDurationMs = agents.reduce((sum, a) => sum + agentDurationMs(a), 0);

  return {
    sinceIso,
    stats: {
      completed: agents.length,
      succeeded: succeeded.length,
      failed: failed.length,
      successRate: agents.length > 0
        ? Math.round((succeeded.length / agents.length) * 100)
        : 0
    },
    time: {
      totalDurationMs,
      totalDuration: formatDuration(totalDurationMs)
    },
    accomplishments: succeeded.sort(byRecency).slice(0, 8).map(toCard),
    incidents: failed.sort(byRecency).slice(0, 8).map(toCard)
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

  const inWindow = (a) => {
    if (!a.completedAt) return false;
    const t = new Date(a.completedAt).getTime();
    return Number.isFinite(t) && t >= sinceMs && t <= now;
  };

  // Live (in-memory) completed agents within the window.
  const state = await loadState();
  const live = Object.values(state.agents).filter(a => a.status === 'completed' && inWindow(a));

  // Archived agents: read each date bucket the window spans (UTC day strings).
  const seen = new Set(live.map(a => a.id));
  const archived = [];
  const startDay = new Date(sinceMs);
  const endDay = new Date(now);
  for (let d = new Date(Date.UTC(startDay.getUTCFullYear(), startDay.getUTCMonth(), startDay.getUTCDate()));
    d.getTime() <= endDay.getTime();
    d = new Date(d.getTime() + 86400000)) {
    const dateStr = d.toISOString().slice(0, 10);
    const agents = await getAgentsByDate(dateStr);
    for (const a of agents) {
      if (seen.has(a.id)) continue; // live copy wins (fresher result/output)
      if (!inWindow(a)) continue;
      seen.add(a.id);
      archived.push(a);
    }
  }

  const summary = summarizeAwayActivity([...live, ...archived], effectiveSinceIso);
  return { ...summary, isRunning: isDaemonRunning(), isPaused: state.paused };
}

// Returns recently completed tasks from in-memory state only.
// Agents older than the retention window are archived to date-bucketed dirs
// and are not included here — use getAgentsByDate() for historical lookups.
export async function getRecentTasks(limit = 10) {
  const state = await loadState();

  const completedAgents = Object.values(state.agents)
    .filter(a => a.status === 'completed' && a.completedAt)
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
