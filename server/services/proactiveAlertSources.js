/**
 * Non-product proactive alert sources.
 *
 * These checks are shared by the legacy proactive-alert projection and the
 * Review Queue's health producer. Product-engagement recommendations stay in
 * portosProductMetrics.js as a leaf source so the queue never imports an
 * aggregate that also consumes the queue's product actions.
 */

import os from 'os';
import { getGoals } from './identity.js';
import { getPerformanceSummary } from './taskLearning.js';
import { listProcesses } from './pm2.js';
import { annotateExpectedExit } from './apps.js';
import { getUsage } from './usage.js';
import { getCareSummary } from './tribe.js';
import { findUnansweredTribeThreads } from './tribeOutreach.js';
import { getMemoryStats } from '../lib/memoryStats.js';

const STALL_THRESHOLD_DAYS = 14;
const SUCCESS_RATE_WARNING = 50;
const MEMORY_WARNING_PCT = 85;
const MEMORY_CRITICAL_PCT = 95;
const CPU_WARNING_PCT = 90;
const USAGE_SPIKE_MULTIPLIER = 2.5;
const USAGE_MIN_HISTORY_DAYS = 3;

/**
 * Condition + explicit resource identity, never presentation text or
 * position. Encode each segment separately so a resource containing ':'
 * cannot collide. Missing resource identity is a failed source read, not
 * permission to mint a positional ID or claim the queue is empty.
 */
function alertId(condition, resource) {
  const valid = typeof resource === 'string' ? resource.trim().length > 0
    : Number.isSafeInteger(resource) && resource >= 0;
  if (!valid) throw new Error('Alert resource identity is unavailable');
  return `${condition}:${encodeURIComponent(resource)}`;
}

/** Detect goals that have stalled (no progress update in 14+ days). */
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
        id: alertId('goal_stall', goal.id),
        type: 'goal_stall',
        severity: daysSince >= 30 ? 'high' : 'medium',
        title: `Goal stalled: ${goal.title}`,
        detail: `No progress in ${daysSince} days`,
        link: '/goals',
        metadata: { goalId: goal.id, daysSince, progress: goal.progress || 0 },
      });
    }
  }

  return alerts;
}

/**
 * A low lifetime rate is historical context, not a current anomaly. The
 * performance summary only selects `windowed` after enough recent runs, so
 * thin samples do not create noisy alerts.
 */
function hasCurrentPerformanceEvidence(item) {
  return item?.rateSource === 'windowed';
}

/** Detect recently active task types with poor success rates. */
async function checkSuccessRates() {
  const perf = await getPerformanceSummary().catch(() => null);
  if (!perf) return [];

  return (perf.needsAttention || [])
    .filter(hasCurrentPerformanceEvidence)
    .map(item => ({
      id: alertId('success_drop', item.taskType),
      type: 'success_drop',
      severity: item.successRate < 30 ? 'high' : 'medium',
      title: `Low success rate: ${item.taskType}`,
      detail: `${item.successRate}% success across the last ${item.windowedCompleted} runs`,
      link: '/cos/learning',
      metadata: {
        taskType: item.taskType,
        successRate: item.successRate,
        completed: item.completed,
        rateSource: item.rateSource,
        windowedCompleted: item.windowedCompleted,
      },
    }));
}

/** Check for system resource warnings (memory, CPU, errored processes). */
async function checkSystemHealth() {
  const alerts = [];

  const memStats = await getMemoryStats();
  const memPct = Math.round((memStats.used / memStats.total) * 100);

  if (memPct >= MEMORY_WARNING_PCT) {
    const formatGB = (bytes) => `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
    alerts.push({
      id: alertId('system_resource', 'memory'),
      type: 'system_resource',
      severity: memPct >= MEMORY_CRITICAL_PCT ? 'critical' : 'high',
      title: 'High memory usage',
      detail: `${memPct}% — ${formatGB(memStats.used)} / ${formatGB(memStats.total)}`,
      link: '/apps',
      metadata: { resource: 'memory', percent: memPct },
    });
  }

  const cpuLoad = os.loadavg()[0];
  const cpuCount = os.cpus().length;
  const cpuPct = Math.round((cpuLoad / cpuCount) * 100);

  if (cpuPct >= CPU_WARNING_PCT) {
    alerts.push({
      id: alertId('system_resource', 'cpu'),
      type: 'system_resource',
      severity: 'high',
      title: 'High CPU usage',
      detail: `${cpuPct}% across ${cpuCount} cores`,
      link: '/apps',
      metadata: { resource: 'cpu', percent: cpuPct },
    });
  }

  // PM2 process errors. Processes whose exit is expected (a desktop app the
  // user quit) are excluded: that is a normal end to a session, and alerting
  // on it would report every play session as a failure. See issue #2991.
  const processes = await listProcesses().catch(() => []);
  const alertable = (await annotateExpectedExit(processes)).filter(p => !p.expectedExit);
  for (const process of alertable) {
    if (process.status === 'errored') {
      alerts.push({
        id: alertId('process_errored', process.pm_id),
        type: 'process_error',
        severity: 'high',
        title: `Errored process: ${process.name}`,
        detail: 'Review the process logs and restart it after addressing the failure',
        link: '/apps',
        metadata: { processId: process.pm_id, errored: 1, total: alertable.length },
      });
    }
    if ((process.unstableRestarts || 0) > 0) {
      alerts.push({
        id: alertId('process_crash_loop', process.pm_id),
        type: 'process_error',
        severity: 'high',
        title: `Process in crash loop: ${process.name}`,
        detail: `${process.unstableRestarts} crash-loop restarts — review the process logs`,
        link: '/apps',
        metadata: { processId: process.pm_id, unstableRestarts: process.unstableRestarts, names: [process.name] },
      });
    }
  }

  return alerts;
}

/** Check task learning health for critical issues. */
async function checkLearningHealth() {
  const perf = await getPerformanceSummary().catch(() => null);
  if (!perf) return [];

  const alerts = [];
  const recentAttention = (perf.needsAttention || []).filter(hasCurrentPerformanceEvidence);
  const skipped = (perf.skipped || []).filter(hasCurrentPerformanceEvidence).length;
  const critical = recentAttention.filter(item => item.successRate < 40).length;
  const warning = recentAttention.length - critical;

  if (skipped > 0) {
    alerts.push({
      id: alertId('learning_skipped', 'all'),
      type: 'learning_health',
      severity: 'high',
      title: `${skipped} task type${skipped > 1 ? 's' : ''} being skipped`,
      detail: 'Very low success rates caused automatic skip — review task configuration',
      link: '/cos/learning',
      metadata: { skipped, critical },
    });
  } else if (critical > 0) {
    alerts.push({
      id: alertId('learning_critical', 'all'),
      type: 'learning_health',
      severity: 'medium',
      title: `${critical} task type${critical > 1 ? 's' : ''} need attention`,
      detail: `Success rates below ${SUCCESS_RATE_WARNING}% — may need provider or prompt adjustments`,
      link: '/cos/learning',
      metadata: { critical, warning },
    });
  }

  return alerts;
}

/** Detect AI usage spikes against the recent rolling average. */
async function checkUsageSpikes() {
  const usage = getUsage();
  if (!usage?.dailyActivity) return [];

  const daily = usage.dailyActivity;
  const today = new Date().toISOString().split('T')[0];
  const recentDays = [];
  for (let i = 1; i <= 14; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const dayData = daily[dateStr];
    if (dayData && dayData.sessions > 0) recentDays.push(dayData);
  }

  if (recentDays.length < USAGE_MIN_HISTORY_DAYS) return [];

  const avgTokens = recentDays.reduce((sum, day) => sum + (day.tokens || 0), 0) / recentDays.length;
  const avgSessions = recentDays.reduce((sum, day) => sum + (day.sessions || 0), 0) / recentDays.length;
  const alerts = [];
  const todayData = daily[today];

  if (todayData && avgTokens > 0) {
    const tokenRatio = todayData.tokens / avgTokens;
    if (tokenRatio >= USAGE_SPIKE_MULTIPLIER) {
      const formatTokens = (tokens) => tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
      alerts.push({
        id: alertId('cost_spike', 'tokens'),
        type: 'cost_spike',
        severity: tokenRatio >= 5 ? 'high' : 'medium',
        title: 'AI token usage spike',
        detail: `${formatTokens(todayData.tokens)} tokens today vs ${formatTokens(Math.round(avgTokens))} avg/day (${tokenRatio.toFixed(1)}x)`,
        link: '/devtools/usage',
        metadata: { resource: 'tokens', today: todayData.tokens, average: Math.round(avgTokens), ratio: Math.round(tokenRatio * 10) / 10 },
      });
    }

    const sessionRatio = todayData.sessions / avgSessions;
    if (sessionRatio >= USAGE_SPIKE_MULTIPLIER && avgSessions > 0) {
      alerts.push({
        id: alertId('cost_spike', 'sessions'),
        type: 'cost_spike',
        severity: sessionRatio >= 5 ? 'high' : 'medium',
        title: 'AI session spike',
        detail: `${todayData.sessions} sessions today vs ${Math.round(avgSessions)} avg/day (${sessionRatio.toFixed(1)}x)`,
        link: '/devtools/usage',
        metadata: { resource: 'sessions', today: todayData.sessions, average: Math.round(avgSessions), ratio: Math.round(sessionRatio * 10) / 10 },
      });
    }
  }

  return alerts;
}

/** Detect Tribe relationships overdue for contact. */
async function checkTribeCadence() {
  const summary = await getCareSummary(3).catch(() => null);
  if (!summary || summary.overdueCount === 0) return [];

  const names = summary.overdue.map((person) => person.name).filter(Boolean).join(', ');
  const overflow = summary.overdueCount > summary.overdue.length ? ', …' : '';
  return [{
    id: alertId('tribe_cadence', 'all'),
    type: 'tribe_cadence',
    severity: summary.overdueCount >= 3 ? 'high' : 'medium',
    title: `${summary.overdueCount} ${summary.overdueCount === 1 ? 'person is' : 'people are'} overdue for contact`,
    detail: names ? `Reach out to ${names}${overflow}` : 'Overdue check-ins in your Tribe',
    link: '/tribe',
    metadata: { overdueCount: summary.overdueCount, peopleCount: summary.peopleCount },
  }];
}

/**
 * Detect unanswered inbound Tribe threads. Detection only — drafting a reply
 * is a separate user-action-gated step.
 */
async function checkUnansweredTribeThreads() {
  const threads = await findUnansweredTribeThreads().catch(() => []);
  if (!threads.length) return [];

  const ago = (days) => (days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`);
  return threads.map((thread) => {
    const snippet = thread.snippet ? `“${thread.snippet}”` : 'their message';
    return {
      id: alertId('tribe_unanswered', thread.conversationKey),
      type: 'tribe_unanswered',
      severity: thread.daysAgo >= 7 ? 'high' : 'medium',
      title: `Unanswered: ${thread.personName}`,
      detail: `You never replied to ${snippet} (${ago(thread.daysAgo)})`,
      link: `/tribe?tab=care&outreach=${encodeURIComponent(thread.conversationKey)}`,
      metadata: {
        personId: thread.personId,
        source: thread.source,
        threadId: thread.threadId,
        chatGuid: thread.chatGuid,
        conversationId: thread.conversationId,
        handle: thread.handle,
        lastInboundAt: thread.lastInboundAt,
        daysAgo: thread.daysAgo,
      },
    };
  });
}

/**
 * Collect only the non-product alert sources. Product engagement is composed
 * separately by proactiveAlerts.js and by the Review Queue product producer.
 */
export async function generateNonProductAlerts() {
  const [goalAlerts, successAlerts, systemAlerts, learningAlerts, usageAlerts, tribeAlerts, unansweredAlerts] = await Promise.all([
    checkGoalStalls(),
    checkSuccessRates(),
    checkSystemHealth(),
    checkLearningHealth(),
    checkUsageSpikes(),
    checkTribeCadence(),
    checkUnansweredTribeThreads(),
  ]);
  return [
    ...goalAlerts,
    ...successAlerts,
    ...systemAlerts,
    ...learningAlerts,
    ...usageAlerts,
    ...tribeAlerts,
    ...unansweredAlerts,
  ];
}
