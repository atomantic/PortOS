import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sweepImageCleanTmp, collectActiveCleanBasenames, CLEAN_TMP_MAX_AGE_MS } from './imageCleanTmpGc.js';

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
    const res = await sweepImageCleanTmp({ tmpDir: join(dir, 'nope'), activeJobs: [] });
    expect(res.deleted).toBe(0);
    expect(res.keptYoung).toBe(0);
  });

  it('deletes files older than the grace window', async () => {
    const old = writeAged('11111111-1111-4111-8111-111111111111.png', CLEAN_TMP_MAX_AGE_MS + 60_000);
    const res = await sweepImageCleanTmp({ tmpDir: dir, activeJobs: [] });
    expect(res.deleted).toBe(1);
    expect(existsSync(old)).toBe(false);
  });

  it('spares files younger than the grace window (an in-flight render)', async () => {
    const fresh = writeAged('init-abc.png', 0);
    const res = await sweepImageCleanTmp({ tmpDir: dir, activeJobs: [] });
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
    const res = await sweepImageCleanTmp({ tmpDir: dir, activeJobs: [] });
    expect(res.deleted).toBe(names.length);
  });

  it('never sweeps files pinned by a still-queued job, even past the grace window', async () => {
    const age = CLEAN_TMP_MAX_AGE_MS + 60_000;
    const jobId = '33333333-3333-4333-8333-333333333333';
    const init = 'init-pinned.png';
    // Old files, but a queued job still depends on its init + side files.
    writeAged(init, age);
    writeAged(`${jobId}-mask.png`, age);
    writeAged(`${jobId}-clean.json`, age);
    // An unrelated old file should still be swept.
    const stray = writeAged('44444444-4444-4444-8444-444444444444.png', age);
    const jobs = [{
      id: jobId,
      kind: 'image',
      status: 'queued',
      params: { initImagePath: `/data/image-clean-tmp/${init}` },
    }];
    const res = await sweepImageCleanTmp({ tmpDir: dir, activeJobs: jobs });
    expect(res.keptActive).toBe(3);
    expect(res.deleted).toBe(1);
    expect(existsSync(join(dir, init))).toBe(true);
    expect(existsSync(stray)).toBe(false);
  });
});

describe('collectActiveCleanBasenames', () => {
  it('keeps init + jobId side files for queued/running jobs only', () => {
    const jobs = [
      { id: 'a', kind: 'image', status: 'queued', params: { initImagePath: '/x/image-clean-tmp/init-a.png' } },
      { id: 'b', kind: 'image', status: 'running', params: {} },
      { id: 'c', kind: 'image', status: 'completed', params: { initImagePath: '/x/init-c.png' } },
      { id: 'd', kind: 'video', status: 'queued', params: {} },
    ];
    const keep = collectActiveCleanBasenames(jobs);
    expect(keep.has('init-a.png')).toBe(true);
    expect(keep.has('a.png')).toBe(true);
    expect(keep.has('b-mask.png')).toBe(true);
    // Completed + non-image jobs pin nothing.
    expect(keep.has('init-c.png')).toBe(false);
    expect(keep.has('c.png')).toBe(false);
    expect(keep.has('d.png')).toBe(false);
  });

  it('tolerates a non-array / empty input', () => {
    expect(collectActiveCleanBasenames(null).size).toBe(0);
    expect(collectActiveCleanBasenames([]).size).toBe(0);
  });
});
