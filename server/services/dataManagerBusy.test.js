/**
 * Live-work probes behind the Data Manager's CATEGORY_BUSY refusal (#3342).
 *
 * Every case injects its state — a job list, or a control dir under a throwaway
 * temp root — so nothing here reads the live media-job queue or the install's
 * real `data/` directory.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { imageCleanTmpBusy, trainingRunsBusy, updateDetachedBusy } from './dataManagerBusy.js';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'datamanager-busy-test-'));
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

const imageJob = (overrides = {}) => ({
  id: 'job-0001',
  kind: 'image',
  status: 'running',
  params: { initImagePath: 'image-clean-tmp/init-00000000-0000-4000-8000-000000000000.png' },
  ...overrides,
});

const trainingJob = (overrides = {}) => ({ id: 'job-0002', kind: 'training', status: 'running', ...overrides });

describe('imageCleanTmpBusy', () => {
  it('is idle when no image job is in flight', async () => {
    await expect(imageCleanTmpBusy({ jobs: [] })).resolves.toEqual({ busy: false, reason: null });
  });

  it('is idle when every image job has reached a terminal state', async () => {
    const jobs = [imageJob({ status: 'completed' }), imageJob({ id: 'job-0003', status: 'failed' })];
    await expect(imageCleanTmpBusy({ jobs })).resolves.toEqual({ busy: false, reason: null });
  });

  it('reports busy for a queued job whose init image has not been read yet', async () => {
    const { busy, reason } = await imageCleanTmpBusy({ jobs: [imageJob({ status: 'queued' })] });
    expect(busy).toBe(true);
    expect(reason).toMatch(/queued or running/);
  });

  // The purge must never be more permissive than the GC sweep, which spares
  // exactly the basenames `collectActiveCleanBasenames` pins.
  it('reports busy for a running job even with no initImagePath — its side files are still pinned', async () => {
    const { busy } = await imageCleanTmpBusy({ jobs: [imageJob({ params: {} })] });
    expect(busy).toBe(true);
  });

  it('ignores jobs of other kinds', async () => {
    await expect(imageCleanTmpBusy({ jobs: [trainingJob()] })).resolves.toEqual({ busy: false, reason: null });
  });
});

describe('trainingRunsBusy', () => {
  it('is idle when no training job is in flight', async () => {
    await expect(trainingRunsBusy({ jobs: [] })).resolves.toEqual({ busy: false, reason: null });
  });

  it('is idle once every run has finished', async () => {
    const jobs = [trainingJob({ status: 'completed' }), trainingJob({ id: 'job-0004', status: 'canceled' })];
    await expect(trainingRunsBusy({ jobs })).resolves.toEqual({ busy: false, reason: null });
  });

  it.each(['queued', 'running'])('reports busy for a %s run and counts it', async (status) => {
    const { busy, reason } = await trainingRunsBusy({ jobs: [trainingJob({ status })] });
    expect(busy).toBe(true);
    expect(reason).toMatch(/^1 LoRA training run/);
  });

  it('survives a non-array job list instead of throwing into the fail-closed path', async () => {
    await expect(trainingRunsBusy({ jobs: null })).resolves.toBeTruthy();
  });
});

describe('updateDetachedBusy', () => {
  const controlDir = (name) => {
    const dir = join(TEST_ROOT, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  it('is idle when there is no control dir at all', async () => {
    await expect(updateDetachedBusy({ controlDir: join(TEST_ROOT, 'never-created') }))
      .resolves.toEqual({ busy: false, reason: null });
  });

  it('is idle once the script has written its exit status', async () => {
    const dir = controlDir('finished');
    writeFileSync(join(dir, 'pid'), String(process.pid));
    writeFileSync(join(dir, 'exit'), '0');
    await expect(updateDetachedBusy({ controlDir: dir })).resolves.toEqual({ busy: false, reason: null });
  });

  it('reports busy while a live pid has not exited', async () => {
    const dir = controlDir('running');
    writeFileSync(join(dir, 'pid'), String(process.pid));
    const { busy, reason } = await updateDetachedBusy({ controlDir: dir });
    expect(busy).toBe(true);
    expect(reason).toMatch(/self-update is running/);
  });
});
