import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cosWorkerBudget } from './lib/cosWorkerBudget.js';
import { EXCLUSIVE_CAPTURE_TESTS, applyRunnerSelection, vitestCaptureProjects, vitestCiPool, vitestRunnerSelection } from './vitestCiPool.js';

describe('vitestCiPool', () => {
  const original = process.env.CI;
  const originalCi = process.env.PORTOS_CI_MAX_WORKERS;
  const originalPregate = process.env.PORTOS_PREGATE_MAX_WORKERS;
  const restore = (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  // The Windows CI job exports the override; tests must not inherit it.
  beforeEach(() => {
    delete process.env.PORTOS_CI_MAX_WORKERS;
  });

  afterEach(() => {
    restore('CI', original);
    restore('PORTOS_PREGATE_MAX_WORKERS', originalPregate);
    restore('PORTOS_CI_MAX_WORKERS', originalCi);
  });

  it('lets a CI job lower the cap but never raise it or use a malformed value', () => {
    process.env.CI = 'true';
    process.env.PORTOS_CI_MAX_WORKERS = '2';
    expect(vitestCiPool()).toEqual({ maxWorkers: 2 });
    process.env.PORTOS_CI_MAX_WORKERS = '16';
    expect(vitestCiPool()).toEqual({ maxWorkers: 4 });
    for (const bad of ['0', 'abc', '2.5', '']) {
      process.env.PORTOS_CI_MAX_WORKERS = bad;
      expect(vitestCiPool()).toEqual({ maxWorkers: 4 });
    }
  });

  it('bounds local pregate workers, never above the workspace cap', () => {
    delete process.env.CI;
    process.env.PORTOS_PREGATE_MAX_WORKERS = '3';
    expect(vitestCiPool()).toEqual({ maxWorkers: 3 });
    expect(vitestCiPool({ maxWorkers: 2 })).toEqual({ maxWorkers: 2 });
    process.env.PORTOS_PREGATE_MAX_WORKERS = '16';
    expect(vitestCiPool()).toEqual({ maxWorkers: 4 });
  });

  it('ignores a malformed pregate budget and lets CI win', () => {
    delete process.env.CI;
    for (const bad of ['0', '-1', 'abc', '2.5', '']) {
      process.env.PORTOS_PREGATE_MAX_WORKERS = bad;
      expect(vitestCiPool()).toEqual({ maxWorkers: Math.min(4, cosWorkerBudget()) });
    }
    process.env.CI = 'true';
    process.env.PORTOS_PREGATE_MAX_WORKERS = '1';
    expect(vitestCiPool()).toEqual({ maxWorkers: 4 });
  });

  it('bounds local runs by the CoS-derived budget when no handoff is set', () => {
    delete process.env.CI;
    delete process.env.PORTOS_PREGATE_MAX_WORKERS;
    expect(vitestCiPool()).toEqual({ maxWorkers: Math.min(4, cosWorkerBudget()) });
  });

  it('matches the four CPUs on public GitHub-hosted runners', () => {
    process.env.CI = 'true';
    expect(vitestCiPool()).toEqual({ maxWorkers: 4 });
  });

  it('treats CI=1 as CI', () => {
    process.env.CI = '1';
    expect(vitestCiPool()).toEqual({ maxWorkers: 4 });
  });

  it('allows a workspace to retain a lower evidence-based cap', () => {
    process.env.CI = 'true';
    expect(vitestCiPool({ maxWorkers: 2 })).toEqual({ maxWorkers: 2 });
  });
});

// Real workers catch inheritance/array-merging mistakes that can duplicate or
// drop suites, or defeat exclusion, despite correct-looking config objects.
it('runs parallel units before exclusive, nonduplicated captures and cutover proofs', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'portos-capture-schedule-'));
  const fixture = join(scratch, 'fixture');
  const server = fileURLToPath(new URL('../server/', import.meta.url));
  try {
    mkdirSync(fixture);
    symlinkSync(join(server, 'node_modules'), join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const put = (name, source) => {
      const path = join(fixture, name);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, source);
    };
    put('vitest.setup.js', "if (process.env.NODE_ENV !== 'test') throw Error('unsafe worker env');");
    put('test/runTempRoot.js', `export { setup } from ${JSON.stringify(new URL('../server/test/runTempRoot.js', import.meta.url).href)};`);
    const common = `
      import { test, expect } from 'vitest';
      import { appendFileSync, existsSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
      import { setTimeout as delay } from 'node:timers/promises';
      const root = ${JSON.stringify(fixture)};
      const marker = name => root + '/' + name;
      const record = name => appendFileSync(marker('events'), name + '\\n');
      async function waitFor(name) {
        const until = Date.now() + 5000;
        while (!existsSync(marker(name))) {
          if (Date.now() > until) throw Error('parallel unit handshake failed');
          await delay(10);
        }
      }
    `;
    for (const [name, other] of [['unit-a', 'unit-b'], ['unit-b', 'unit-a']]) {
      put(`${name}.test.js`, `${common}test('${name}', async () => {
        expect(existsSync(marker('capture-lock'))).toBe(false);
        writeFileSync(marker('${name}-started'), '');
        await waitFor('${other}-started');
        writeFileSync(marker('${name}-done'), '');
        record('${name}');
      });`);
    }
    for (const [name, path] of [
      ['film-look', 'lib/filmLook.browser.test.js'],
      ['greybox', 'routes/catalogGreyboxViewer.browser.test.js'],
      ['html', 'services/htmlComposition/index.test.js'],
      ['music', 'services/musicVideo/documentRender.browser.test.js'],
      ['suno', 'services/musicVideo/publish/sunoHook.browser.test.js'],
      ['cutover', 'services/databaseMaintenanceCutover.test.js'],
      ['assembly', 'services/creativeDirector/videoAssembly.test.js'],
      ['process-audit-cleanup', '../scripts/persistentMindProcessAuditCleanup.test.js'],
      ['workspace-caches', '../scripts/workspaceCaches.test.js'],
    ]) {
      put(path, `${common}test('${name}', async ({ task }) => {
        expect(task.file.projectName).toBe('capture');
        expect(existsSync(marker('unit-a-done')) && existsSync(marker('unit-b-done'))).toBe(true);
        const lock = openSync(marker('capture-lock'), 'wx');
        try {
          record('${name}');
          await delay(200);
        } finally { closeSync(lock); unlinkSync(marker('capture-lock')); }
      });`);
    }
    put('services/voice/profiles.db.test.js', "throw Error('DB suite must stay excluded');");
    const env = { ...process.env, NODE_ENV: 'development', TMPDIR: scratch, TMP: scratch, TEMP: scratch };
    delete env.PORTOS_TEST_TEMP_ROOT;
    delete env.VITEST_FAST;
    delete env.PORTOS_CI_BROWSER_OWNER;
    const result = spawnSync(process.execPath, [join(server, 'node_modules/vitest/vitest.mjs'), 'run', '--configLoader', 'runner',
      '--config', join(server, 'vitest.config.js'), '--root', fixture, '--maxWorkers', '2',
    ], { cwd: server, env, encoding: 'utf8', timeout: 30000 });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const events = readFileSync(join(fixture, 'events'), 'utf8').trim().split('\n');
    expect(events.slice(0, 2).sort()).toEqual(['unit-a', 'unit-b']);
    expect(events.slice(2).sort()).toEqual(['assembly', 'cutover', 'film-look', 'greybox', 'html', 'music', 'process-audit-cleanup', 'suno', 'workspace-caches']);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 35000);

describe('vitestRunnerSelection', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('keeps the config globs without a selection and applies a file selection on top of them', () => {
    expect(vitestRunnerSelection({})).toEqual({ include: null, exclude: [] });
    dir = mkdtempSync(join(tmpdir(), 'portos-selection-'));
    const path = join(dir, 'selection.json');
    writeFileSync(path, JSON.stringify({ include: ['lib/a.test.js', '../scripts/b.test.js'], exclude: ['lib/c.test.js'] }));
    const selection = vitestRunnerSelection({ PORTOS_CI_TEST_SELECTION: path });
    expect(applyRunnerSelection({ include: ['**/*.test.js'], exclude: ['**/node_modules/**'] }, selection))
      .toEqual({ include: ['lib/a.test.js', '../scripts/b.test.js'], exclude: ['**/node_modules/**', 'lib/c.test.js'] });
    // An exclude-only selection (a memo-trimmed full run) keeps the globs; an absent exclude stays absent.
    writeFileSync(path, JSON.stringify({ include: null, exclude: ['lib/c.test.js'] }));
    expect(applyRunnerSelection({ include: ['**/*.test.js'] }, vitestRunnerSelection({ PORTOS_CI_TEST_SELECTION: path })))
      .toEqual({ include: ['**/*.test.js'], exclude: ['lib/c.test.js'] });
    expect(applyRunnerSelection({ include: ['x'] }, { include: null, exclude: [] })).toEqual({ include: ['x'] });
    // The capture project narrows to the selection too, instead of running every exclusive suite.
    const [parallel, capture] = vitestCaptureProjects({ include: ['lib/a.test.js', EXCLUSIVE_CAPTURE_TESTS[0]], exclude: [] },
      { selection: { include: ['lib/a.test.js', EXCLUSIVE_CAPTURE_TESTS[0]], exclude: [] } });
    expect(capture.test.include).toEqual([EXCLUSIVE_CAPTURE_TESTS[0]]);
    expect(parallel.test.exclude).toContain(EXCLUSIVE_CAPTURE_TESTS[0]);
    expect(vitestCaptureProjects({ include: ['**/*.test.js'], exclude: [] })[1].test.include.length).toBeGreaterThan(1);
    // Client-owned process fixtures use the same ordering without importing
    // the server's exclusive file list or widening a scoped/memo selection.
    for (const selection of [{ include: null, exclude: [] }, { include: ['src/unit.test.js'], exclude: [] }]) {
      const projects = vitestCaptureProjects({ include: ['src/**/*.test.js'], exclude: selection.exclude }, {
        selection, exclusiveTests: ['src/test/workspaceCaches.test.js'],
      });
      expect(projects[0].test.exclude).toEqual(['src/test/workspaceCaches.test.js']);
      expect(projects[1].test.include).toEqual(selection.include === null ? ['src/test/workspaceCaches.test.js'] : []);
      expect(projects[1].test.fileParallelism).toBe(false);
    }
  });

  it('refuses a selection it cannot read rather than widening to the whole suite', () => {
    dir = mkdtempSync(join(tmpdir(), 'portos-selection-'));
    const path = join(dir, 'selection.json');
    writeFileSync(path, '{ not json');
    expect(() => vitestRunnerSelection({ PORTOS_CI_TEST_SELECTION: path })).toThrow();
    writeFileSync(path, JSON.stringify({ include: ['ok', 42] }));
    expect(() => vitestRunnerSelection({ PORTOS_CI_TEST_SELECTION: path })).toThrow(/include/);
    expect(() => vitestRunnerSelection({ PORTOS_CI_TEST_SELECTION: join(dir, 'missing.json') })).toThrow();
  });
});
