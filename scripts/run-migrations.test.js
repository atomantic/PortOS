import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runMigrations, listPendingMigrations } from './run-migrations.js';

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

describe('runMigrations purge-migration guard (#2770)', () => {
  let rootDir;
  let dataDir;
  let migrationsDir;
  let appliedFile;
  let warnSpy;
  let logSpy;

  // A purge migration that identifies its target by PRESENCE: it deletes a
  // bucket from a data file every time up() runs. If the runner reran it after
  // the applied-list was lost, it would destroy legitimately-earned data.
  const PURGE_FIXTURE = `
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
export default {
  purge: true,
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'learning.json');
    const raw = await readFile(path, 'utf-8').catch(() => null);
    if (raw == null) return { purged: 0 };
    const data = JSON.parse(raw);
    const had = data.bucket !== undefined;
    delete data.bucket;
    await writeFile(path, JSON.stringify(data));
    return { purged: had ? 1 : 0 };
  }
};
`;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'run-migrations-purge-'));
    dataDir = join(rootDir, 'data');
    migrationsDir = join(rootDir, 'migrations');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(migrationsDir, { recursive: true });
    appliedFile = join(dataDir, 'migrations.applied.json');
    writeFileSync(join(migrationsDir, '197-purge.js'), PURGE_FIXTURE);

    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  const seedLearning = (data) =>
    writeFileSync(join(dataDir, 'learning.json'), JSON.stringify(data));
  const readLearning = () =>
    JSON.parse(readFileSync(join(dataDir, 'learning.json'), 'utf-8'));

  it('runs a purge migration normally when the applied-list has prior content', async () => {
    // The healthy upgrade path: an install with earlier migrations recorded runs
    // the purge for the first time and it DOES purge the poisoned bucket.
    writeFileSync(appliedFile, JSON.stringify(['000-earlier.js'], null, 2) + '\n');
    seedLearning({ bucket: { poisoned: true }, keep: 1 });

    const ran = await runMigrations({ rootDir, migrationsDir });

    expect(ran).toBe(1);
    expect(readLearning()).toEqual({ keep: 1 }); // bucket purged
    expect(JSON.parse(readFileSync(appliedFile, 'utf-8'))).toContain('197-purge.js');
  });

  it('does NOT rerun a purge migration when the applied-list was lost — post-fix data survives', async () => {
    // The bug: applied-list deleted, learning.json holds ONLY post-fix runs.
    // A destructive rerun would delete the legitimately-earned bucket.
    expect(existsSync(appliedFile)).toBe(false);
    seedLearning({ bucket: { legitPostFixRuns: 12 }, keep: 1 });

    const ran = await runMigrations({ rootDir, migrationsDir });

    expect(ran).toBe(0); // recorded-as-applied without executing
    // The earned bucket is untouched — NOT purged.
    expect(readLearning()).toEqual({ bucket: { legitPostFixRuns: 12 }, keep: 1 });
    // Still recorded so a later boot with a healthy ledger won't rerun it either.
    expect(JSON.parse(readFileSync(appliedFile, 'utf-8'))).toEqual(['197-purge.js']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping purge migration'));
  });

  it('does NOT rerun a purge migration when the applied-list was corrupt-rebuilt', async () => {
    writeFileSync(appliedFile, '{ truncated'); // corrupt → rebuilt from []
    seedLearning({ bucket: { legitPostFixRuns: 5 }, keep: 2 });

    const ran = await runMigrations({ rootDir, migrationsDir });

    expect(ran).toBe(0);
    expect(readLearning()).toEqual({ bucket: { legitPostFixRuns: 5 }, keep: 2 });
    expect(JSON.parse(readFileSync(appliedFile, 'utf-8'))).toEqual(['197-purge.js']);
  });

  it('records a purge migration as applied on a fresh install (nothing to purge)', async () => {
    // No learning.json at all — the empty-ledger skip is harmless and still marks
    // it applied so it never fires destructively later.
    const ran = await runMigrations({ rootDir, migrationsDir });

    expect(ran).toBe(0);
    expect(JSON.parse(readFileSync(appliedFile, 'utf-8'))).toEqual(['197-purge.js']);
  });

  it('still runs non-purge migrations when the applied-list starts empty', async () => {
    // Only purge-flagged migrations are held back on an empty ledger — ordinary
    // idempotent migrations must still run on a fresh/rebuilt install.
    writeFileSync(join(migrationsDir, '001-normal.js'), `
import { writeFileSync } from 'fs';
import { join } from 'path';
export default {
  async up({ rootDir }) { writeFileSync(join(rootDir, 'data', 'normal-marker.txt'), 'ran'); }
};
`);

    const ran = await runMigrations({ rootDir, migrationsDir });

    expect(ran).toBe(1); // the normal one ran; the purge one was skip-recorded
    expect(existsSync(join(dataDir, 'normal-marker.txt'))).toBe(true);
    expect(JSON.parse(readFileSync(appliedFile, 'utf-8')).sort())
      .toEqual(['001-normal.js', '197-purge.js']);
  });

  it('disarms purge migrations even when an earlier migration aborts the rebuilt-empty run', async () => {
    // The re-arm hole: a rebuilt-from-empty run that throws BEFORE reaching the
    // purge migration persists a partial ledger. The next boot's ledger no
    // longer "starts empty" — so unless the purge was disarmed up front, it
    // would then execute destructively against the rebuilt install.
    // Throws on its first execution only (marker-gated, since the module cache
    // would defeat rewriting the file between runs in-process).
    writeFileSync(join(migrationsDir, '001-throws.js'), `
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
export default {
  async up({ rootDir }) {
    const marker = join(rootDir, 'data', 'throw-once.txt');
    if (!existsSync(marker)) { writeFileSync(marker, '1'); throw new Error('repair me and reboot'); }
  }
};
`);
    seedLearning({ bucket: { legitPostFixRuns: 7 }, keep: 3 });

    // Run 1: ledger starts empty, 001 throws and aborts the run.
    await expect(runMigrations({ rootDir, migrationsDir })).rejects.toThrow('repair me');
    // The purge was already skip-recorded before the loop reached 001.
    expect(JSON.parse(readFileSync(appliedFile, 'utf-8'))).toContain('197-purge.js');

    // "Reboot": the ledger is now non-empty, but the purge must NOT fire — it
    // was recorded as applied during the aborted run.
    await runMigrations({ rootDir, migrationsDir });
    expect(readLearning()).toEqual({ bucket: { legitPostFixRuns: 7 }, keep: 3 });
  });
});

describe('runMigrations worktree backstop (#1947)', () => {
  let baseDir;
  let migrationsDir;
  let warnSpy;
  let logSpy;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'run-migrations-wt-'));
    migrationsDir = join(baseDir, 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    // A migration that WOULD fail if it ran against a worktree checkout — it
    // writes into data/ which doesn't exist there. The guard must skip before
    // this runs.
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
    rmSync(baseDir, { recursive: true, force: true });
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('skips the migration pass when rootDir is a CoS agent worktree checkout', async () => {
    // A worktree checkout root lives under data/cos/worktrees/<agent> and has
    // no data/ runtime tree — running migrations there crashes on ENOENT.
    const worktreeRoot = join(baseDir, 'data', 'cos', 'worktrees', 'agent-test');
    mkdirSync(worktreeRoot, { recursive: true });

    const ran = await runMigrations({ rootDir: worktreeRoot, migrationsDir });

    expect(ran).toBe(0);
    expect(existsSync(join(worktreeRoot, 'data'))).toBe(false); // never created
    expect(existsSync(join(worktreeRoot, 'data', 'migrations.applied.json'))).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('CoS agent worktree'));
  });

  it('still runs migrations for a normal (non-worktree) rootDir', async () => {
    const realRoot = join(baseDir, 'install');
    mkdirSync(join(realRoot, 'data'), { recursive: true });

    const ran = await runMigrations({ rootDir: realRoot, migrationsDir });

    expect(ran).toBe(1);
    expect(existsSync(join(realRoot, 'data', 'fixture-marker.txt'))).toBe(true);
  });

});

describe('listPendingMigrations', () => {
  let rootDir;
  let dataDir;
  let migrationsDir;
  let appliedFile;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'list-pending-'));
    dataDir = join(rootDir, 'data');
    migrationsDir = join(rootDir, 'migrations');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(migrationsDir, { recursive: true });
    appliedFile = join(dataDir, 'migrations.applied.json');
    // Migration content is irrelevant — listPendingMigrations never imports them.
    writeFileSync(join(migrationsDir, '001-a.js'), 'export default { async up() {} };');
    writeFileSync(join(migrationsDir, '002-b.js'), 'export default { async up() {} };');
    writeFileSync(join(migrationsDir, '003-c.js'), 'export default { async up() {} };');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('returns all migrations as pending when the applied-list is missing', async () => {
    const pending = await listPendingMigrations({ rootDir, migrationsDir });
    expect(pending).toEqual(['001-a.js', '002-b.js', '003-c.js']);
  });

  it('returns only the migrations not in the applied-list, in sorted order', async () => {
    writeFileSync(appliedFile, JSON.stringify(['001-a.js']) + '\n');
    const pending = await listPendingMigrations({ rootDir, migrationsDir });
    expect(pending).toEqual(['002-b.js', '003-c.js']);
  });

  it('returns empty when every migration is applied', async () => {
    writeFileSync(appliedFile, JSON.stringify(['001-a.js', '002-b.js', '003-c.js']) + '\n');
    const pending = await listPendingMigrations({ rootDir, migrationsDir });
    expect(pending).toEqual([]);
  });

  it('excludes *.test.js and `_`-prefixed helper files', async () => {
    writeFileSync(join(migrationsDir, '001-a.test.js'), '// test');
    writeFileSync(join(migrationsDir, '_lib.js'), 'export const x = 1;');
    const pending = await listPendingMigrations({ rootDir, migrationsDir });
    expect(pending).toEqual(['001-a.js', '002-b.js', '003-c.js']);
  });

  it('treats a corrupt applied-list as empty WITHOUT mutating it (read-only)', async () => {
    writeFileSync(appliedFile, '{ not valid json');
    const pending = await listPendingMigrations({ rootDir, migrationsDir });
    expect(pending).toEqual(['001-a.js', '002-b.js', '003-c.js']);
    // Read-only: the corrupt file must NOT be renamed aside.
    expect(readdirSync(dataDir).some(f => f.includes('corrupt'))).toBe(false);
    expect(existsSync(appliedFile)).toBe(true);
  });
});
