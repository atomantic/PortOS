/**
 * Proactive Alerts Service
 *
 * Analyzes system data to surface actionable alerts proactively:
 *   - Goal stalls (no progress in 14+ days)
 *   - Task success rate drops (task types with low success rates)
 *   - System health warnings (high memory/CPU, errored processes)
 *   - Learning health issues (skipped or critical task types)
 *   - AI usage spikes (token/session usage significantly above rolling average)
 *
 * Designed to be called on-demand from the dashboard widget
 * and optionally from autonomous jobs.
 */

import os from 'os';
import { getGoals } from './identity.js';
import { getPerformanceSummary, getLearningSummary } from './taskLearning.js';
import { listProcesses } from './pm2.js';
import { getUsage } from './usage.js';
import { getMemoryStats } from '../lib/memoryStats.js';

const STALL_THRESHOLD_DAYS = 14;
const SUCCESS_RATE_WARNING = 50;
const MEMORY_WARNING_PCT = 85;
const MEMORY_CRITICAL_PCT = 95;
const CPU_WARNING_PCT = 90;
const USAGE_SPIKE_MULTIPLIER = 2.5;
const USAGE_MIN_HISTORY_DAYS = 3;

/**
 * Detect goals that have stalled (no progress update in 14+ days)
 */
async function checkGoalStalls() {
  const goalsData = await getGoals().catch(() => null);
  if (!goalsData?.goals?.length) return [];

  const now = Date.now();
  const alerts = [];

  for (const goal of goalsData.goals) {
    if (goal.status !== 'active' || goal.parentId) continue;

    const lastUpdate = goal.progressHistory?.length
      ? goal.progressHistory.reduce((a, b) => b.timestamp > a.timestamp ? b : a).timestamp
      : goal.createdAt;

    if (!lastUpdate) continue;

    const daysSince = Math.floor((now - new Date(lastUpdate).getTime()) / 86400000);
    if (daysSince >= STALL_THRESHOLD_DAYS) {
      alerts.push({
        type: 'goal_stall',
        severity: daysSince >= 30 ? 'high' : 'medium',
        title: `Goal stalled: ${goal.title}`,
        detail: `No progress in ${daysSince} days`,
        link: '/goals',
        metadata: { goalId: goal.id, daysSince, progress: goal.progress || 0 }
      });
    }
  }

  return alerts;
}

/**
 * Detect task types with poor success rates
 */
async function checkSuccessRates() {
  const perf = await getPerformanceSummary().catch(() => null);
  if (!perf) return [];

  return (perf.needsAttention || []).map(item => ({
    type: 'success_drop',
    severity: item.successRate < 30 ? 'high' : 'medium',
    title: `Low success rate: ${item.taskType}`,
    detail: `${item.successRate}% success across ${item.completed} tasks`,
    link: '/cos/learning',
    metadata: { taskType: item.taskType, successRate: item.successRate, completed: item.completed }
  }));
}

/**
 * Check for system resource warnings (memory, CPU, errored processes)
 */
async function checkSystemHealth() {
  const alerts = [];

  const memStats = await getMemoryStats();
  const memPct = Math.round((memStats.used / memStats.total) * 100);

  if (memPct >= MEMORY_WARNING_PCT) {
    const formatGB = (bytes) => `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
    alerts.push({
      type: 'system_resource',
      severity: memPct >= MEMORY_CRITICAL_PCT ? 'critical' : 'high',
      title: 'High memory usage',
      detail: `${memPct}% — ${formatGB(memStats.used)} / ${formatGB(memStats.total)}`,
      link: '/apps',
      metadata: { resource: 'memory', percent: memPct }
    });
  }

  // CPU check
  const cpuLoad = os.loadavg()[0];
  const cpuCount = os.cpus().length;
  const cpuPct = Math.round((cpuLoad / cpuCount) * 100);

  if (cpuPct >= CPU_WARNING_PCT) {
    alerts.push({
      type: 'system_resource',
      severity: 'high',
      title: 'High CPU usage',
      detail: `${cpuPct}% across ${cpuCount} cores`,
      link: '/apps',
      metadata: { resource: 'cpu', percent: cpuPct }
    });
  }

  // PM2 process errors
  const processes = await listProcesses().catch(() => []);
  const errored = processes.filter(p => p.status === 'errored').length;
  if (errored > 0) {
    alerts.push({
      type: 'process_error',
      severity: 'high',
      title: `${errored} errored process${errored > 1 ? 'es' : ''}`,
      detail: `${errored} of ${processes.length} processes in error state`,
      link: '/apps',
      metadata: { errored, total: processes.length }
    });
  }

  const crashing = processes.filter(p => (p.unstableRestarts || 0) > 0);
  if (crashing.length > 0) {
    const total = crashing.reduce((sum, p) => sum + (p.unstableRestarts || 0), 0);
    alerts.push({
      type: 'process_error',
      severity: 'high',
      title: `${crashing.length} process${crashing.length > 1 ? 'es' : ''} in crash loop`,
      detail: `${total} crash-loop restart${total === 1 ? '' : 's'}: ${crashing.map(p => p.name).join(', ')}`,
      link: '/apps',
      metadata: { unstableRestarts: total, names: crashing.map(p => p.name) }
    });
  }

  return alerts;
}

/**
 * Check task learning health for critical issues
 */
async function checkLearningHealth() {
  const summary = await getLearningSummary().catch(() => null);
  if (!summary || summary.status === 'good' || summary.status === 'none') return [];

  const alerts = [];

  if (summary.skipped > 0) {
    alerts.push({
      type: 'learning_health',
      severity: 'high',
      title: `${summary.skipped} task type${summary.skipped > 1 ? 's' : ''} being skipped`,
      detail: 'Very low success rates caused automatic skip — review task configuration',
      link: '/cos/learning',
      metadata: { skipped: summary.skipped, critical: summary.critical }
    });
  } else if (summary.critical > 0) {
    alerts.push({
      type: 'learning_health',
      severity: 'medium',
      title: `${summary.critical} task type${summary.critical > 1 ? 's' : ''} need attention`,
      detail: `Success rates below ${SUCCESS_RATE_WARNING}% — may need provider or prompt adjustments`,
      link: '/cos/learning',
      metadata: { critical: summary.critical, warning: summary.warning }
    });
  }

  return alerts;
}

/**
 * Detect AI usage spikes (tokens or sessions significantly above rolling average)
 */
async function checkUsageSpikes() {
  const usage = getUsage();
  if (!usage?.dailyActivity) return [];

  const daily = usage.dailyActivity;
  const today = new Date().toISOString().split('T')[0];

  // Collect recent days (excluding today since it's incomplete)
  const recentDays = [];
  for (let i = 1; i <= 14; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const dayData = daily[dateStr];
    if (dayData && dayData.sessions > 0) {
      recentDays.push(dayData);
    }
  }

  if (recentDays.length < USAGE_MIN_HISTORY_DAYS) return [];

  const avgTokens = recentDays.reduce((sum, d) => sum + (d.tokens || 0), 0) / recentDays.length;
  const avgSessions = recentDays.reduce((sum, d) => sum + (d.sessions || 0), 0) / recentDays.length;

  const alerts = [];
  const todayData = daily[today];

  if (todayData && avgTokens > 0) {
    const tokenRatio = todayData.tokens / avgTokens;
    if (tokenRatio >= USAGE_SPIKE_MULTIPLIER) {
      const formatTokens = (t) => t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
      alerts.push({
        type: 'cost_spike',
        severity: tokenRatio >= 5 ? 'high' : 'medium',
        title: 'AI token usage spike',
        detail: `${formatTokens(todayData.tokens)} tokens today vs ${formatTokens(Math.round(avgTokens))} avg/day (${tokenRatio.toFixed(1)}x)`,
        link: '/devtools/usage',
        metadata: { resource: 'tokens', today: todayData.tokens, average: Math.round(avgTokens), ratio: Math.round(tokenRatio * 10) / 10 }
      });
    }

    const sessionRatio = todayData.sessions / avgSessions;
    if (sessionRatio >= USAGE_SPIKE_MULTIPLIER && avgSessions > 0) {
      alerts.push({
        type: 'cost_spike',
        severity: sessionRatio >= 5 ? 'high' : 'medium',
        title: 'AI session spike',
        detail: `${todayData.sessions} sessions today vs ${Math.round(avgSessions)} avg/day (${sessionRatio.toFixed(1)}x)`,
        link: '/devtools/usage',
        metadata: { resource: 'sessions', today: todayData.sessions, average: Math.round(avgSessions), ratio: Math.round(sessionRatio * 10) / 10 }
      });
    }
  }

  return alerts;
}

/**
 * Generate all proactive alerts by running all checks.
 * Returns a sorted list with critical/high items first.
 */
export async function generateAlerts() {
  const startMs = Date.now();

  const [goalAlerts, successAlerts, systemAlerts, learningAlerts, usageAlerts] = await Promise.all([
    checkGoalStalls(),
    checkSuccessRates(),
    checkSystemHealth(),
    checkLearningHealth(),
    checkUsageSpikes()
  ]);

  const all = [...goalAlerts, ...successAlerts, ...systemAlerts, ...learningAlerts, ...usageAlerts];

  // Sort by severity: critical > high > medium > low
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  all.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

  // Single-pass severity counts
  const counts = { total: all.length, critical: 0, high: 0, medium: 0 };
  for (const a of all) {
    if (counts[a.severity] !== undefined) counts[a.severity]++;
  }

  const durationMs = Date.now() - startMs;
  console.log(`🔔 Proactive alerts: ${counts.total} (critical: ${counts.critical}, high: ${counts.high}) in ${durationMs}ms`);

  return { alerts: all, counts, checkedAt: new Date().toISOString() };
}

/**
 * Get a compact summary suitable for dashboard display.
 * Returns top 5 alerts and aggregate counts.
 */
export async function getAlertsSummary() {
  const result = await generateAlerts();
  return {
    alerts: result.alerts.slice(0, 5),
    counts: result.counts,
    checkedAt: result.checkedAt
  };
}
