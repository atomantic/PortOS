/**
 * The publication contract, against a REAL temp directory.
 *
 * The gate arithmetic is covered by `autoSkinReport.test.js`; what is tested here is
 * the half that only a filesystem can prove: that a collision refuses instead of
 * overwriting, that an aborted run publishes NEITHER artifact, and that a reader
 * rejects a pair whose digest disagrees. Those are the three failure modes the whole
 * "GLB first, report last, no-replace move" design exists to make detectable.
 *
 * Blender is not installed on CI (or on most dev hosts), so the worker is a fake that
 * writes the files a real one would. That is the point of the design: the contract is
 * about what lands on disk, not about what Blender did.
 */

import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../imageTo3d/db.js', () => ({ getModel: vi.fn(), mutateModel: vi.fn() }));

const { AUTO_SKIN_DEFAULTS, thresholdsForWorker } = await import('./autoSkinReport.js');
const {
  publishRigArtifacts, readRiggedArtifact, rigRunPaths, runAutoSkin, RIGGED_GLB_NAME, RIG_REPORT_NAME,
} = await import('./autoSkin.js');

const READY = { ready: true, reason: null, interpreter: '/opt/envs/rigging/bin/python' };

const cleanReport = () => ({
  report_version: 1,
  thresholds: thresholdsForWorker(AUTO_SKIN_DEFAULTS),
  vertices: { before_weld: 30_000, after_weld: 10_000, welded: 20_000 },
  removed_components: { count: 1, vertices: 4, fraction: 0.0004 },
  weighting: {
    after_heat: { weighted: 9_990, unweighted: 10, unweighted_fraction: 0.001 },
    nearest_bone_completed: 10,
    after_fill: { weighted: 10_000, unweighted: 0, unweighted_fraction: 0 },
  },
  armature: { name: 'PortOSHumanoid', bone_count: 17, bones: [] },
  round_trip: { mesh: true, armature: true, armature_modifier: true },
});

/**
 * A worker stand-in: writes whatever the case wants on disk, then exits with `code`.
 * `child.on('close')` fires on a later tick, exactly as a real spawn does.
 */
const fakeWorker = ({ code = 0, write }) => (_python, args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const jobFile = args[args.indexOf('--job') + 1];
  Promise.resolve()
    .then(async () => {
      const job = JSON.parse(await readFile(jobFile, 'utf8'));
      if (write) await write(job);
    })
    .then(() => child.emit('close', code), (error) => child.emit('error', error));
  return child;
};

const publishCleanRig = (report = cleanReport()) => fakeWorker({
  write: async (job) => {
    await writeFile(job.output_glb, 'rigged-glb-bytes');
    await writeFile(job.report_path, JSON.stringify(report));
  },
});

describe('rigging publication contract', () => {
  let dir;
  let recordDir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'portos-rig-'));
    recordDir = join(dir, 'image3d-example');
    await mkdir(recordDir, { recursive: true });
    await writeFile(join(recordDir, 'model.glb'), 'source-mesh');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const run = (overrides = {}) => runAutoSkin({
    modelId: 'image3d-example', recordDir, readiness: READY, rigId: 'rig-example', ...overrides,
  });

  it('publishes a matched pair whose report carries the GLB digest, and never touches the source', async () => {
    const result = await run({ spawnImpl: publishCleanRig() });
    const paths = rigRunPaths({ recordDir, rigId: 'rig-example' });

    const report = JSON.parse(await readFile(paths.publishedReport, 'utf8'));
    expect(report.output_file).toBe(RIGGED_GLB_NAME);
    expect(report.output_sha256).toBe(result.sha256);
    expect(await readRiggedArtifact({ publishDir: paths.publishDir })).toMatchObject({ ok: true });
    expect(result.assetPath).toBe(`/data/image-to-3d/image3d-example/rig/rig-example/${RIGGED_GLB_NAME}`);
    expect(await readFile(join(recordDir, 'model.glb'), 'utf8')).toBe('source-mesh');
    // The staging directory is scratch and must not survive a completed run.
    expect(existsSync(paths.stageDir)).toBe(false);
  });

  it('refuses a name collision rather than overwriting a published rig', async () => {
    const paths = rigRunPaths({ recordDir, rigId: 'rig-example' });
    await mkdir(paths.publishDir, { recursive: true });
    await writeFile(paths.publishedGlb, 'an-earlier-rig');

    await expect(run({ spawnImpl: publishCleanRig() })).rejects.toMatchObject({ code: 'MOVE_DEST_EXISTS' });
    expect(await readFile(paths.publishedGlb, 'utf8')).toBe('an-earlier-rig');
  });

  it('publishes NEITHER artifact when the gate refuses the run', async () => {
    const failing = cleanReport();
    failing.weighting.after_heat = { weighted: 9_580, unweighted: 420, unweighted_fraction: 0.042 };
    const spawnImpl = fakeWorker({
      code: 2,
      write: async (job) => { await writeFile(job.report_path, JSON.stringify(failing)); },
    });

    await expect(run({ spawnImpl })).rejects.toThrow(
      /automatic weighting left 4\.2% of 10000 vertices unweighted, ceiling is 0\.5%/,
    );
    const paths = rigRunPaths({ recordDir, rigId: 'rig-example' });
    expect(existsSync(paths.publishedGlb)).toBe(false);
    expect(existsSync(paths.publishedReport)).toBe(false);
    expect(existsSync(paths.stageDir)).toBe(false);
  });

  it('refuses to record a rig whose published pair does not read back', async () => {
    // The publish itself succeeded, but the pair does not verify — the exact state an
    // interrupted rig leaves behind. Reporting that as ready would defeat the digest.
    await expect(run({
      spawnImpl: publishCleanRig(),
      verify: async () => ({ ok: false, reason: 'digest-mismatch' }),
    })).rejects.toMatchObject({ code: 'RIGGING_PUBLISH_UNVERIFIED' });
  });

  it('reports the worker exit when it produced no readable report at all', async () => {
    const spawnImpl = fakeWorker({ code: 3, write: async () => {} });
    await expect(run({ spawnImpl })).rejects.toMatchObject({ code: 'RIGGING_WORKER_FAILED' });
  });

  it('refuses to run at all when the Blender runtime is not ready', async () => {
    await expect(run({ readiness: { ready: false, reason: 'module-unimportable' }, spawnImpl: publishCleanRig() }))
      .rejects.toMatchObject({ code: 'RIGGING_RUNTIME_UNAVAILABLE', status: 409 });
  });
});

describe('published rig reader', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'portos-rig-read-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const stage = async (rigId) => {
    const recordDir = join(dir, 'image3d-example');
    const paths = rigRunPaths({ recordDir, rigId });
    await mkdir(paths.stageDir, { recursive: true });
    await writeFile(paths.stagedGlb, 'rigged-glb-bytes');
    return { recordDir, paths };
  };

  it('rejects a report whose digest disagrees with the GLB on disk', async () => {
    const { paths } = await stage('rig-digest');
    await publishRigArtifacts({ paths, report: cleanReport() });
    // Simulate the file changing under a published report — the pair is no longer the
    // one the digest describes, so it must not load as a finished rig.
    await writeFile(paths.publishedGlb, 'different-bytes');
    expect(await readRiggedArtifact({ publishDir: paths.publishDir }))
      .toEqual({ ok: false, reason: 'digest-mismatch' });
  });

  it('rejects a half-published pair in either direction', async () => {
    const { paths } = await stage('rig-half');
    await publishRigArtifacts({ paths, report: cleanReport() });

    await rm(paths.publishedGlb);
    expect(await readRiggedArtifact({ publishDir: paths.publishDir }))
      .toEqual({ ok: false, reason: 'missing-glb' });

    await writeFile(paths.publishedGlb, 'rigged-glb-bytes');
    await rm(join(paths.publishDir, RIG_REPORT_NAME));
    expect(await readRiggedArtifact({ publishDir: paths.publishDir }))
      .toEqual({ ok: false, reason: 'missing-report' });
  });
});
