/** Upgrade stored audit schedules and app overrides to the consolidated task IDs. */

import { isDeepStrictEqual } from 'node:util';
import { auditDomainFor } from './auditDomains.js';
import { isPlainObject } from './objects.js';

const ORDER_FIELDS = ['runAfter', 'suggestedAfter'];
const PROMPT_FIELDS = ['prompt', 'promptVersion', 'promptCustomized', 'promptSource'];

// Frozen defaults from the last release with independently scheduled profiles.
// A fully materialized default row is not evidence the user configured a lane.
const DEFAULT_FIX_PROFILES = new Set(['code-quality', 'performance', 'documentation', 'ui-bugs', 'mobile-responsive', 'error-handling', 'typing', 'console-errors']);
const PRELOADED_PR_PROFILES = new Set([
  'app-bugs', 'module-hygiene', 'better-complexity', 'better-cognitive-load', 'better-structural-drift',
  'better-runtime-safety', 'better-test-quality', 'better-dev-environment', 'infrastructure', 'data-integrity',
  'reliability', 'cost-efficiency', 'workflow-recovery', 'upgrade-rehearsal',
]);

function scheduleCustomizations(config, id, domain, matchesShippedPrompt) {
  const fileIssues = !DEFAULT_FIX_PROFILES.has(id);
  const preloadsPRs = id === domain || PRELOADED_PR_PROFILES.has(id);
  const defaults = {
    type: 'on-demand', enabled: true, perpetual: false, weekdaysOnly: false,
    providerId: null, model: null, cronExpression: null,
    dataInputs: ['open-issues', ...(preloadsPRs ? ['open-pull-requests'] : []), 'audit-slice-history', 'lane-health'],
  };
  const metadataDefaults = { fileIssues, useWorktree: false, openPR: false, readOnly: false };
  const fields = Object.fromEntries(Object.entries(config).filter(([key, value]) =>
    key !== 'createdAt' && key !== 'taskMetadata' && !PROMPT_FIELDS.includes(key)
    && !isDeepStrictEqual(value, defaults[key])));
  if (config.taskMetadata === null) fields.taskMetadata = null;
  if (isPlainObject(config.taskMetadata)) {
    const edited = Object.fromEntries(Object.entries(config.taskMetadata).filter(([key, value]) =>
      !isDeepStrictEqual(value, metadataDefaults[key])));
    if (Object.keys(edited).length) fields.taskMetadata = edited;
  }
  if (config.prompt && (config.promptSource === 'user' || !matchesShippedPrompt(config.prompt, domain))) {
    Object.assign(fields, { prompt: config.prompt, promptCustomized: true, promptSource: config.promptSource || 'legacy-inferred' });
    if (config.promptVersion !== undefined) fields.promptVersion = config.promptVersion;
  }
  return fields;
}

const overrideCustomizations = config => isDeepStrictEqual(config, { enabled: false }) ? {} : config;

function foldConfigs(owner, key, customizations) {
  const configs = owner[key];
  if (!isPlainObject(configs)) return false;

  const folded = new Map();
  for (const [id, config] of Object.entries(configs)) {
    const domain = auditDomainFor(id);
    if (domain === id) continue;
    if (!folded.has(domain)) folded.set(domain, []);
    if (isPlainObject(config)) folded.get(domain).push([id, config, customizations(config, id, domain)]);
    delete configs[id];
  }

  for (const [domain, aliases] of folded) {
    const current = configs[domain];
    const edited = aliases.filter(([, , fields]) => Object.keys(fields).length);
    const currentEdited = isPlainObject(current) && Object.keys(customizations(current, domain, domain)).length > 0;
    const selected = currentEdited ? null : edited[0];
    if (selected) {
      const [, original, fields] = selected;
      configs[domain] = { ...current, ...fields };
      if (original.createdAt) configs[domain].createdAt = original.createdAt;
    } else if (!current && key === 'taskTypeOverrides' && aliases.length) {
      // Preserve an explicit legacy disable even when the destination has no entry.
      configs[domain] = aliases[0][1];
    }
    for (const [id, original, fields] of edited) {
      if (id === selected?.[0] || (selected && isDeepStrictEqual(fields, selected[2]))) continue;
      // One domain has one cadence and one prompt. Preserve conflicting edits
      // verbatim for recovery without running a second schedule.
      owner.retiredAuditConfigs ??= {};
      owner.retiredAuditConfigs[id] = original;
    }
  }
  return folded.size > 0;
}

export function foldAppAuditOverrides(app) {
  if (!isPlainObject(app)) return false;
  let changed = foldConfigs(app, 'taskTypeOverrides', overrideCustomizations);
  if (Array.isArray(app.disabledTaskTypes)) {
    const types = [...new Set(app.disabledTaskTypes.map(auditDomainFor))];
    if (!isDeepStrictEqual(types, app.disabledTaskTypes)) {
      app.disabledTaskTypes = types;
      changed = true;
    }
  }
  return changed;
}

function mergeExecutions(legacy, current = {}) {
  const newest = Date.parse(legacy.lastRun) > (Date.parse(current.lastRun) || 0) ? legacy : current;
  const merged = { ...legacy, ...current, ...newest, count: (legacy.count || 0) + (current.count || 0) };
  if (legacy.perApp || current.perApp) {
    merged.perApp = { ...legacy.perApp, ...current.perApp };
    for (const [id, execution] of Object.entries(legacy.perApp || {})) {
      if (current.perApp?.[id]) merged.perApp[id] = mergeExecutions(execution, current.perApp[id]);
    }
  }
  return merged;
}

export function foldAuditSchedule(schedule, matchesShippedPrompt) {
  if (!isPlainObject(schedule)) return false;
  const customizations = (config, id, domain) => scheduleCustomizations(config, id, domain, matchesShippedPrompt);
  let changed = false;
  for (const key of ['tasks', 'selfImprovement', 'appImprovement']) {
    if (foldConfigs(schedule, key, customizations)) changed = true;
    for (const [id, config] of Object.entries(schedule[key] || {})) {
      for (const field of ORDER_FIELDS) {
        if (!Array.isArray(config?.[field])) continue;
        const types = [...new Set(config[field].map(auditDomainFor))].filter(type => type !== id);
        if (isDeepStrictEqual(types, config[field])) continue;
        config[field] = types;
        changed = true;
      }
    }
  }
  const pending = Array.isArray(schedule.onDemandRequests) ? schedule.onDemandRequests : [];
  for (const request of [...pending, ...Object.values(schedule.swarmCleanupRefillPending || {})]) {
    const domain = auditDomainFor(request?.taskType);
    if (domain === request?.taskType) continue;
    request.taskType = domain;
    changed = true;
  }
  for (const [key, record] of Object.entries(schedule.executions || {})) {
    const match = /^(task|self-improve|app-improve):(.+)$/.exec(key);
    if (!match || !isPlainObject(record)) continue;
    const [, prefix, id] = match;
    const domain = auditDomainFor(id);
    if (domain === id) continue;
    const destination = `${prefix}:${domain}`;
    const current = schedule.executions[destination];
    schedule.executions[destination] = isPlainObject(current) ? mergeExecutions(record, current) : record;
    delete schedule.executions[key];
    changed = true;
  }
  return changed;
}
