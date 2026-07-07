import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sweepImageCleanTmp, CLEAN_TMP_MAX_AGE_MS } from './imageCleanTmpGc.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'portos-cleantmp-gc-test-'));
});

afterAll(() => {
  // beforeEach makes a fresh dir per test; clean the last one.
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// Write a file and backdate its mtime by `ageMs` so the age-gate sees it as old.
const writeAged = (name, ageMs) => {
  const p = join(dir, name);
  writeFileSync(p, 'x');
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(p, when, when);
  }
  return p;
};

describe('sweepImageCleanTmp', () => {
  it('all-zero on a missing dir', async () => {
    const res = await sweepImageCleanTmp({ tmpDir: join(dir, 'nope') });
    expect(res).toEqual({ deleted: 0, keptYoung: 0 });
  });

  it('deletes files older than the grace window', async () => {
    const old = writeAged('11111111-1111-4111-8111-111111111111.png', CLEAN_TMP_MAX_AGE_MS + 60_000);
    const res = await sweepImageCleanTmp({ tmpDir: dir });
    expect(res.deleted).toBe(1);
    expect(existsSync(old)).toBe(false);
  });

  it('spares files younger than the grace window (an in-flight render)', async () => {
    const fresh = writeAged('init-abc.png', 0);
    const res = await sweepImageCleanTmp({ tmpDir: dir });
    expect(res.deleted).toBe(0);
    expect(res.keptYoung).toBe(1);
    expect(existsSync(fresh)).toBe(true);
  });

  it('sweeps every kind of temp working file (init/render/mask/original/json)', async () => {
    const age = CLEAN_TMP_MAX_AGE_MS + 60_000;
    const names = [
      'init-xyz.png',
      '22222222-2222-4222-8222-222222222222.png',
      '22222222-2222-4222-8222-222222222222-mask.png',
      '22222222-2222-4222-8222-222222222222-original.png',
      '22222222-2222-4222-8222-222222222222-clean.json',
    ];
    names.forEach((n) => writeAged(n, age));
    const res = await sweepImageCleanTmp({ tmpDir: dir });
    expect(res.deleted).toBe(names.length);
  });
});
