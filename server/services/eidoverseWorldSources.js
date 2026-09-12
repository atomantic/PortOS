/**
 * Privacy-safe PortOS source adapters for Eidoverse World Design.
 *
 * This boundary reads local product state and emits only bounded, generic
 * aggregates. Raw record titles, machine/network identity, personal health
 * readings, prompts, journals, and transcripts never leave this module.
 */

import { statfs } from 'node:fs/promises';
import { parseFilesystemStats } from '../lib/fileCore.js';
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
import { getDataIntrospection } from './dataIntrospection.js';
import { fetchMyCurrentSprintTickets } from './jira.js';

import { buildEidoverseWorldSignals, projectedJiraTickets } from '../lib/eidoverseWorldSignals.js';

// Preserve the historical collector import paths.
export { eidoversePeerId, eidoverseHostId, projectedStorage, projectedJiraTickets } from '../lib/eidoverseWorldSignals.js';

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

async function getDiskUsagePercent() {
  const stats = await statfs('/').catch(() => null);
  return parseFilesystemStats(stats)?.usagePercent ?? null;
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
    getDataIntrospection().catch(() => null),
  ]), signal);
  const [apps, appConfig, agents, taskState, cosStatus, review, featuresState, peers, backupState, notifications, character, voiceConfig, memory, diskPercent, todayActivity, velocity, activityCalendar, goalsData, memoryGraph, inboxCounts, introspection] = reads;

  const travel = await import('./eidoverseTravel.js').then((service) => service.listEidoverseDestinations()).catch(() => ({ destinations: [] }));
  const destinations = new Set(travel.destinations.map((entry) => entry.peerId));
  const jira = await waitWithSignal(projectedJira(appConfig, featuresState), signal);

  return buildEidoverseWorldSignals({
    apps, agents, taskState, cosStatus, review, featuresState, peers,
    backupState, notifications, character, voiceConfig, memory, diskPercent,
    todayActivity, velocity, activityCalendar, goalsData, memoryGraph,
    inboxCounts, introspection, jira, destinations,
  });
}
