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

const INIT_NAME = 'init-00000000-0000-4000-8000-000000000000.png';

describe('imageCleanTmpBusy', () => {
  it('is idle when no image job is in flight', async () => {
    await expect(imageCleanTmpBusy({ jobs: [], entries: [INIT_NAME] })).resolves.toEqual({ busy: false, reason: null });
  });

  it('is idle when every image job has reached a terminal state', async () => {
    const jobs = [imageJob({ status: 'completed' }), imageJob({ id: 'job-0003', status: 'failed' })];
    await expect(imageCleanTmpBusy({ jobs, entries: [INIT_NAME] })).resolves.toEqual({ busy: false, reason: null });
  });

  it('reports busy for a queued job whose init image has not been read yet', async () => {
    const { busy, reason } = await imageCleanTmpBusy({ jobs: [imageJob({ status: 'queued' })], entries: [INIT_NAME] });
    expect(busy).toBe(true);
    expect(reason).toMatch(/queued or running/);
  });

  // The purge must never be more permissive than the GC sweep, which spares
  // exactly the basenames `collectActiveCleanBasenames` pins.
  it('reports busy on a pinned side file even when the job names no initImagePath', async () => {
    const { busy } = await imageCleanTmpBusy({ jobs: [imageJob({ params: {} })], entries: ['job-0001-mask.png'] });
    expect(busy).toBe(true);
  });

  // The pinned set covers every in-flight image job because clean side files are
  // keyed by job id — an unrelated gallery render must not lock the directory.
  it('is idle when nothing an in-flight job pins is actually in the directory', async () => {
    const { busy } = await imageCleanTmpBusy({
      jobs: [imageJob({ id: 'gallery-render', params: {} })],
      entries: ['init-11111111-1111-4111-8111-111111111111.png', 'stale-0002.png'],
    });
    expect(busy).toBe(false);
  });

  it('is idle when the directory is empty', async () => {
    await expect(imageCleanTmpBusy({ jobs: [imageJob()], entries: [] })).resolves.toEqual({ busy: false, reason: null });
  });

  it('ignores jobs of other kinds', async () => {
    await expect(imageCleanTmpBusy({ jobs: [trainingJob()], entries: [INIT_NAME] })).resolves.toEqual({ busy: false, reason: null });
  });
});

const controlDir = (...segments) => {
  const dir = join(TEST_ROOT, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe('trainingRunsBusy', () => {
  const emptyRunsDir = () => controlDir('runs-empty');

  it('is idle when no training job is in flight', async () => {
    await expect(trainingRunsBusy({ jobs: [], runsDir: emptyRunsDir() })).resolves.toEqual({ busy: false, reason: null });
  });

  it('is idle once every run has finished', async () => {
    const jobs = [trainingJob({ status: 'completed' }), trainingJob({ id: 'job-0004', status: 'canceled' })];
    await expect(trainingRunsBusy({ jobs, runsDir: emptyRunsDir() })).resolves.toEqual({ busy: false, reason: null });
  });

  it.each(['queued', 'running'])('reports busy for a %s run and counts it', async (status) => {
    const { busy, reason } = await trainingRunsBusy({ jobs: [trainingJob({ status })], runsDir: emptyRunsDir() });
    expect(busy).toBe(true);
    expect(reason).toMatch(/^1 LoRA training run/);
  });

  it('survives a non-array job list instead of throwing into the fail-closed path', async () => {
    await expect(trainingRunsBusy({ jobs: null, runsDir: emptyRunsDir() })).resolves.toBeTruthy();
  });

  it('is idle when a runs directory holds only finished runs', async () => {
    const runsDir = controlDir('runs-finished');
    const detached = controlDir('runs-finished', 'run-0001', '.detached');
    writeFileSync(join(detached, 'pid'), String(process.pid));
    writeFileSync(join(detached, 'exit'), '0');
    await expect(trainingRunsBusy({ jobs: [], runsDir })).resolves.toEqual({ busy: false, reason: null });
  });

  // A trainer is a detached child that outlives a pm2 restart, so between
  // accepting requests and the boot reconcile it has no queue job at all.
  it('reports busy for a trainer that outlived a restart and has no queue job', async () => {
    const runsDir = controlDir('runs-surviving');
    controlDir('runs-surviving', 'run-0001');
    const detached = controlDir('runs-surviving', 'run-0002', '.detached');
    writeFileSync(join(detached, 'pid'), String(process.pid));
    const { busy, reason } = await trainingRunsBusy({ jobs: [], runsDir });
    expect(busy).toBe(true);
    expect(reason).toMatch(/outlived a restart/);
  });

  it('is idle when the runs directory does not exist at all', async () => {
    await expect(trainingRunsBusy({ jobs: [], runsDir: join(TEST_ROOT, 'runs-missing') }))
      .resolves.toEqual({ busy: false, reason: null });
  });
});

describe('updateDetachedBusy', () => {

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
