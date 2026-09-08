import { describe, it, expect } from 'vitest';
import {
  buildQuotaBurnTaskCatalog,
  effectiveQuotaBurnSettings,
  findTaskEntry,
  quotaBurnStepPayload,
  searchTaskCatalog,
  stepFromTaskEntry,
  taskEntryNeedsApp,
  taskRefKey,
  taskSourceHref,
} from './quotaBurnTasks';

const schedule = {
  tasks: {
    ux: {
      enabled: true,
      description: 'Audit the interface and file issues.',
      appOverrides: { app1: { enabled: true }, app2: { enabled: false } },
      providerId: 'claude-cli',
      model: 'sonnet',
      taskMetadata: { useWorktree: true },
      fileIssuesCapable: true,
      defaultFileIssues: true,
    },
    'repo-sync': { enabled: true, installWide: true, appOverrides: {} },
    'universe-bible-images': { enabled: true, programmatic: true, appOverrides: {}, taskMetadata: { scope: 'all' } },
    'model-comparison-refresh': { enabled: false, installWide: true, appOverrides: {} },
    'internal-only': { enabled: true, appOverrides: {}, invocation: { userInvokable: false } },
  },
};

const jobs = [
  { id: 'job-a', name: 'Nightly changelog', appId: 'app1', enabled: true, type: 'agent', providerId: 'codex-cli' },
  { id: 'job-shell', name: 'Disk sweep', appId: 'app1', enabled: true, type: 'shell' },
  { id: 'job-legacy', name: 'Legacy job', appId: null, enabled: false },
];

const apps = [{ id: 'app1', name: 'Example App' }, { id: 'app2', name: 'Second App' }];

const catalog = () => buildQuotaBurnTaskCatalog({ schedule, jobs, apps });

describe('buildQuotaBurnTaskCatalog', () => {
  it('groups PortOS scheduled tasks and app custom jobs from the SHARED catalogs', () => {
    const groups = catalog();
    expect(groups.map((group) => group.id)).toEqual(['PortOS scheduled tasks', 'App custom tasks']);
    expect(groups[0].entries.map((entry) => entry.taskType))
      .toEqual(['model-comparison-refresh', 'repo-sync', 'universe-bible-images', 'ux']);
    // A job written before `type` existed is an agent job, so it stays.
    expect(groups[1].entries.map((entry) => entry.jobId)).toEqual(['job-legacy', 'job-a']);
  });

  it('drops what a burn may NEVER invoke rather than offering it and refusing', () => {
    const keys = catalog().flatMap((group) => group.entries.map((entry) => entry.key));
    // Not user-invokable, and a shell job spends no provider quota at all —
    // mirrors `isBurnEligibleCustomJob` / the registry's `userInvokable`.
    expect(keys).not.toContain('builtin:internal-only');
    expect(keys).not.toContain('custom:job-shell');
  });

  it('keeps a merely-blocked entry, with the reason that says what to go and fix', () => {
    const byKey = Object.fromEntries(catalog().flatMap((group) => group.entries).map((entry) => [entry.key, entry]));
    expect(byKey['builtin:model-comparison-refresh'].blockedReason).toBe('disabled in Scheduled Tasks');
    expect(byKey['custom:job-legacy'].blockedReason).toBe('disabled in System Tasks');
    // `ux` targets one app, and only app1 has it enabled — app2's override is off.
    expect(byKey['builtin:ux'].appIds).toEqual(['app1']);
    expect(byKey['builtin:ux'].appNames).toEqual(['Example App']);
    expect(byKey['builtin:ux'].blockedReason).toBeNull();
  });

  it('offers a target only for a type that acts on ONE app', () => {
    const byKey = Object.fromEntries(catalog().flatMap((group) => group.entries).map((entry) => [entry.key, entry]));
    expect(taskEntryNeedsApp(byKey['builtin:ux'])).toBe(true);
    // The server's schema rejects an appId on either of these.
    expect(taskEntryNeedsApp(byKey['builtin:repo-sync'])).toBe(false);
    expect(taskEntryNeedsApp(byKey['builtin:universe-bible-images'])).toBe(false);
  });
});

describe('searchTaskCatalog', () => {
  it('matches the task, its description, and the apps it can target', () => {
    const byQuery = (query) => searchTaskCatalog(catalog(), query)
      .flatMap((group) => group.entries.map((entry) => entry.key));
    expect(byQuery('ux')).toEqual(['builtin:ux']);
    expect(byQuery('file issues')).toEqual(['builtin:ux']);
    // The app name is the obvious thing to type on an install with many apps.
    expect(byQuery('Example App')).toEqual(['builtin:ux', 'custom:job-a']);
  });

  it('drops a group that matched nothing rather than rendering an empty heading', () => {
    expect(searchTaskCatalog(catalog(), 'nightly').map((group) => group.id)).toEqual(['App custom tasks']);
    expect(searchTaskCatalog(catalog(), 'zzzz')).toEqual([]);
    expect(searchTaskCatalog(catalog(), '  ')).toHaveLength(2);
  });
});

describe('task reference keys', () => {
  it('renders a reference as the picker\'s select value, without the target', () => {
    expect(taskRefKey({ kind: 'builtin', taskType: 'ux', appId: 'app1' })).toBe('builtin:ux');
    expect(taskRefKey({ kind: 'custom', jobId: 'job-a' })).toBe('custom:job-a');
    // No reference at all is the empty value, so a legacy step's picker shows
    // its placeholder rather than latching onto whatever option came first.
    expect(taskRefKey(null)).toBe('');
    expect(taskRefKey({ kind: 'builtin' })).toBe('');
  });

  it('finds the entry a step points at, and reports a stale reference as missing', () => {
    expect(findTaskEntry(catalog(), { kind: 'builtin', taskType: 'ux' })?.label).toBe('ux');
    expect(findTaskEntry(catalog(), { kind: 'builtin', taskType: 'deleted-task' })).toBeNull();
  });
});

describe('stepFromTaskEntry', () => {
  const entryFor = (key) => catalog().flatMap((group) => group.entries).find((entry) => entry.key === key);

  it('targets an app-scoped type, defaulting to the first app that has it enabled', () => {
    expect(stepFromTaskEntry(entryFor('builtin:ux'), { id: 'step-1' })).toEqual({
      id: 'step-1',
      enabled: true,
      label: '',
      taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app1' },
      jobType: null,
      runOnce: false,
      overrides: { providerId: null, model: null, effort: null, params: {} },
    });
  });

  it('never puts an appId on a type the server would reject one for', () => {
    expect(stepFromTaskEntry(entryFor('builtin:repo-sync'), { id: 's', appId: 'app1' }).taskRef.appId).toBeNull();
    expect(stepFromTaskEntry(entryFor('builtin:universe-bible-images'), { id: 's', appId: 'app1' }).taskRef.appId).toBeNull();
  });

  it('stores no appId on a custom job — the job record owns its own scope', () => {
    expect(stepFromTaskEntry(entryFor('custom:job-a'), { id: 's' }).taskRef)
      .toEqual({ kind: 'custom', jobId: 'job-a' });
  });
});

describe('effectiveQuotaBurnSettings', () => {
  const saved = { providerId: 'claude-cli', model: 'sonnet', effort: 'medium', taskMetadata: { useWorktree: true, openPR: true } };

  it('inherits an unset override and lets a pin win', () => {
    const step = { overrides: { providerId: null, model: 'opus', effort: null, params: {} } };
    expect(effectiveQuotaBurnSettings(step, saved)).toEqual({
      providerId: 'claude-cli',
      model: 'opus',
      effort: 'medium',
      params: { useWorktree: true, openPR: true },
    });
  });

  it('merges run params key-by-key instead of replacing the saved bag', () => {
    // Overriding one parameter must not blank every other one the task saved.
    const step = { overrides: { params: { openPR: false } } };
    expect(effectiveQuotaBurnSettings(step, saved).params).toEqual({ useWorktree: true, openPR: false });
  });

  it('reads a step with no reference resolved as pure overrides', () => {
    expect(effectiveQuotaBurnSettings({ overrides: { model: 'opus' } }, null))
      .toEqual({ providerId: null, model: 'opus', effort: null, params: {} });
  });
});

describe('quotaBurnStepPayload', () => {
  const stored = {
    id: 'j1',
    enabled: true,
    label: 'Nightly UX',
    taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app1' },
    jobType: null,
    overrides: { providerId: null, model: null, effort: null, params: { fileIssues: true } },
    runOnce: false,
    // The compat mirrors the GET hands back on every read.
    model: null,
    providerId: null,
    effort: null,
    params: { fileIssues: true },
    unavailable: null,
  };

  it('drops the top-level mirrors that would outrank the overrides bag', () => {
    // `normalizeQuotaBurnJob` resolves them by PRESENCE, so echoing a stale
    // mirror back would silently restore a model the user just cleared.
    const payload = quotaBurnStepPayload({ ...stored, overrides: { ...stored.overrides, model: null }, model: 'opus' });
    expect(payload).not.toHaveProperty('model');
    expect(payload).not.toHaveProperty('providerId');
    expect(payload).not.toHaveProperty('effort');
    expect(payload).not.toHaveProperty('params');
    expect(payload.overrides.model).toBeNull();
  });

  it('keeps a stale step\'s reason so an unrelated edit does not erase it on screen', () => {
    // The same object is applied to the page's optimistic config; the server
    // ignores the field and re-derives it from the live catalog.
    const payload = quotaBurnStepPayload({ ...stored, unavailable: { code: 'disabled', reason: 'task is disabled' } });
    expect(payload.unavailable).toEqual({ code: 'disabled', reason: 'task is disabled' });
    expect(quotaBurnStepPayload(stored)).not.toHaveProperty('unavailable');
  });

  it('sends a legacy step\'s jobType and a reference step\'s taskRef, never both', () => {
    expect(quotaBurnStepPayload(stored)).toMatchObject({ taskRef: stored.taskRef });
    expect(quotaBurnStepPayload(stored)).not.toHaveProperty('jobType');
    const legacy = quotaBurnStepPayload({ id: 'old', jobType: 'agent-prompt', params: { prompt: 'hi' }, overrides: { params: { prompt: 'hi' } } });
    expect(legacy.jobType).toBe('agent-prompt');
    expect(legacy).not.toHaveProperty('taskRef');
    // The prompt survives through the overrides bag rather than the mirror.
    expect(legacy.overrides.params).toEqual({ prompt: 'hi' });
  });
});

describe('taskSourceHref', () => {
  it('deep-links a built-in task into the Schedule drawer and a custom job to System Tasks', () => {
    expect(taskSourceHref({ kind: 'builtin', taskType: 'pr-reviewer' })).toBe('/cos/schedule?task=pr-reviewer');
    expect(taskSourceHref({ kind: 'custom', jobId: 'job-a' })).toBe('/cos/jobs');
    expect(taskSourceHref(null)).toBe('/cos/schedule');
  });
});

// @vitest-environment node
