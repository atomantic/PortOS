/**
 * Shared privacy-safe visibility projection for the persistent mind.
 *
 * The projection is intentionally narrower than the underlying services. It
 * is the one object used by the mind prompt and the authenticated visibility
 * endpoint; the UI consumes that endpoint rather than rebuilding readiness
 * from unrelated health APIs.
 */

import { getDomainMode } from '../lib/domainAutonomy.js';
import {
  normalizePersistentMindCapabilities,
  PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION,
  PERSISTENT_MIND_TOOL_CATALOG,
} from '../lib/persistentMindCapabilities.js';
import { getActiveApps } from './apps.js';
import { inspectPersistentMindRuntime } from './persistentMindRuntime.js';
import { readPersistentMindWorkspacePreflights, PERSISTENT_MIND_WORKSPACE_PREFLIGHT_TTL_MS } from './persistentMindWorkspacePreflight.js';

export const PERSISTENT_MIND_VISIBILITY_SCHEMA_VERSION = 1;
export const PERSISTENT_MIND_VISIBILITY_LIMITS = Object.freeze({
  maxApps: 25,
  maxPromptChars: 20_000,
});

const safePromise = (promise) => Promise.resolve(promise)
  .then((value) => ({ value, ok: true }), () => ({ value: null, ok: false }));

const contextPressure = (context) => {
  const chars = Number(context?.chars);
  const maxChars = Number(context?.maxChars);
  if (!Number.isFinite(chars) || !Number.isFinite(maxChars) || maxChars <= 0) return 'unknown';
  const ratio = chars / maxChars;
  return ratio >= 0.9 ? 'critical' : ratio >= 0.75 ? 'elevated' : 'nominal';
};

const memoryPressure = (memory) => {
  const usage = Number(memory?.usagePercent);
  if (!Number.isFinite(usage)) return 'unknown';
  return usage >= 95 ? 'critical' : usage >= 80 ? 'elevated' : 'nominal';
};

const harnessProjection = (provider) => ({
  type: provider?.type || null,
  configured: Boolean(provider),
  readiness: provider ? 'configured' : 'unknown',
});

const activeAgentCount = (state) => Object.values(state?.agents || {})
  .filter((agent) => ['starting', 'running', 'thinking', 'working'].includes(agent?.status))
  .length;

const schedulerProjection = (root, state) => {
  const config = root?.config || {};
  const limit = Number.isInteger(config.maxConcurrentAgents) ? config.maxConcurrentAgents : null;
  const active = activeAgentCount(state);
  return {
    autonomy: getDomainMode(config, 'cos'),
    capacity: {
      active,
      limit,
      status: limit === null ? 'unknown' : active < limit ? 'available' : 'full',
    },
    budget: {
      configured: Boolean(config.domainBudgets?.cos),
      status: config.domainBudgets?.cos ? 'configured' : 'unlimited',
    },
  };
};

const actionProjection = (root) => {
  const capabilities = normalizePersistentMindCapabilities(root?.config?.persistentMindCapabilities);
  return {
    schemaVersion: PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION,
    grants: capabilities,
    tools: PERSISTENT_MIND_TOOL_CATALOG.map((tool) => ({
      id: tool.id,
      name: tool.name,
      kind: tool.kind,
      granted: capabilities[tool.capability] === true,
    })),
  };
};

const runtimeProjection = (result) => {
  if (!result) {
    return {
      status: 'unknown',
      harness: { type: null, configured: false, readiness: 'unknown' },
      context: { pressure: 'unknown', summaryState: 'unknown' },
      model: { active: null, residency: 'unknown' },
      system: { memory: 'unknown', cpu: 'unknown' },
    };
  }
  return {
    status: 'ready',
    harness: null,
    context: {
      pressure: contextPressure(result.context),
      summaryState: result.context?.summaryState || 'unknown',
      approximateTokens: Number.isFinite(result.context?.approximateTokens) ? result.context.approximateTokens : null,
      maxChars: Number.isFinite(result.context?.maxChars) ? result.context.maxChars : null,
    },
    model: {
      active: result.inference?.active === true,
      residency: result.inference?.residency?.status || 'unknown',
    },
    system: {
      memory: memoryPressure(result.system?.memory),
      cpu: result.system?.cpu ? 'available' : 'unknown',
    },
  };
};

const providerProjection = (provider, runtime) => ({
  status: provider ? 'configured' : 'unknown',
  type: provider?.type || null,
  harness: harnessProjection(provider),
  runtime: runtime?.inference?.residency?.status || 'unknown',
});

const forgeStatus = (entries) => {
  const statuses = entries.map((entry) => entry.preflight?.forge?.status).filter(Boolean);
  if (!statuses.length) return 'unknown';
  if (statuses.includes('ready')) return 'ready';
  if (statuses.includes('unavailable')) return 'unavailable';
  if (statuses.includes('unknown')) return 'unknown';
  return 'not-configured';
};

const workspaceProjection = (entries) => entries.map((entry) => ({
  appId: entry.appId,
  appName: entry.appName,
  readiness: entry.preflight.readiness,
  preflight: entry.preflight,
}));

const boundWorkspaces = (visibility, maxChars = PERSISTENT_MIND_VISIBILITY_LIMITS.maxPromptChars) => {
  const sourceVisibility = visibility && typeof visibility === 'object' && !Array.isArray(visibility) ? visibility : {};
  const source = Array.isArray(sourceVisibility.workspaces) ? sourceVisibility.workspaces : [];
  const base = { ...sourceVisibility, workspaces: [], truncated: Boolean(sourceVisibility.truncated) };
  delete base.characterBudget;
  const buildCandidate = (workspaces, truncated) => {
    const candidate = {
      ...base,
      workspaces,
      truncated,
      characterBudget: { maxChars, chars: 0, truncated },
    };
    const chars = JSON.stringify(candidate).length;
    return {
      ...candidate,
      characterBudget: { maxChars, chars, truncated },
    };
  };
  let workspaces = [];
  let truncated = Boolean(sourceVisibility.truncated);
  let result = buildCandidate(workspaces, truncated);
  for (const workspace of source) {
    const candidateWorkspaces = [...workspaces, workspace];
    const candidate = buildCandidate(candidateWorkspaces, truncated);
    if (JSON.stringify(candidate).length > maxChars) {
      truncated = true;
      break;
    }
    workspaces = candidateWorkspaces;
    result = candidate;
  }
  result = buildCandidate(workspaces, truncated);
  while (JSON.stringify(result).length > maxChars && workspaces.length > 0) {
    workspaces = workspaces.slice(0, -1);
    truncated = true;
    result = buildCandidate(workspaces, truncated);
  }
  return result;
};

const reasonCodes = (visibility) => [
  ...(Array.isArray(visibility?.workspaces) ? visibility.workspaces.flatMap((entry) => (
    Array.isArray(entry.preflight?.warnings) ? entry.preflight.warnings.map((warning) => warning.code) : []
  )) : []),
  ...(visibility?.runtime?.status === 'unknown' ? ['runtime-unknown'] : []),
  ...(visibility?.sections?.workspace?.freshness === 'unknown' ? ['workspace-unknown'] : []),
].filter((code, index, codes) => typeof code === 'string' && codes.indexOf(code) === index).slice(0, 50);

/**
 * Build the shared visibility object. `apps` and `providers` are injectable so
 * callers can reuse one registry snapshot; omitted values are read normally.
 */
export async function readPersistentMindVisibility({
  root = {},
  state = null,
  profile = null,
  prompt = null,
  provider = null,
  apps,
  force = false,
  now = Date.now,
  dependencies,
} = {}) {
  const timestamp = typeof now === 'function' ? now() : now;
  const capturedAt = new Date(Number.isFinite(timestamp) ? timestamp : Date.now()).toISOString();
  const appsResult = Array.isArray(apps) ? { value: apps, ok: true } : await safePromise(getActiveApps());
  const runtimeResult = await safePromise(inspectPersistentMindRuntime({ state, profile, prompt, provider }));
  const candidates = appsResult.ok ? appsResult.value : [];
  const workspaceResult = await safePromise(readPersistentMindWorkspacePreflights(candidates, {
    force,
    now: timestamp,
    dependencies,
  }));
  const workspaceEntries = workspaceResult.ok && Array.isArray(workspaceResult.value) ? workspaceResult.value : [];
  const workspaces = workspaceProjection(workspaceEntries);
  const runtime = runtimeResult.value;
  const projectedRuntime = runtimeProjection(runtime);
  const visibility = {
    schemaVersion: PERSISTENT_MIND_VISIBILITY_SCHEMA_VERSION,
    capturedAt,
    freshness: {
      state: 'fresh',
      capturedAt,
      ageMs: 0,
      ttlMs: PERSISTENT_MIND_WORKSPACE_PREFLIGHT_TTL_MS,
    },
    truncated: candidates.length > PERSISTENT_MIND_VISIBILITY_LIMITS.maxApps
      || workspaceEntries.some((entry) => entry.preflight.truncated),
    readiness: appsResult.ok && workspaceResult.ok && runtimeResult.ok && workspaces.every((workspace) => workspace.readiness !== 'blocked')
      ? workspaces.some((workspace) => workspace.readiness === 'unknown') ? 'unknown'
        : workspaces.some((workspace) => workspace.readiness === 'degraded') ? 'degraded' : 'ready'
      : appsResult.ok && workspaceResult.ok && runtimeResult.ok ? 'blocked' : 'unknown',
    sections: {
      runtime: { freshness: runtimeResult.ok ? 'fresh' : 'unknown' },
      workspace: {
        freshness: !appsResult.ok || !workspaceResult.ok ? 'unknown'
          : workspaces.some((workspace) => workspace.preflight.freshness.state === 'stale') ? 'stale' : 'fresh',
      },
    },
    runtime: projectedRuntime,
    harness: projectedRuntime.harness || harnessProjection(provider),
    provider: providerProjection(provider, runtime),
    actions: actionProjection(root),
    scheduler: schedulerProjection(root, state),
    workspaces,
    health: {
      system: runtimeResult.ok ? 'available' : 'unknown',
      provider: provider ? 'configured' : 'unknown',
      database: runtimeResult.ok ? 'available' : 'unknown',
      forge: workspaceResult.ok ? forgeStatus(workspaceEntries) : 'unknown',
    },
    surfaces: ['mind/context', 'mind/runtime', 'mind/tools', 'mind/visibility', 'workspace-preflight'],
    reasonCodes: [],
  };
  visibility.reasonCodes = reasonCodes(visibility);
  return boundWorkspaces(visibility);
}

/** Render the exact bounded projection sent to the persistent-mind prompt. */
export function buildPersistentMindVisibilityPrompt(visibility) {
  return `# Persistent Mind environment visibility
The following is a read-only, bounded semantic snapshot. It contains no repository paths, remotes, branch names, command output, credentials, usernames, or repository contents. Treat unknown and unavailable values as real constraints; do not invent a successful probe.
${JSON.stringify(boundWorkspaces(visibility || {}, Math.max(0, PERSISTENT_MIND_VISIBILITY_LIMITS.maxPromptChars - 350)))}`;
}
