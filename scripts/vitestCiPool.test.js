import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { vitestCiPool } from './vitestCiPool.js';

describe('vitestCiPool', () => {
  const original = process.env.CI;

  afterEach(() => {
    if (original === undefined) delete process.env.CI;
    else process.env.CI = original;
  });

  it('leaves local runs unbounded', () => {
    delete process.env.CI;
    expect(vitestCiPool()).toEqual({});
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
it('runs the full server config with parallel units and exclusive, nonduplicated captures', () => {
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
    put('test/runTempRoot.js', `export { setup, teardown } from ${JSON.stringify(new URL('../server/test/runTempRoot.js', import.meta.url).href)};`);
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
      put(`${name}.test.js`, common + `test('${name}', async () => {
        expect(existsSync(marker('capture-lock'))).toBe(false);
        writeFileSync(marker('${name}-started'), '');
        await waitFor('${other}-started');
        writeFileSync(marker('${name}-done'), '');
        record('${name}');
      });`);
    }
    for (const [name, path] of [
      ['html', 'services/htmlComposition/index.test.js'],
      ['music', 'services/musicVideo/documentRender.browser.test.js'],
    ]) {
      put(path, common + `test('${name}', async () => {
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
    const result = spawnSync(process.execPath, [join(server, 'node_modules/vitest/vitest.mjs'), 'run',
      '--config', join(server, 'vitest.config.js'), '--root', fixture, '--maxWorkers', '2',
    ], { cwd: server, env, encoding: 'utf8', timeout: 30000 });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const events = readFileSync(join(fixture, 'events'), 'utf8').trim().split('\n');
    expect(events.slice(0, 2).sort()).toEqual(['unit-a', 'unit-b']);
    expect(events.slice(2).sort()).toEqual(['html', 'music']);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 35000);
