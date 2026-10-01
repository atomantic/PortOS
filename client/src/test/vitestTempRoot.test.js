// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVitestTempFixture } from '../../../scripts/lib/vitestTempRootFixture.js';

describe('real client runner temp lifecycle', () => {
  const workspace = 'client';
  for (const outcome of ['success', 'failure', 'leak']) {
    it(`${workspace} removes framework scratch on ${outcome}, preserving host artifacts`, () => {
      const host = mkdtempSync(join(tmpdir(), 'vrt-'));
      try {
        // Even nanoid-looking pre-existing directories belong to the host.
        const untouched = 'A'.repeat(21);
        mkdirSync(join(host, untouched));
        writeFileSync(join(host, untouched, 'keep'), 'host data');
        const body = outcome === 'failure' ? "expect(true).toBe(false);"
          : outcome === 'leak' ? "writeFileSync(join(tmpdir(), 'fixture-leak'), 'unexpected');"
            : 'expect(true).toBe(true);';
        const { args, options } = createVitestTempFixture(host, workspace, body);
        const result = spawnSync(process.execPath, args, options);
        expect(result.error).toBeUndefined();
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(outcome === 'success' ? 0 : 1);
        if (outcome === 'leak') expect(result.stderr).toContain('test temp leak: fixture-leak');
        expect(readdirSync(host).sort()).toEqual([untouched, 'fixture'].sort());
      } finally {
        rmSync(host, { recursive: true, force: true });
      }
    }, 25000);
  }

  it('reimports the real client config without abandoning another temp root', () => {
    const host = mkdtempSync(join(tmpdir(), 'vrt-'));
    try {
      const env = { ...process.env, TMPDIR: host, TMP: host, TEMP: host };
      delete env.PORTOS_TEST_TEMP_ROOT;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        `await import(${JSON.stringify(new URL('../../vitest.config.js', import.meta.url).href)});
         const root = process.env.PORTOS_TEST_TEMP_ROOT;
         await import(${JSON.stringify(new URL('../../vitest.config.js?reimport', import.meta.url).href)});
         if (process.env.PORTOS_TEST_TEMP_ROOT !== root) throw Error('reimport created another root');
         const { teardown } = await import(${JSON.stringify(new URL('../../../scripts/vitestTempRootSetup.js', import.meta.url).href)});
         teardown();`], { env, encoding: 'utf8', timeout: 20000 });
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readdirSync(host)).toEqual([]);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  }, 25000);

});
