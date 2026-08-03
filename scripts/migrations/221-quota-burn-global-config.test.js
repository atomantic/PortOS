import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration, { buildGlobalPlan } from './221-quota-burn-global-config.js';

// `enabled: true` on the OVERRIDE is the old shape's task-type switch — the one
// `isTaskTypeEnabledForApp` read. It is independent of the per-family flag, and
// the migration requires both.
const app = (id, families, extras = {}, overrideExtras = { enabled: true }) => ({
  id,
  name: `App ${id}`,
  taskTypeOverrides: { 'quota-burn': { ...overrideExtras, taskMetadata: { families, ...extras } } },
});

describe('buildGlobalPlan', () => {
  it('carries each family\'s window settings and turns its prompt into an agent job', () => {
    const { config, touchedAppIds } = buildGlobalPlan([
      app('a1', { grok: { enabled: true, prompt: 'Animate sprites.', reservePercent: 25, maxDispatchesPerWindow: 2, model: 'grok-4' } }),
    ]);
    expect(touchedAppIds).toEqual(['a1']);
    expect(config.enabled).toBe(true);
    expect(config.families.grok).toMatchObject({ enabled: true, reservePercent: 25, maxDispatchesPerWindow: 2 });
    expect(config.families.grok.jobs).toEqual([{
      id: 'migrated-1',
      enabled: true,
      label: 'App a1 burn work',
      jobType: 'agent-prompt',
      model: 'grok-4',
      providerId: null,
      params: { appId: 'a1', prompt: 'Animate sprites.', useWorktree: true, openPR: true, simplify: true },
    }]);
  });

  it('keeps BOTH prompts when two apps configured the same family', () => {
    // Dropping one would silently lose configured work; merging the window
    // settings would invent a value the user never chose, so the first app in
    // file order supplies those and both prompts survive as ordered jobs.
    const { config } = buildGlobalPlan([
      app('a1', { codex: { enabled: true, prompt: 'First', reservePercent: 10 } }),
      app('a2', { codex: { enabled: true, prompt: 'Second', reservePercent: 90 } }),
    ]);
    expect(config.families.codex.reservePercent).toBe(10);
    expect(config.families.codex.jobs.map((job) => job.params.prompt)).toEqual(['First', 'Second']);
    expect(config.families.codex.jobs.map((job) => job.params.appId)).toEqual(['a1', 'a2']);
  });

  it('leaves the master switch off when no family was enabled', () => {
    // An install that configured but never enabled quota-burn must not start
    // spending after an upgrade.
    const { config } = buildGlobalPlan([app('a1', { grok: { enabled: false, prompt: 'Someday' } })]);
    expect(config.enabled).toBe(false);
  });

  it('mirrors the app\'s agent-option posture onto the job', () => {
    const { config } = buildGlobalPlan([
      app('a1', { grok: { enabled: true, prompt: 'x' } }, { useWorktree: false, openPR: false, simplify: false }),
    ]);
    expect(config.families.grok.jobs[0].params).toMatchObject({ useWorktree: false, openPR: false, simplify: false });
  });

  it('reports the app as touched but produces no plan when nothing was configured', () => {
    // The dead task-type override still has to be removed from apps.json.
    const { config, touchedAppIds } = buildGlobalPlan([app('a1', {})]);
    expect(config).toBeNull();
    expect(touchedAppIds).toEqual(['a1']);
  });

  it('ignores apps with no quota-burn override and unknown family keys', () => {
    const { config, touchedAppIds } = buildGlobalPlan([
      { id: 'a0', taskTypeOverrides: { security: { enabled: true } } },
      app('a1', { nonsense: { enabled: true, prompt: 'x' } }),
    ]);
    expect(touchedAppIds).toEqual(['a1']);
    expect(config).toBeNull();
  });
});

describe('migration 221 up()', () => {
  let rootDir;

  const readJson = async (...parts) => JSON.parse(await readFile(join(rootDir, ...parts), 'utf-8'));

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-221-'));
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
  });
  afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

  it('no-ops on a fresh install', async () => {
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, reason: 'no-apps' });
  });

  it('writes the plan and strips the dead task type from both files', async () => {
    await writeFile(join(rootDir, 'data', 'apps.json'), JSON.stringify({
      apps: {
        a1: {
          name: 'App One',
          taskTypeOverrides: {
            security: { enabled: true },
            'quota-burn': { enabled: true, taskMetadata: { families: { grok: { enabled: true, prompt: 'Burn it' } } } },
          },
        },
      },
    }));
    await writeFile(join(rootDir, 'data', 'cos', 'task-schedule.json'), JSON.stringify({
      version: 2, tasks: { security: { enabled: true }, 'quota-burn': { enabled: true } },
    }));

    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, apps: 1, prunedSchedule: true });

    const plan = await readJson('data', 'cos', 'quota-burn.json');
    expect(plan.families.grok.jobs[0].params).toMatchObject({ appId: 'a1', prompt: 'Burn it' });

    const apps = await readJson('data', 'apps.json');
    // The unrelated override must survive — only the dead key is removed.
    expect(Object.keys(apps.apps.a1.taskTypeOverrides)).toEqual(['security']);

    const schedule = await readJson('data', 'cos', 'task-schedule.json');
    expect(Object.keys(schedule.tasks)).toEqual(['security']);
  });

  it('never overwrites a plan the user already has', async () => {
    await writeFile(join(rootDir, 'data', 'apps.json'), JSON.stringify({
      apps: { a1: { taskTypeOverrides: { 'quota-burn': { taskMetadata: { families: { grok: { enabled: true, prompt: 'Old' } } } } } } },
    }));
    await writeFile(join(rootDir, 'data', 'cos', 'quota-burn.json'), JSON.stringify({ enabled: true, families: { grok: { enabled: true, jobs: [] } } }));

    await migration.up({ rootDir });
    const plan = await readJson('data', 'cos', 'quota-burn.json');
    expect(plan.families.grok.jobs).toEqual([]);
  });
});

describe('buildGlobalPlan enabled semantics', () => {
  it('does not arm a family whose TASK TYPE was switched off', async () => {
    // The old shape had two independent switches: `override.enabled` (read by
    // isTaskTypeEnabledForApp) and the per-family flag. Reading only the family
    // flag arms a burn the user had explicitly turned off — unrequested
    // provider spend on upgrade.
    const { config } = buildGlobalPlan([
      app('a1', { grok: { enabled: true, prompt: 'Refactor X' } }, {}, { enabled: false }),
    ]);
    expect(config.enabled).toBe(false);
    expect(config.families.grok.enabled).toBe(false);
    expect(config.families.grok.jobs[0].enabled).toBe(false);
  });

  it('ORs enabled across apps so a live burn survives regardless of file order', () => {
    // First-app-wins on `enabled` silently stopped a running burn when a stale
    // disabled config happened to sort first.
    const disabled = app('a1', { codex: { enabled: false, prompt: 'old', maxDispatchesPerWindow: 2 } }, {}, { enabled: false });
    const live = app('a2', { codex: { enabled: true, prompt: 'current', maxDispatchesPerWindow: 20 } });
    for (const apps of [[disabled, live], [live, disabled]]) {
      const { config } = buildGlobalPlan(apps);
      expect(config.families.codex.enabled).toBe(true);
      expect(config.enabled).toBe(true);
      // Window settings come from the ARMED contributor, so a stale disabled
      // config can't quietly halve a live cap.
      expect(config.families.codex.maxDispatchesPerWindow).toBe(20);
      // Both prompts survive, but only the armed app's job is enabled.
      expect(config.families.codex.jobs.map((job) => job.enabled).sort()).toEqual([false, true]);
    }
  });

  it('carries the old 12-hourly recheck cadence, not the new 30-minute default', () => {
    // The old recheckCron was '0 */12 * * *'. Defaulting a migrated install to
    // 30 minutes takes it from ~2 provider scrapes a day to 48, each spawning a
    // multi-second TUI child per enabled family.
    const { config } = buildGlobalPlan([app('a1', { grok: { enabled: true, prompt: 'x' } })]);
    expect(config.checkIntervalMinutes).toBe(720);
  });
});

describe('buildGlobalPlan install-wide schedule switch', () => {
  it('stays silent when the task type was never enabled install-wide', () => {
    // The old shape needed THREE switches on: the install-wide schedule
    // (shipped default FALSE), the per-app override, and the per-family flag.
    // Reading only the last two arms a burn on an install that configured a
    // family in the per-app panel and never turned the feature on — spending
    // provider quota on upgrade with no user action.
    const { config } = buildGlobalPlan(
      [app('a1', { grok: { enabled: true, prompt: 'Refactor X' } })],
      { scheduleArmed: false },
    );
    expect(config.enabled).toBe(false);
    expect(config.families.grok.enabled).toBe(false);
    expect(config.families.grok.jobs[0].enabled).toBe(false);
  });
});

describe('migration 221 reads the schedule switch before pruning it', () => {
  let rootDir;
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-221b-'));
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
  });
  afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

  const write = (rel, value) => writeFile(join(rootDir, ...rel), JSON.stringify(value));

  it('does not arm a plan whose schedule entry was disabled', async () => {
    // pruneScheduleFile runs first and DELETES the entry — reading `armed`
    // after it would lose the only record of whether this install ever ran.
    await write(['data', 'apps.json'], {
      apps: { a1: { taskTypeOverrides: { 'quota-burn': { enabled: true, taskMetadata: { families: { grok: { enabled: true, prompt: 'x' } } } } } } },
    });
    await write(['data', 'cos', 'task-schedule.json'], { version: 2, tasks: { 'quota-burn': { enabled: false } } });

    await migration.up({ rootDir });
    const plan = JSON.parse(await readFile(join(rootDir, 'data', 'cos', 'quota-burn.json'), 'utf-8'));
    expect(plan.enabled).toBe(false);
    expect(plan.families.grok.enabled).toBe(false);
  });

  it('arms a plan whose schedule entry WAS enabled', async () => {
    await write(['data', 'apps.json'], {
      apps: { a1: { taskTypeOverrides: { 'quota-burn': { enabled: true, taskMetadata: { families: { grok: { enabled: true, prompt: 'x' } } } } } } },
    });
    await write(['data', 'cos', 'task-schedule.json'], { version: 2, tasks: { 'quota-burn': { enabled: true } } });

    await migration.up({ rootDir });
    const plan = JSON.parse(await readFile(join(rootDir, 'data', 'cos', 'quota-burn.json'), 'utf-8'));
    expect(plan.enabled).toBe(true);
  });
});
