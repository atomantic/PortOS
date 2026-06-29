/**
 * Test for migration 146 — rename clawed-ollama → claude-ollama and add the
 * Claude Ollama CLI + TUI shipped providers. Picked up by server/vitest.config.js's
 * `../scripts/**\/*.test.js` glob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './146-claude-ollama-providers.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const clawed = (overrides = {}) => ({
  id: 'clawed-ollama',
  name: 'Clawed Ollama (local model)',
  type: 'cli',
  command: 'claude',
  args: ['--print'],
  models: [],
  defaultModel: null,
  ollamaBacked: true,
  enabled: false,
  envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434', ANTHROPIC_AUTH_TOKEN: 'ollama' },
  ...overrides,
});

describe('migration 146 — Claude Ollama providers', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-146-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('renames clawed-ollama → claude-ollama, preserving customizations', async () => {
    writeJson(providersPath, {
      activeProvider: 'clawed-ollama',
      providers: {
        'clawed-ollama': clawed({ enabled: true, models: ['qwen2.5:7b'], defaultModel: 'qwen2.5:7b' }),
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    expect(out.providers['clawed-ollama']).toBeUndefined();
    const claude = out.providers['claude-ollama'];
    expect(claude.id).toBe('claude-ollama');
    expect(claude.name).toBe('Claude Ollama (local model)');
    // user customizations preserved
    expect(claude.enabled).toBe(true);
    expect(claude.models).toEqual(['qwen2.5:7b']);
    expect(claude.defaultModel).toBe('qwen2.5:7b');
    // activeProvider reference rewritten
    expect(out.activeProvider).toBe('claude-ollama');
    // TUI variant added
    expect(out.providers['claude-ollama-tui']).toBeDefined();
    expect(out.providers['claude-ollama-tui'].type).toBe('tui');
  });

  it('keeps a user-customized provider name but still renames the id', async () => {
    writeJson(providersPath, {
      providers: { 'clawed-ollama': clawed({ name: 'My Local Beast' }) },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    expect(out.providers['claude-ollama'].name).toBe('My Local Beast');
  });

  it('rewrites fallbackProvider references off the retired id', async () => {
    writeJson(providersPath, {
      providers: {
        'clawed-ollama': clawed(),
        'claude-code': { id: 'claude-code', type: 'cli', command: 'claude', fallbackProvider: 'clawed-ollama' },
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    expect(out.providers['claude-code'].fallbackProvider).toBe('claude-ollama');
  });

  it('prefers the user clawed config over a fresh-merged default claude-ollama', async () => {
    // Simulates the update.sh order: setup-data merged the default claude-ollama
    // BEFORE this migration runs, while the user still has their old clawed one.
    writeJson(providersPath, {
      providers: {
        'clawed-ollama': clawed({ enabled: true, models: ['qwen2.5:7b'] }),
        'claude-ollama': { ...clawed({ id: 'claude-ollama', name: 'Claude Ollama (local model)' }) },
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    expect(out.providers['clawed-ollama']).toBeUndefined();
    // the user's real (enabled, model-populated) config wins
    expect(out.providers['claude-ollama'].enabled).toBe(true);
    expect(out.providers['claude-ollama'].models).toEqual(['qwen2.5:7b']);
  });

  it('rewrites dangling active/fallback refs even when the clawed entry is already gone', async () => {
    // clawed-ollama entry removed (manual delete / setup drift) but refs linger
    writeJson(providersPath, {
      activeProvider: 'clawed-ollama',
      providers: {
        'claude-code': { id: 'claude-code', type: 'cli', command: 'claude', fallbackProvider: 'clawed-ollama' },
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    expect(out.activeProvider).toBe('claude-ollama');
    expect(out.providers['claude-code'].fallbackProvider).toBe('claude-ollama');
    // and the target now exists (added in step 2)
    expect(out.providers['claude-ollama']).toBeDefined();
  });

  it('does not clobber a user-customized claude-ollama when clawed also exists', async () => {
    // Both exist, and claude-ollama is genuinely customized (enabled + models) —
    // not the freshly-merged pristine default. Keep it; just drop stale clawed.
    writeJson(providersPath, {
      providers: {
        'clawed-ollama': clawed({ enabled: false, models: ['old-model'] }),
        'claude-ollama': clawed({ id: 'claude-ollama', name: 'My Tuned Local', enabled: true, models: ['qwen2.5-coder:32b'] }),
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    expect(out.providers['clawed-ollama']).toBeUndefined();
    // user's customized claude-ollama survives untouched
    expect(out.providers['claude-ollama'].name).toBe('My Tuned Local');
    expect(out.providers['claude-ollama'].enabled).toBe(true);
    expect(out.providers['claude-ollama'].models).toEqual(['qwen2.5-coder:32b']);
  });

  it('adds both shipped providers to an install that never had clawed', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    const cli = out.providers['claude-ollama'];
    const tui = out.providers['claude-ollama-tui'];
    expect(cli.type).toBe('cli');
    expect(cli.ollamaBacked).toBe(true);
    expect(cli.envVars.ANTHROPIC_BASE_URL).toBe('http://localhost:11434');
    expect(tui.type).toBe('tui');
    expect(tui.args).toEqual(['--dangerously-skip-permissions']);
    expect(tui.ollamaBacked).toBe(true);
    // unrelated providers untouched, active provider preserved
    expect(out.activeProvider).toBe('claude-code');
  });

  it('is idempotent — a second run makes no changes', async () => {
    writeJson(providersPath, {
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });
    const afterFirst = readFileSync(providersPath, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(providersPath, 'utf-8')).toBe(afterFirst);
  });

  it('repoints clawed-ollama provider pins in schedules and autonomous jobs', async () => {
    writeJson(providersPath, { providers: { 'clawed-ollama': clawed() } });
    const schedulePath = join(rootDir, 'data/task-schedule.json');
    const jobsPath = join(rootDir, 'data/autonomous-jobs.json');
    writeJson(schedulePath, {
      intervals: {
        security: { providerId: 'clawed-ollama', model: null },
        // nested pipeline stage pin must also be rewritten
        'code-reviewer': {
          providerId: null,
          taskMetadata: { pipeline: { stages: [{ providerId: 'clawed-ollama' }, { providerId: 'claude-code' }] } },
        },
        other: { providerId: 'codex' }, // untouched
      },
    });
    writeJson(jobsPath, { jobs: [{ id: 'j1', providerId: 'clawed-ollama' }, { id: 'j2', provider: 'clawed-ollama' }, { id: 'j3', providerId: 'claude-code' }] });

    await migration.up({ rootDir });

    const sched = readJson(schedulePath);
    expect(sched.intervals.security.providerId).toBe('claude-ollama');
    expect(sched.intervals['code-reviewer'].taskMetadata.pipeline.stages[0].providerId).toBe('claude-ollama');
    expect(sched.intervals['code-reviewer'].taskMetadata.pipeline.stages[1].providerId).toBe('claude-code'); // untouched
    expect(sched.intervals.other.providerId).toBe('codex'); // untouched

    const jobs = readJson(jobsPath);
    expect(jobs.jobs[0].providerId).toBe('claude-ollama');
    expect(jobs.jobs[1].provider).toBe('claude-ollama');
    expect(jobs.jobs[2].providerId).toBe('claude-code'); // untouched
  });

  it('repoints clawed-ollama task pins in TASKS.md / COS-TASKS.md markdown', async () => {
    writeJson(providersPath, { providers: { 'clawed-ollama': clawed() } });
    const tasksPath = join(rootDir, 'data/TASKS.md');
    const cosTasksPath = join(rootDir, 'data/COS-TASKS.md');
    writeFileSync(tasksPath, '# Tasks\n\n- [ ] Do a thing\n  provider: clawed-ollama\n  model: qwen2.5:7b\n');
    writeFileSync(cosTasksPath, '# CoS Tasks\n\n- [ ] internal\n  provider: clawed-ollama\n');

    await migration.up({ rootDir });

    expect(readFileSync(tasksPath, 'utf-8')).toContain('provider: claude-ollama');
    expect(readFileSync(tasksPath, 'utf-8')).not.toContain('clawed-ollama');
    expect(readFileSync(cosTasksPath, 'utf-8')).toContain('provider: claude-ollama');
  });

  it('does not touch claude-ollama-tui or unrelated tokens in markdown task files', async () => {
    writeJson(providersPath, { providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } } });
    const tasksPath = join(rootDir, 'data/TASKS.md');
    // a task pinned to the TUI variant + prose must survive untouched
    writeFileSync(tasksPath, '- [ ] x\n  provider: claude-ollama-tui\n  context: see clawed-ollama-notes.md\n');
    const before = readFileSync(tasksPath, 'utf-8');

    await migration.up({ rootDir });

    // boundary guard: "claude-ollama-tui" and "clawed-ollama-notes.md" are NOT bare clawed-ollama tokens
    expect(readFileSync(tasksPath, 'utf-8')).toBe(before);
  });

  it('repoints clawed-ollama pins in any top-level data/*.json (settings AI assignments, etc.)', async () => {
    writeJson(providersPath, { providers: { 'clawed-ollama': clawed() } });
    const settingsPath = join(rootDir, 'data/settings.json');
    const arbitraryPath = join(rootDir, 'data/some-other-feature.json');
    writeJson(settingsPath, {
      autofixer: { providerId: 'clawed-ollama' },
      calendarSync: { providerId: 'clawed-ollama' },
      unrelated: { providerId: 'codex' },
    });
    writeJson(arbitraryPath, { nested: { deep: [{ provider: 'clawed-ollama' }] } });

    await migration.up({ rootDir });

    const settings = readJson(settingsPath);
    expect(settings.autofixer.providerId).toBe('claude-ollama');
    expect(settings.calendarSync.providerId).toBe('claude-ollama');
    expect(settings.unrelated.providerId).toBe('codex');
    expect(readJson(arbitraryPath).nested.deep[0].provider).toBe('claude-ollama');
  });

  it('does not recurse into data/ subdirectories (e.g. cos worktrees with source)', async () => {
    writeJson(providersPath, { providers: { 'clawed-ollama': clawed() } });
    // a nested store (subdir) that legitimately contains the slug must be left alone
    const worktreeJsonDir = join(rootDir, 'data/cos/worktrees/agent-x');
    mkdirSync(worktreeJsonDir, { recursive: true });
    const nestedPath = join(worktreeJsonDir, 'config.json');
    writeJson(nestedPath, { providerId: 'clawed-ollama' });
    const before = readFileSync(nestedPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(nestedPath, 'utf-8')).toBe(before);
  });

  it('leaves pin files untouched when they have no clawed-ollama references', async () => {
    writeJson(providersPath, { providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } } });
    const schedulePath = join(rootDir, 'data/task-schedule.json');
    writeJson(schedulePath, { intervals: { security: { providerId: 'codex' } } });
    const before = readFileSync(schedulePath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(schedulePath, 'utf-8')).toBe(before);
  });

  it('is a no-op when data/providers.json does not exist (fresh install)', async () => {
    await migration.up({ rootDir });
    expect(existsSync(providersPath)).toBe(false);
  });

  it('does not modify the file on invalid JSON', async () => {
    writeFileSync(providersPath, '{ not valid json');
    const before = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
  });
});
