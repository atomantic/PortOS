import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import * as backoff from './taskScheduleBackoff.js';
import * as constants from './taskScheduleConstants.js';
import * as registry from './taskScheduleRegistry.js';
import * as schedule from './taskSchedule.js';
import * as templates from './taskScheduleTemplates.js';

const source = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

describe('taskSchedule module boundaries', () => {
  it('keeps the legacy taskSchedule exports wired to the extracted modules', () => {
    const exportsByModule = Object.fromEntries([
      ...['INTERVAL_TYPES', 'ON_DEMAND_ORIGINS', 'isRefillRequest']
        .map((name) => [name, constants[name]]),
      ...['DEFAULT_BRANCHES_PER_AGENT', 'DEFAULT_TASK_INTERVALS', 'MANAGED_AGENT_OPTIONS',
        'PERPETUAL_DRAIN_DISPATCH_CAP', 'SELF_IMPROVEMENT_TASK_TYPES', 'TASK_TYPE_DESCRIPTIONS',
        'TASK_TYPE_INVOCATION', 'TASK_TYPE_PROMPT_INFO', 'getTaskTypeInvocation', 'getTaskTypePromptInfo',
        'stripManagedAgentOptionsFromOverride'].map((name) => [name, registry[name]]),
      ...['FAILURE_BACKOFF_BASE_MS', 'FAILURE_BACKOFF_CAP_MS', 'FAILURE_PARK_THRESHOLD',
        'clearTaskTypeFailurePark', 'computeFailureBackoffMs', 'recordTaskTypeFailure',
        'recordTaskTypeSuccess'].map((name) => [name, backoff[name]]),
      ...['addTemplateTask', 'deleteTemplateTask', 'getTemplateTasks']
        .map((name) => [name, templates[name]])
    ]);

    for (const [name, value] of Object.entries(exportsByModule)) {
      expect(schedule[name], name).toBe(value);
    }
  });

  it('keeps the static task registry independent from apps and schedule runtime state', () => {
    const registrySource = source('./taskScheduleRegistry.js');
    expect(registrySource).not.toContain("from './apps.js'");
    expect(registrySource).not.toContain("from './taskSchedule.js'");

    const appsSource = source('./apps.js');
    expect(appsSource).toContain("from './taskScheduleRegistry.js'");
    expect(appsSource).not.toContain("from './taskSchedule.js'");
  });

  it('keeps prompt-version migration data in the persisted store seam', () => {
    const storeSource = source('./taskScheduleStore.js');
    expect(storeSource).toContain('PROMPT_VERSIONS');
    expect(storeSource).toContain('PREVIOUS_DEFAULT_PROMPTS');
    expect(storeSource).toContain('promptMatchesShippedDefault');
  });
});
