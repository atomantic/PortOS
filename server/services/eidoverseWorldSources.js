/**
 * Privacy-safe PortOS source adapters for Eidoverse World Design.
 *
 * This boundary reads local product state and emits only bounded, generic
 * aggregates. Raw record titles, machine/network identity, personal health
 * readings, prompts, journals, and transcripts never leave this module.
 */

import { createHash } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { getAllApps, getAppStatuses } from './apps.js';
import { getStatus as getCosStatus, getAgents, getCosTasks, getTodayActivity } from './cos.js';
import { getPendingCounts } from './review.js';
import { getPeers } from './instances.js';
import { getInstanceFeatures } from './instanceFeatures.js';
import * as backup from './backup.js';
import { getCountsByType } from './notifications.js';
import { getCharacter } from './character.js';
import { getVoiceConfig } from './voice/config.js';
import { getMemoryStats } from '../lib/memoryStats.js';
import { getGoals } from './identity.js';
import { getActivityCalendar, getVelocityMetrics } from './productivity.js';
import { getBrainGraphOverview } from './brainGraph.js';
import { getInboxLogCounts } from './brainStorage.js';
import { getOpenWorldIntrospection } from './openWorldIntrospection.js';
import { fetchMyCurrentSprintTickets } from './jira.js';

const safeText = (value, fallback = '', max = 160) => {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean ? clean.slice(0, max) : fallback;
};

const opaqueId = (namespace, value, fallback) => {
  const source = safeText(value, fallback, 256);
  return `${namespace}-${createHash('sha256').update(`${namespace}:${source}`).digest('hex').slice(0, 12)}`;
};

const coarseStatus = (value) => {
  const status = String(value || '').toLowerCase();
  if (/error|failed|unhealthy|offline|crash|blocked/.test(status)) return 'error';
  if (/paused|stopped|pending|unknown|not.started|todo|to do/.test(status)) return 'attention';
  if (/active|running|online|healthy|success|progress/.test(status)) return 'active';
  return 'steady';
};

const abortError = (signal) => signal?.reason instanceof Error
  ? signal.reason
  : new DOMException(String(signal?.reason || 'The Eidoverse source read was canceled.'), 'AbortError');

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

const finiteOrNull = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const nonNegativeOrNull = (value) => {
  const number = finiteOrNull(value);
  return number === null ? null : Math.max(0, number);
};
const percentageOrNull = (value) => {
  const number = finiteOrNull(value);
  return number === null ? null : Math.max(0, Math.min(100, number));
};

async function getDiskUsagePercent() {
  const stats = await statfs('/').catch(() => null);
  if (!stats) return null;
  const total = stats.blocks * stats.bsize;
  if (!(total > 0)) return null;
  return Math.round(((total - stats.bavail * stats.bsize) / total) * 100);
}

function appSummary(apps) {
  if (!Array.isArray(apps)) return null;
  return {
    total: apps.length,
    online: apps.filter((app) => app.overallStatus === 'online').length,
    stopped: apps.filter((app) => app.overallStatus === 'stopped').length,
    notStarted: apps.filter((app) => app.overallStatus === 'not_started').length,
    unknown: apps.filter((app) => app.overallStatus === 'unknown').length,
  };
}

function projectedApps(apps) {
  if (!Array.isArray(apps)) return null;
  const groups = new Map();
  for (const app of apps) {
    const status = coarseStatus(app?.overallStatus);
    const group = groups.get(status) || { count: 0, managed: 0 };
    group.count += 1;
    if (app?.managed === true) group.managed += 1;
    groups.set(status, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, group]) => ({
      id: `apps-${status}`,
      label: 'Managed app group',
      status,
      count: group.count,
      managed: group.managed,
    }));
}

function projectedProductivity(todayActivity, velocity, taskState) {
  if (!todayActivity && !velocity) return null;
  const stats = todayActivity?.stats || {};
  const queue = {
    pendingApprovals: Array.isArray(taskState?.awaitingApproval) ? taskState.awaitingApproval.length : null,
    pendingTasks: Array.isArray(taskState?.tasks)
      ? taskState.tasks.filter((task) => !['completed', 'done', 'archived'].includes(String(task?.status || '').toLowerCase())).length
      : null,
  };
  queue.total = [queue.pendingApprovals, queue.pendingTasks].every((value) => value !== null)
    ? queue.pendingApprovals + queue.pendingTasks
    : null;
  return [{
    id: 'summary',
    label: 'Productivity',
    completedToday: nonNegativeOrNull(stats.completed ?? velocity?.today),
    succeededToday: nonNegativeOrNull(stats.succeeded ?? velocity?.todaySuccesses),
    failedToday: nonNegativeOrNull(stats.failed ?? velocity?.todayFailures),
    successRate: percentageOrNull(stats.successRate),
    velocity: finiteOrNull(velocity?.velocity),
    averagePerDay: nonNegativeOrNull(velocity?.avgPerDay),
    historicalDays: nonNegativeOrNull(velocity?.historicalDays),
    queue,
    running: todayActivity?.isRunning === true,
    paused: todayActivity?.isPaused === true,
  }];
}

function projectedActivity(calendar) {
  if (!calendar || !Array.isArray(calendar.weeks)) return null;
  if (calendar.weeks.length === 0) return [];
  const days = calendar.weeks
    .flatMap((week) => Array.isArray(week) ? week : [])
    .filter((day) => day && typeof day === 'object' && day.isFuture !== true);
  const today = days.find((day) => day.isToday === true);
  const activeDays = days
    .filter((day) => (nonNegativeOrNull(day.tasks) || 0) > 0)
    .slice(-99)
    .reverse();
  const summary = calendar.summary || {};
  return [
    {
      id: 'summary',
      label: 'Activity calendar',
      weeks: calendar.weeks.length,
      activeDays: nonNegativeOrNull(summary.activeDays),
      totalTasks: nonNegativeOrNull(summary.totalTasks),
      totalSuccesses: nonNegativeOrNull(summary.totalSuccesses),
      successRate: percentageOrNull(summary.successRate),
      maxTasks: nonNegativeOrNull(calendar.maxTasks),
      todayTasks: nonNegativeOrNull(today?.tasks),
    },
    ...activeDays.map((day, index) => ({
      id: opaqueId('activity-day', day.date, `day-${index}`),
      label: 'Activity day',
      tasks: nonNegativeOrNull(day.tasks) ?? 0,
      successes: nonNegativeOrNull(day.successes) ?? 0,
      failures: nonNegativeOrNull(day.failures) ?? 0,
      successRate: percentageOrNull(day.successRate),
      isToday: day.isToday === true,
    })),
  ];
}

function projectedGoals(goalsData) {
  if (!Array.isArray(goalsData?.goals)) return null;
  const goals = goalsData.goals;
  const children = new Map(goals.map((goal) => [goal?.id, 0]));
  goals.forEach((goal) => {
    if (goal?.parentId && children.has(goal.parentId)) children.set(goal.parentId, children.get(goal.parentId) + 1);
  });
  return goals.map((goal, index) => {
    const milestones = Array.isArray(goal?.milestones) ? goal.milestones : [];
    const todos = Array.isArray(goal?.todos) ? goal.todos : [];
    return {
      id: opaqueId('goal', goal?.id, `goal-${index}`),
      label: 'Active goal',
      status: coarseStatus(goal?.status || 'active'),
      progress: percentageOrNull(goal?.progress) ?? 0,
      milestoneTotal: milestones.length,
      milestoneDone: milestones.filter((milestone) => milestone?.completed === true || Boolean(safeText(milestone?.completedAt, ''))).length,
      todoTotal: todos.length,
      todoPending: todos.filter((todo) => !['completed', 'done'].includes(String(todo?.status || '').toLowerCase()) && todo?.completed !== true).length,
      childCount: children.get(goal?.id) || 0,
    };
  });
}

function projectedMemory(graph) {
  if (!graph || !Array.isArray(graph.nodes)) return null;
  const buckets = new Map();
  const categoryById = new Map();
  for (const node of graph.nodes) {
    const category = safeText(node?.category || node?.brainType, 'other').toLowerCase() || 'other';
    categoryById.set(node?.id, category);
    const bucket = buckets.get(category) || { count: 0, importance: 0 };
    bucket.count += 1;
    bucket.importance += Math.max(0, finiteOrNull(node?.importance) ?? 1);
    buckets.set(category, bucket);
  }
  const bridgeCounts = new Map();
  for (const edge of Array.isArray(graph.edges) ? graph.edges : []) {
    const from = categoryById.get(edge?.source);
    const to = categoryById.get(edge?.target);
    if (!from || !to || from === to) continue;
    bridgeCounts.set(from, (bridgeCounts.get(from) || 0) + 1);
    bridgeCounts.set(to, (bridgeCounts.get(to) || 0) + 1);
  }
  return [...buckets.entries()]
    .sort(([a, left], [b, right]) => right.count - left.count || a.localeCompare(b))
    .map(([category, bucket]) => ({
      id: opaqueId('memory-category', category, 'other'),
      label: 'Memory category',
      count: bucket.count,
      importance: bucket.importance,
      bridgeCount: bridgeCounts.get(category) || 0,
      totalMemories: graph.nodes.length,
      totalEdges: Array.isArray(graph.edges) ? graph.edges.length : 0,
      hasEmbeddings: graph.hasEmbeddings === true,
    }));
}

export function projectedStorage(introspection) {
  if (!introspection || typeof introspection !== 'object') return null;
  const items = [];
  const db = introspection.db;
  const fsSection = introspection.fs;
  const dbOnline = Array.isArray(db?.tables);
  items.push({
    id: 'database',
    label: 'PostgreSQL',
    area: 'database',
    status: db === null ? 'offline' : (dbOnline ? 'online' : 'unknown'),
    tableCount: dbOnline ? db.tables.length : null,
    sizeBytes: finiteOrNull(db?.sizeBytes),
    migrations: db?.migrations?.applied === undefined ? null : nonNegativeOrNull(db.migrations.applied),
  });
  const fsOnline = Array.isArray(fsSection?.domains);
  items.push({
    id: 'filesystem',
    label: 'PortOS data files',
    area: 'filesystem',
    status: fsSection === null ? 'offline' : (fsOnline ? 'online' : 'unknown'),
    domainCount: fsOnline ? fsSection.domains.length : null,
    sizeBytes: finiteOrNull(fsSection?.totalBytes),
    fileCount: nonNegativeOrNull(fsSection?.totalFiles),
  });
  if (!dbOnline) items.push({ id: 'database-attention', label: 'Data attention', area: 'anomaly', status: db === null ? 'offline' : 'unknown', count: 1 });
  if (!fsOnline) items.push({ id: 'filesystem-attention', label: 'Data attention', area: 'anomaly', status: fsSection === null ? 'offline' : 'unknown', count: 1 });
  return items;
}

function projectedOperations({ cosStatus, review, backupState, notifications, character, voiceConfig, memory, diskPercent, inboxCounts }) {
  const values = [cosStatus, review, backupState, notifications, character, voiceConfig, memory, diskPercent, inboxCounts];
  if (!values.some((value) => value !== null && value !== undefined)) return null;
  const status = /failed|error|unhealthy/i.test(String(backupState?.status || ''))
    ? 'error'
    : ((review?.alert || 0) > 0 || cosStatus?.paused === true ? 'attention' : (cosStatus?.running ? 'active' : 'steady'));
  return [{
    id: 'overview',
    label: 'PortOS operations',
    status,
    cos: cosStatus ? {
      running: cosStatus.running === true,
      paused: cosStatus.paused === true,
      activeAgents: nonNegativeOrNull(cosStatus.activeAgents),
      pausedAgents: nonNegativeOrNull(cosStatus.pausedAgents),
    } : null,
    ai: cosStatus ? {
      running: cosStatus.running === true,
      activeAgents: nonNegativeOrNull(cosStatus.activeAgents),
    } : null,
    review: review ? {
      total: nonNegativeOrNull(review.total),
      cos: nonNegativeOrNull(review.cos),
      alerts: nonNegativeOrNull(review.alert),
    } : null,
    backup: backupState ? {
      status: coarseStatus(backupState.status),
      filesChanged: nonNegativeOrNull(backupState.filesChanged),
    } : null,
    notifications: notifications ? {
      total: nonNegativeOrNull(notifications.total),
      unread: nonNegativeOrNull(notifications.unread),
    } : null,
    inbox: inboxCounts ? {
      total: nonNegativeOrNull(inboxCounts.total),
      needsReview: nonNegativeOrNull(inboxCounts.needs_review),
      classifying: nonNegativeOrNull(inboxCounts.classifying),
    } : null,
    character: character ? { level: nonNegativeOrNull(character.level) } : null,
    voice: voiceConfig ? {
      enabled: voiceConfig.enabled === true,
    } : null,
    memory: memory ? {
      usedPercent: memory.total > 0 ? Math.round((memory.used / memory.total) * 100) : null,
    } : null,
    diskPercent: percentageOrNull(diskPercent),
  }];
}

async function projectedJira(appConfig, featuresState) {
  if (!Array.isArray(featuresState?.features)) return null;
  const jiraFeature = featuresState.features.find((feature) => feature?.id === 'jira');
  if (!jiraFeature) return null;
  if (jiraFeature.enabled !== true) return [];
  if (!Array.isArray(appConfig)) return null;
  const specs = [...new Map(appConfig
    .filter((app) => app?.jira?.enabled && app.jira.instanceId && app.jira.projectKey)
    .map((app) => [`${app.jira.instanceId}/${app.jira.projectKey}`, {
      instanceId: app.jira.instanceId,
      projectKey: app.jira.projectKey,
    }]))
    .values()];
  if (specs.length === 0) return [];
  const batches = await Promise.all(specs.map((spec) => fetchMyCurrentSprintTickets(spec.instanceId, spec.projectKey)
    .then((tickets) => Array.isArray(tickets) ? { tickets, failed: false } : { tickets: [], failed: true })
    .catch(() => ({ tickets: [], failed: true }))));
  if (batches.some((batch) => batch.failed)) return null;
  return projectedJiraTickets(batches.flatMap((batch) => batch.tickets));
}

export function projectedJiraTickets(tickets) {
  const groups = new Map();
  for (const ticket of Array.isArray(tickets) ? tickets : []) {
    const rawStatus = String(ticket?.statusCategory || ticket?.status || '').toLowerCase();
    if (/done|complete|closed/.test(rawStatus)) continue;
    const status = /progress|active|doing/.test(rawStatus) ? 'active' : (/block|error|fail/.test(rawStatus) ? 'blocked' : 'pending');
    const current = groups.get(status) || { count: 0, storyPoints: 0, urgent: 0 };
    current.count += 1;
    current.storyPoints += nonNegativeOrNull(ticket?.storyPoints) || 0;
    if (/highest|critical|urgent/i.test(String(ticket?.priority || ''))) current.urgent += 1;
    groups.set(status, current);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([status, values]) => ({
    id: `jira-${status}`,
    label: 'Current work summary',
    status,
    ...values,
  }));
}

function healthSnapshot({ apps, cosStatus, review, backupState, notifications, character, voiceConfig, memory, diskPercent }) {
  const health = {
    id: 'overview',
    label: 'PortOS health',
    apps: appSummary(apps),
    cos: cosStatus ? {
      running: cosStatus.running === true,
      activeAgents: nonNegativeOrNull(cosStatus.activeAgents),
      pausedAgents: nonNegativeOrNull(cosStatus.pausedAgents),
    } : null,
    review: review ? {
      total: nonNegativeOrNull(review.total),
      cos: nonNegativeOrNull(review.cos),
      alerts: nonNegativeOrNull(review.alert),
    } : null,
    backup: backupState ? {
      status: coarseStatus(backupState.status),
      filesChanged: nonNegativeOrNull(backupState.filesChanged),
    } : null,
    memory: memory ? {
      usedPercent: memory.total > 0 ? Math.round((memory.used / memory.total) * 100) : null,
    } : null,
    notifications: notifications ? {
      total: nonNegativeOrNull(notifications.total),
      unread: nonNegativeOrNull(notifications.unread),
    } : null,
    character: character ? { level: nonNegativeOrNull(character.level) } : null,
    voice: voiceConfig ? {
      enabled: voiceConfig.enabled === true,
    } : null,
    diskPercent: percentageOrNull(diskPercent),
  };
  const available = [apps, cosStatus, review, backupState, notifications, character, voiceConfig, memory, diskPercent]
    .some((value) => value !== null && value !== undefined);
  if (!available) return null;
  const hasError = /failed|error|unhealthy/i.test(String(health.backup?.status || ''))
    || (health.diskPercent ?? 0) >= 95
    || (health.memory?.usedPercent ?? 0) >= 95;
  const needsAttention = (health.apps?.stopped || 0) > 0
    || (health.apps?.unknown || 0) > 0
    || (health.review?.alerts || 0) > 0
    || cosStatus?.paused === true
    || (health.diskPercent ?? 0) >= 85
    || (health.memory?.usedPercent ?? 0) >= 85;
  health.status = hasError ? 'error' : (needsAttention ? 'attention' : 'healthy');
  return health;
}

export async function collectEidoverseWorldSources({ signal } = {}) {
  throwIfAborted(signal);
  const reads = await waitWithSignal(Promise.all([
    getAppStatuses().catch(() => null),
    getAllApps({ includeArchived: false }).catch(() => null),
    getAgents().catch(() => null),
    getCosTasks().catch(() => null),
    getCosStatus().catch(() => null),
    getPendingCounts().catch(() => null),
    getInstanceFeatures().catch(() => null),
    getPeers().catch(() => null),
    backup.getState().catch(() => null),
    getCountsByType().catch(() => null),
    getCharacter({ withSkills: false, withMetrics: false }).catch(() => null),
    getVoiceConfig().catch(() => null),
    getMemoryStats().catch(() => null),
    getDiskUsagePercent(),
    getTodayActivity().catch(() => null),
    getVelocityMetrics().catch(() => null),
    getActivityCalendar(12).catch(() => null),
    getGoals().catch(() => null),
    getBrainGraphOverview({ limit: 100 }).catch(() => null),
    getInboxLogCounts().catch(() => null),
    getOpenWorldIntrospection().catch(() => null),
  ]), signal);
  const [apps, appConfig, agents, taskState, cosStatus, review, featuresState, peers, backupState, notifications, character, voiceConfig, memory, diskPercent, todayActivity, velocity, activityCalendar, goalsData, memoryGraph, inboxCounts, introspection] = reads;

  const projectedAgents = Array.isArray(agents)
    ? agents.filter((agent) => ['running', 'paused'].includes(agent?.status)).map((agent, index) => ({
      id: opaqueId('agent', agent.id, `agent-${index}`), label: 'Active agent', status: coarseStatus(agent.status),
    }))
    : null;
  const projectedTasks = Array.isArray(taskState?.tasks)
    ? taskState.tasks
      .filter((task) => !['completed', 'done', 'archived'].includes(String(task?.status || '').toLowerCase()))
      .map((task, index) => ({
        id: opaqueId('task', task.id, `task-${index}`), label: 'Active task', status: coarseStatus(task.status || 'pending'),
      }))
    : null;
  const projectedFeatures = Array.isArray(featuresState?.features)
    ? featuresState.features.map((feature) => ({
      id: safeText(feature.id, 'feature'), label: 'District feature', enabled: feature.enabled === true,
    }))
    : null;
  const projectedPeers = Array.isArray(peers)
    ? peers.map((peer, index) => ({
      id: opaqueId('peer', peer.instanceId || peer.id, `peer-${index}`),
      label: 'Federated peer',
      enabled: peer.enabled !== false,
      fullSync: peer.fullSync === true,
      status: coarseStatus(peer.status),
    }))
    : null;
  const health = healthSnapshot({ apps, cosStatus, review, backupState, notifications, character, voiceConfig, memory, diskPercent });
  const jira = await waitWithSignal(projectedJira(appConfig, featuresState), signal);

  return {
    apps: projectedApps(apps),
    agents: projectedAgents,
    tasks: projectedTasks,
    features: projectedFeatures,
    peers: projectedPeers,
    health,
    productivity: projectedProductivity(todayActivity, velocity, taskState),
    activity: projectedActivity(activityCalendar),
    goals: projectedGoals(goalsData),
    memory: projectedMemory(memoryGraph),
    storage: projectedStorage(introspection),
    jira,
    operations: projectedOperations({ cosStatus, review, backupState, notifications, character, voiceConfig, memory, diskPercent, inboxCounts }),
  };
}
