import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runMigrations } from './run-migrations.js';

describe('runMigrations corrupt applied-list recovery', () => {
  let rootDir;
  let dataDir;
  let migrationsDir;
  let appliedFile;
  let warnSpy;
  let logSpy;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'run-migrations-'));
    dataDir = join(rootDir, 'data');
    migrationsDir = join(rootDir, 'migrations');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(migrationsDir, { recursive: true });
    appliedFile = join(dataDir, 'migrations.applied.json');

    // Fixture migration that simply touches a marker file — idempotent if it
    // checks existsSync before writing.
    writeFileSync(join(migrationsDir, '001-fixture.js'), `
import { writeFileSync } from 'fs';
import { join } from 'path';
export default {
  async up({ rootDir }) {
    writeFileSync(join(rootDir, 'data', 'fixture-marker.txt'), 'ran');
  }
};
`);

    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  const corruptSiblings = () =>
    readdirSync(dataDir).filter((f) => f.startsWith('migrations.applied.json.corrupt-'));

  it('renames truncated JSON aside and rebuilds from scratch', async () => {
    writeFileSync(appliedFile, '[\n  "001-fixture.js",\n  "002-'); // truncated mid-write

    await runMigrations({ rootDir, migrationsDir });

    expect(existsSync(appliedFile)).toBe(true);
    const newContent = JSON.parse(readFileSync(appliedFile, 'utf-8'));
    expect(newContent).toEqual(['001-fixture.js']);

    const aside = corruptSiblings();
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dataDir, aside[0]), 'utf-8')).toContain('001-fixture.js');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Corrupt migrations file'));
    expect(existsSync(join(dataDir, 'fixture-marker.txt'))).toBe(true);
  });

  it('renames non-array JSON aside and rebuilds', async () => {
    writeFileSync(appliedFile, '{"hijacked": true}');

    await runMigrations({ rootDir, migrationsDir });

    expect(corruptSiblings()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('expected array'));
    expect(JSON.parse(readFileSync(appliedFile, 'utf-8'))).toEqual(['001-fixture.js']);
  });

  it('leaves a valid applied list untouched', async () => {
    writeFileSync(appliedFile, JSON.stringify(['001-fixture.js'], null, 2) + '\n');

    const ran = await runMigrations({ rootDir, migrationsDir });

    expect(ran).toBe(0);
    expect(corruptSiblings()).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(existsSync(join(dataDir, 'fixture-marker.txt'))).toBe(false);
  });

  it('runs cleanly when the applied file is missing entirely', async () => {
    expect(existsSync(appliedFile)).toBe(false);

    const ran = await runMigrations({ rootDir, migrationsDir });

    expect(ran).toBe(1);
    expect(JSON.parse(readFileSync(appliedFile, 'utf-8'))).toEqual(['001-fixture.js']);
    expect(corruptSiblings()).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('skips `_`-prefixed shared-helper files (never imports them as migrations)', async () => {
    // _lib.js / _testHelpers.js are imported by migration files + tests but
    // they don't export `up()` — if the runner tried to load them it would
    // throw "does not export an up() function".
    writeFileSync(join(migrationsDir, '_lib.js'), `
export const md5 = (s) => s;
// no default export, no up() — would throw if the runner picked this up.
`);

    const ran = await runMigrations({ rootDir, migrationsDir });

    expect(ran).toBe(1); // only 001-fixture.js ran
    expect(JSON.parse(readFileSync(appliedFile, 'utf-8'))).toEqual(['001-fixture.js']);
  });
});
