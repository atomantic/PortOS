import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync, utimesSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

import { runMigrations, listPendingMigrations, sourceDeclaresPurge } from './run-migrations.js';

const fsMocks = vi.hoisted(() => ({ readFailures: new Map(), realRename: null }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  fsMocks.realRename = actual.rename;
  return {
    ...actual,
    readFile: vi.fn(async (path, ...args) => {
      const failure = fsMocks.readFailures.get(String(path));
      if (failure) throw failure;
      return actual.readFile(path, ...args);
    }),
    rename: vi.fn((...args) => actual.rename(...args)),
  };
});

describe('runMigrations applied-list handling', () => {
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
    fsMocks.readFailures.clear();
    vi.mocked(fsPromises.rename).mockImplementation((...args) => fsMocks.realRename(...args));
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  const corruptSiblings = () =>
    readdirSync(dataDir).filter((f) => f.startsWith('migrations.applied.json.corrupt-'));

  it.each(['pending', 'missing', 'corrupt', 'applied'])('retires unsafe 428 with a %s ledger before earlier failures (#12398)', async state => {
    const retired = '428-prune-dangling-collection-images.js';
    // Exercise the shipped, frozen transform through the real runner. If the
    // retirement regresses it removes both kinds of unresolved image pointer.
    writeFileSync(join(migrationsDir, retired), `export { default } from ${JSON.stringify(new URL('./migrations/428-prune-dangling-collection-images.js', import.meta.url).href)};`);
    mkdirSync(join(dataDir, 'images'));
    const collectionDir = join(dataDir, 'media-collections', 'collection-example');
    mkdirSync(collectionDir, { recursive: true });
    const original = JSON.stringify({ items: [{ kind: 'image', ref: 'hosted.png' }, { kind: 'image', ref: 'temporarily-missing.png' }], coverKey: 'image:hosted.png', updatedAt: '2026-01-01T00:00:00Z' });
    writeFileSync(join(collectionDir, 'index.json'), original);
    writeFileSync(join(dataDir, 'peer-hosted-media.json'), JSON.stringify({ version: 1, entries: { 'image:hosted.png': { peerId: 'example-peer', at: '2026-01-01T00:00:00Z' } } }));
    if (state === 'pending') writeFileSync(appliedFile, '["000-earlier.js"]');
    if (state === 'corrupt') writeFileSync(appliedFile, '{broken');
    if (state === 'applied') writeFileSync(appliedFile, JSON.stringify([retired]));
    writeFileSync(join(migrationsDir, '002-failure.js'), 'export async function up() { throw new Error("fixture interruption"); }');
    if (state === 'missing' || state === 'corrupt') {
      writeFileSync(join(migrationsDir, '429-purge.js'), 'export const purge = true; export async function up() { throw new Error("purge must stay disarmed"); }');
    }
    await expect(runMigrations({ rootDir, migrationsDir })).rejects.toThrow('fixture interruption');
    expect(JSON.parse(readFileSync(appliedFile, 'utf8'))).toContain(retired);
    expect(readFileSync(join(collectionDir, 'index.json'), 'utf8')).toBe(original);
    // A retry with a now nonempty ledger cannot re-arm the retired transform.
    rmSync(join(migrationsDir, '002-failure.js'));
    expect(await runMigrations({ rootDir, migrationsDir })).toBe(0);
    expect(readFileSync(join(collectionDir, 'index.json'), 'utf8')).toBe(original);
    if (state !== 'applied') expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Retired migration 428'));
  });

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

  // A pre-2026-05-16 install upgraded by pull-and-restart reaches the boot
  // runner without setup-data.js ever moving its ledger.
  it('adopts a legacy data/migrations/.applied.json instead of re-running what it records', async () => {
    const legacyFile = join(dataDir, 'migrations', '.applied.json');
    mkdirSync(join(dataDir, 'migrations'));
    writeFileSync(legacyFile, JSON.stringify(['001-fixture.js']));

    const ran = await runMigrations({ rootDir, migrationsDir });

    expect(ran).toBe(0);
    expect(existsSync(join(dataDir, 'fixture-marker.txt'))).toBe(false);
    expect(existsSync(legacyFile)).toBe(false);
    expect(JSON.parse(readFileSync(appliedFile, 'utf-8'))).toEqual(['001-fixture.js']);
  });

  it('keeps the current ledger authoritative when a legacy one also exists', async () => {
    const legacyFile = join(dataDir, 'migrations', '.applied.json');
    mkdirSync(join(dataDir, 'migrations'));
    writeFileSync(legacyFile, '[]');
    writeFileSync(appliedFile, JSON.stringify(['001-fixture.js']));

    expect(await runMigrations({ rootDir, migrationsDir })).toBe(0);
    expect(readFileSync(legacyFile, 'utf-8')).toBe('[]');
  });

  it('rejects unreadable ledgers without running migrations or changing their bytes', async () => {
    const original = '["001-fixture.js"]\n';
    writeFileSync(appliedFile, original);
    fsMocks.readFailures.set(appliedFile, Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    await expect(runMigrations({ rootDir, migrationsDir })).rejects.toMatchObject({ code: 'EACCES' });

    expect(readFileSync(appliedFile, 'utf-8')).toBe(original);
    expect(existsSync(join(dataDir, 'fixture-marker.txt'))).toBe(false);
  });

  it('keeps listPendingMigrations tolerant of an unreadable ledger', async () => {
    const original = '["001-fixture.js"]\n';
    writeFileSync(appliedFile, original);
    fsMocks.readFailures.set(appliedFile, Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    await expect(listPendingMigrations({ rootDir, migrationsDir })).resolves.toEqual(['001-fixture.js']);

    expect(readFileSync(appliedFile, 'utf-8')).toBe(original);
    expect(corruptSiblings()).toHaveLength(0);
  });

  it('writes both the purge-disarm and migration ledger through temp-file renames', async () => {
    writeFileSync(appliedFile, '[]\n');
    writeFileSync(join(migrationsDir, '002-purge.js'), `
export default {
  purge: true,
  async up() { throw new Error('disarmed purge migration must not run'); }
};
`);

    const renameMock = vi.mocked(fsPromises.rename);
    const observations = [];
    renameMock.mockImplementation(async (source, destination) => {
      if (destination === appliedFile) {
        observations.push({
          source,
          targetBefore: readFileSync(destination, 'utf-8'),
          tempContents: readFileSync(source, 'utf-8'),
        });
      }
      return fsMocks.realRename(source, destination);
    });

    const ran = await runMigrations({ rootDir, migrationsDir });

    expect(ran).toBe(1);
    expect(observations).toHaveLength(2);
    for (const observation of observations) {
      expect(observation.source).toBe(`${appliedFile}.tmp-${process.pid}`);
      expect(Array.isArray(JSON.parse(observation.targetBefore))).toBe(true);
      expect(Array.isArray(JSON.parse(observation.tempContents))).toBe(true);
    }
    expect(JSON.parse(observations[0].tempContents)).toEqual(['002-purge.js']);
    expect(JSON.parse(observations[1].tempContents)).toEqual(['002-purge.js', '001-fixture.js']);
    expect(existsSync(`${appliedFile}.tmp-${process.pid}`)).toBe(false);
    expect(JSON.parse(readFileSync(appliedFile, 'utf-8'))).toEqual(['002-purge.js', '001-fixture.js']);
  });

  it('runs numbered migrations without importing helper, CLI or test modules', async () => {
    for (const file of ['_lib.js', 'shippedPromptHistory.js', 'check-shipped-prompt-history.js', '001-fixture.test.js']) {
      writeFileSync(join(migrationsDir, file), 'throw new Error("Non-migration module was imported");');
    }

    const ran = await runMigrations({ rootDir, migrationsDir });

    expect(ran).toBe(1); // only 001-fixture.js ran
    expect(JSON.parse(readFileSync(appliedFile, 'utf-8'))).toEqual(['001-fixture.js']);
    expect(existsSync(join(dataDir, 'fixture-marker.txt'))).toBe(true);
    await expect(listPendingMigrations({ rootDir, migrationsDir })).resolves.toEqual([]);
  });

  it('still rejects numbered modules without up() and leaves them pending', async () => {
    writeFileSync(join(migrationsDir, '002-invalid.js'), 'export const notAMigration = true;');

    await expect(runMigrations({ rootDir, migrationsDir }))
      .rejects.toThrow('Migration "002-invalid.js" does not export an up() function');

    expect(JSON.parse(readFileSync(appliedFile, 'utf-8'))).toEqual(['001-fixture.js']);
    await expect(listPendingMigrations({ rootDir, migrationsDir })).resolves.toEqual(['002-invalid.js']);
  });

  it('stops after the migration named by `through`, leaving later ones pending (#12813)', async () => {
    writeFileSync(join(migrationsDir, '002-bounded.js'), 'export default { up() {} };');
    writeFileSync(join(migrationsDir, '003-later.js'), 'throw new Error("A migration after the bound was imported");');

    await expect(runMigrations({ rootDir, migrationsDir, through: '002-bounded.js' })).resolves.toBe(2);

    expect(JSON.parse(readFileSync(appliedFile, 'utf-8'))).toEqual(['001-fixture.js', '002-bounded.js']);
    await expect(listPendingMigrations({ rootDir, migrationsDir })).resolves.toEqual(['003-later.js']);
    await expect(runMigrations({ rootDir, migrationsDir, through: '009-missing.js' }))
      .rejects.toThrow('Cannot run migrations through "009-missing.js"');
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

  it('disarms a pending purge migration without importing its module (#12049)', async () => {
    // A purge migration whose import graph cannot even load: the old probe
    // imported every pending module to read `purge`, which on a fresh install
    // pulled in dozens of live service graphs before boot. The static probe
    // must disarm it from the source text alone.
    writeFileSync(join(migrationsDir, '197-purge.js'), `
import { neverInstalled } from 'portos-missing-dependency-for-test';
export default {
  purge: true,
  async up() { neverInstalled(); }
};
`);

    const ran = await runMigrations({ rootDir, migrationsDir });

    expect(ran).toBe(0);
    expect(JSON.parse(readFileSync(appliedFile, 'utf-8'))).toEqual(['197-purge.js']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping purge migration'));
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

describe('runMigrations lock (#12046)', () => {
  let rootDir;
  let dataDir;
  let migrationsDir;
  let appliedFile;
  let lockDir;
  let warnSpy;
  let logSpy;

  // Deliberately NOT idempotent: every execution appends one byte, so a
  // double-apply shows up as a two-byte marker rather than hiding behind an
  // existsSync guard.
  const COUNTING_FIXTURE = `
import { appendFileSync } from 'fs';
import { join } from 'path';
export default {
  async up({ rootDir }) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    appendFileSync(join(rootDir, 'data', 'applied-count.txt'), 'x');
  }
};
`;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'run-migrations-lock-'));
    dataDir = join(rootDir, 'data');
    migrationsDir = join(rootDir, 'migrations');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(migrationsDir, { recursive: true });
    appliedFile = join(dataDir, 'migrations.applied.json');
    lockDir = join(dataDir, 'migrations.lock');
    writeFileSync(appliedFile, JSON.stringify(['000-earlier.js']) + '\n');
    writeFileSync(join(migrationsDir, '001-count.js'), COUNTING_FIXTURE);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  const appliedCount = () => (existsSync(join(dataDir, 'applied-count.txt'))
    ? readFileSync(join(dataDir, 'applied-count.txt'), 'utf-8').length
    : 0);

  it('two concurrent runs apply each pending migration exactly once', async () => {
    // The race: the manual `npm run migrations` and the booting server both
    // read the ledger before either persists it. The second runner must wait
    // for the first and then find nothing pending.
    const results = await Promise.all([
      runMigrations({ rootDir, migrationsDir }),
      runMigrations({ rootDir, migrationsDir }),
    ]);

    expect(results.sort()).toEqual([0, 1]);
    expect(appliedCount()).toBe(1);
    expect(JSON.parse(readFileSync(appliedFile, 'utf-8'))).toEqual(['000-earlier.js', '001-count.js']);
    expect(existsSync(lockDir)).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Waiting for another migration run'));
  });

  it('releases the lock when a migration throws', async () => {
    writeFileSync(join(migrationsDir, '002-throws.js'), 'export default { async up() { throw new Error("boom"); } };');

    await expect(runMigrations({ rootDir, migrationsDir })).rejects.toThrow('boom');

    expect(existsSync(lockDir)).toBe(false);
    // The retry reaches the migration again (rejecting with its error, not the
    // lock's) and does not re-apply 001, which the first run recorded.
    await expect(runMigrations({ rootDir, migrationsDir, lockWaitMs: 50, lockPollMs: 10 })).rejects.toThrow('boom');
    expect(appliedCount()).toBe(1);
  });

  it('waits on a lock whose owner file is empty (torn read) instead of throwing', async () => {
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'owner.json'), '');
    setTimeout(() => rmSync(lockDir, { recursive: true, force: true }), 40);

    const ran = await runMigrations({ rootDir, migrationsDir, lockWaitMs: 2000, lockPollMs: 10 });

    expect(ran).toBeTruthy();
    expect(appliedCount()).toBeGreaterThan(0);
  });

  it('gives up after the bounded wait while a live holder keeps the lock', async () => {
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

    await expect(runMigrations({ rootDir, migrationsDir, lockWaitMs: 60, lockPollMs: 10 }))
      .rejects.toThrow(/Another migration run \(pid \d+\) holds/);

    expect(appliedCount()).toBe(0);
    expect(JSON.parse(readFileSync(appliedFile, 'utf-8'))).toEqual(['000-earlier.js']);
    expect(existsSync(lockDir)).toBe(true); // never steals a live holder's lock
  });

  it('never expires a live holder, even after the stale timeout', async () => {
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() - 31 * 60 * 1000 }));

    await expect(runMigrations({ rootDir, migrationsDir, lockWaitMs: 0 }))
      .rejects.toThrow(/Another migration run/);

    expect(appliedCount()).toBe(0);
    expect(existsSync(lockDir)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('refuses an owner read failure instead of reclaiming an aged live lock', async () => {
    mkdirSync(lockDir);
    const ownerPath = join(lockDir, 'owner.json');
    const old = new Date(Date.now() - 31 * 60 * 1000);
    writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, startedAt: old.getTime() }));
    utimesSync(lockDir, old, old);
    fsMocks.readFailures.set(ownerPath, Object.assign(new Error('owner read failed'), { code: 'EIO' }));
    try {
      await expect(runMigrations({ rootDir, migrationsDir, lockWaitMs: 0 }))
        .rejects.toMatchObject({ code: 'EIO' });
      expect(appliedCount()).toBe(0);
      expect(existsSync(lockDir)).toBe(true);
    } finally {
      fsMocks.readFailures.clear();
    }
  });

  it('rechecks stale evidence before removing a replacement holder', async () => {
    mkdirSync(lockDir);
    const ownerPath = join(lockDir, 'owner.json');
    writeFileSync(ownerPath, JSON.stringify({ pid: 2147483646, startedAt: Date.now() }));
    const fixturePath = join(migrationsDir, '001-count.js');
    writeFileSync(fixturePath, `
import { appendFileSync } from 'fs';
import { join } from 'path';
let announceStart, announceDuplicate, release;
export const started = new Promise(resolve => { announceStart = resolve; });
export const duplicate = new Promise(resolve => { announceDuplicate = resolve; });
const finish = new Promise(resolve => { release = resolve; });
export { release };
export let entries = 0;
export default { async up({ rootDir }) {
  entries++;
  announceStart();
  if (entries > 1) announceDuplicate();
  await finish;
  appendFileSync(join(rootDir, 'data', 'applied-count.txt'), 'x');
} };
`);
    const fixture = await import(pathToFileURL(fixturePath).href);
    const readFile = vi.mocked(fsPromises.readFile);
    const originalRead = readFile.getMockImplementation();
    let announceRead, resumeRead;
    const readStarted = new Promise(resolve => { announceRead = resolve; });
    const resume = new Promise(resolve => { resumeRead = resolve; });
    let paused = false;
    readFile.mockImplementation(async (path, ...args) => {
      const raw = await originalRead(path, ...args);
      if (String(path) === ownerPath && !paused) {
        paused = true;
        announceRead();
        await resume;
      }
      return raw;
    });
    const staleRun = runMigrations({ rootDir, migrationsDir, lockWaitMs: 0 });
    const staleResult = staleRun.then(value => ({ value }), error => ({ error }));
    let holder;
    try {
      await readStarted;
      holder = runMigrations({ rootDir, migrationsDir, lockWaitMs: 0 });
      await fixture.started;
      resumeRead();
      await Promise.race([staleResult, fixture.duplicate]);
    } finally {
      resumeRead();
      fixture.release();
      await Promise.allSettled([staleRun, holder]);
      readFile.mockImplementation(originalRead);
    }

    expect(fixture.entries).toBe(1);
    expect((await staleResult).error?.message).toMatch(/Another migration run/);
    expect(appliedCount()).toBe(1);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('reclaims a lock whose holder process is gone', async () => {
    mkdirSync(lockDir);
    // Above every platform's pid ceiling, so the liveness probe reports ESRCH.
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 2147483646, startedAt: Date.now() }));
    // The dead holder was killed mid ledger write: its temp file never renamed.
    const orphanTmp = `${appliedFile}.tmp-2147483646`;
    writeFileSync(orphanTmp, '["000-earlier.js"');
    // A live process's temp file may be mid-write (a lock reclaimed by age).
    const liveTmp = `${appliedFile}.tmp-${process.ppid}`;
    writeFileSync(liveTmp, '["000-earlier.js"]');

    const ran = await runMigrations({ rootDir, migrationsDir, lockWaitMs: 60, lockPollMs: 10 });

    expect(ran).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no longer running'));
    expect(existsSync(lockDir)).toBe(false);
    expect(existsSync(orphanTmp)).toBe(false);
    expect(existsSync(liveTmp)).toBe(true);
  });

  it('reclaims a lock held past the stale timeout even when its pid is unknown', async () => {
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ startedAt: Date.now() - 31 * 60 * 1000 }));

    const ran = await runMigrations({ rootDir, migrationsDir, lockWaitMs: 60, lockPollMs: 10 });

    expect(ran).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('held for over 30 minutes'));
  });

  it('recovers an old ownerless acquisition using its age before the transition mkdir', async () => {
    mkdirSync(lockDir);
    const old = new Date(Date.now() - 31 * 60 * 1000);
    utimesSync(lockDir, old, old);

    expect(await runMigrations({ rootDir, migrationsDir, lockWaitMs: 0 })).toBe(1);
    expect(appliedCount()).toBe(1);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('keeps an interrupted transition closed instead of racing its recovery', async () => {
    mkdirSync(join(lockDir, '.transition'), { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 2147483646, startedAt: Date.now() }));

    await expect(runMigrations({ rootDir, migrationsDir, lockWaitMs: 0 }))
      .rejects.toThrow(/interrupted .transition/);
    expect(appliedCount()).toBe(0);
    expect(existsSync(join(lockDir, '.transition'))).toBe(true);
  });
});

describe('sourceDeclaresPurge', () => {
  it('reads the marker from the default export or a named export', () => {
    expect(sourceDeclaresPurge('export default {\n  purge: true,\n  async up() {}\n};\n')).toBe(true);
    expect(sourceDeclaresPurge('export default {\n  purge: true\n};\n')).toBe(true);
    expect(sourceDeclaresPurge('export const purge = true;\nexport async function up() {}\n')).toBe(true);
  });

  it('ignores prose, data literals and other flags', () => {
    expect(sourceDeclaresPurge('/*\n * opts into the purge class (purge: true)\n */\nexport default { async up() {} };')).toBe(false);
    expect(sourceDeclaresPurge('// purge: true\nexport default { async up() {} };')).toBe(false);
    expect(sourceDeclaresPurge('const SEED = {\n  retention: {\n    purge: true,\n  },\n};\nexport default { async up() {} };')).toBe(false);
    expect(sourceDeclaresPurge('export default {\n  autoPurge: true,\n  purge: false,\n  async up() {}\n};')).toBe(false);
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

  it('excludes tests and unnumbered helper or CLI modules', async () => {
    for (const file of ['001-a.test.js', '_lib.js', 'shippedPromptHistory.js', 'check-shipped-prompt-history.js']) {
      writeFileSync(join(migrationsDir, file), 'throw new Error("Pending discovery must not import modules");');
    }
    const pending = await listPendingMigrations({ rootDir, migrationsDir });
    expect(pending).toEqual(['001-a.js', '002-b.js', '003-c.js']);
  });

  it('reads a legacy ledger the next run will adopt, without moving it', async () => {
    const legacyFile = join(dataDir, 'migrations', '.applied.json');
    mkdirSync(join(dataDir, 'migrations'));
    writeFileSync(legacyFile, JSON.stringify(['001-a.js']));
    const pending = await listPendingMigrations({ rootDir, migrationsDir });
    expect(pending).toEqual(['002-b.js', '003-c.js']);
    expect(existsSync(legacyFile)).toBe(true);
    expect(existsSync(appliedFile)).toBe(false);
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

describe('runMigrations record-split retry after source repair (#9557)', () => {
  let rootDir;
  let migrationsDir;
  let appliedFile;
  let sourcePath;
  const realMigration = new URL('./migrations/035-split-pipeline-issues-to-per-id.js', import.meta.url).href;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'run-migrations-split-'));
    migrationsDir = join(rootDir, 'migrations');
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    mkdirSync(migrationsDir, { recursive: true });
    appliedFile = join(rootDir, 'data', 'migrations.applied.json');
    sourcePath = join(rootDir, 'data', 'pipeline-issues.json');
    // A non-empty ledger so the empty-ledger purge guard stays out of the way.
    writeFileSync(appliedFile, JSON.stringify(['000-earlier.js']) + '\n');
    writeFileSync(join(migrationsDir, '035-wrapper.js'), `export { default } from ${JSON.stringify(realMigration)};\n`);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('leaves a corrupt-source split pending, then splits and stamps it after repair', async () => {
    const recordIndex = join(rootDir, 'data', 'pipeline-issues', 'iss-example', 'index.json');
    writeFileSync(sourcePath, '{"issues": [');

    await expect(runMigrations({ rootDir, migrationsDir })).rejects.toThrow(/unreadable/);
    expect(JSON.parse(readFileSync(appliedFile, 'utf-8'))).toEqual(['000-earlier.js']);

    writeFileSync(sourcePath, JSON.stringify({ issues: [{ id: 'iss-example', title: 'Example' }] }));
    expect(await runMigrations({ rootDir, migrationsDir })).toBe(1);
    expect(existsSync(recordIndex)).toBe(true);
    expect(JSON.parse(readFileSync(appliedFile, 'utf-8'))).toEqual(['000-earlier.js', '035-wrapper.js']);

    expect(await runMigrations({ rootDir, migrationsDir })).toBe(0);
  });
});
