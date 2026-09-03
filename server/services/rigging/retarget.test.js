/**
 * The retarget orchestration contract, against a REAL temp directory.
 *
 * The gate arithmetic is covered by `retargetReport.test.js`; what is tested here is the
 * half only a filesystem and a two-pass spawn can prove:
 *
 *  - a partial skeleton is refused after the read-only PROBE pass, so the apply pass —
 *    the only one that can write a file — is never spawned at all;
 *  - a run that fails its gate publishes NEITHER artifact and leaves no staging behind;
 *  - the published pair is the animated GLB named by its own report, read back through
 *    the same reader every consumer uses;
 *  - the source rig is opened read-only and never rewritten.
 *
 * Blender is not installed on CI (or on most dev hosts), so the worker is a fake that
 * writes the files a real one would and records which passes it was asked for. That is
 * the point of the design: the contract is about what lands on disk and in what order,
 * not about what Blender did.
 */

import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../imageTo3d/db.js', () => ({ getModel: vi.fn(), mutateModel: vi.fn() }));

const { publishRigArtifacts, readRiggedArtifact, rigRunPaths } = await import('./autoSkin.js');
const { RETARGET_DEFAULTS, thresholdsForRetargetWorker } = await import('./retargetReport.js');
const { retargetRunPaths, runRetarget, RETARGETED_GLB_NAME, selectClip } = await import('./retarget.js');
const { SKELETON_BONE_MAPPINGS } = await import('./skeletonMapping.js');

const READY = { ready: true, reason: null, interpreter: '/opt/envs/rigging/bin/python' };
const RIG_ID = 'rig-example';
const RETARGET_ID = 'retarget-example';
const MIXAMO_BONES = Object.values(SKELETON_BONE_MAPPINGS.mixamo);

const cleanProbe = (overrides = {}) => ({
  clips: [{ name: 'Walk', duration: 1.25 }],
  clip_bones: MIXAMO_BONES,
  rig_bones: MIXAMO_BONES,
  vertices: 10_000,
  ...overrides,
});

const cleanReport = (overrides = {}) => ({
  report_version: 1,
  kind: 'retarget',
  thresholds: thresholdsForRetargetWorker(RETARGET_DEFAULTS),
  skeleton: { hint: 'mixamo', mapped_bones: MIXAMO_BONES.length, unmapped_bones: [] },
  vertices: { total: 10_000 },
  head_cleanup: {
    mode: 'diagnostic', zone_bones: ['mixamorig:Neck', 'mixamorig:Head'],
    proposed_vertices: 40, changed_vertices: 0, cap_vertices: 200,
  },
  clip: { name: 'Walk', duration: 1.25 },
  motion: { sampled_frames: 8, max_joint_translation: 0.043 },
  armature: { name: 'PortOSHumanoid', bone_count: 17, bones: [] },
  round_trip: {
    mesh: true, armature: true, armature_modifier: true,
    animation_count: 1, clip_name: 'Walk', clip_duration: 1.25,
  },
  ...overrides,
});

/**
 * A two-pass worker stand-in. Records every pass it was asked for, writes what the case
 * wants, and exits with the per-pass code. `child.on('close')` fires on a later tick,
 * exactly as a real spawn does.
 */
const fakeWorker = ({ probe, report, applyCode = 0, probeCode = 0, passes }) => (_python, args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const jobFile = args[args.indexOf('--job') + 1];
  Promise.resolve()
    .then(async () => {
      const job = JSON.parse(await readFile(jobFile, 'utf8'));
      passes?.push(job.pass);
      if (job.pass === 'probe') {
        if (probe) await writeFile(job.report_path, JSON.stringify(probe));
        return probeCode;
      }
      if (report) await writeFile(job.report_path, JSON.stringify(report));
      // A real worker exports only when its own checks pass; a gate-failing report comes
      // with no GLB, which is what makes "published NEITHER" observable.
      if (applyCode === 0) await writeFile(job.output_glb, 'animated-glb-bytes');
      return applyCode;
    })
    .then((code) => child.emit('close', code), (error) => child.emit('error', error));
  return child;
};

describe('retarget orchestration contract', () => {
  let dir;
  let recordDir;
  let clipPath;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'portos-retarget-'));
    recordDir = join(dir, 'image3d-example');
    clipPath = join(dir, 'walk.glb');
    await mkdir(recordDir, { recursive: true });
    await writeFile(clipPath, 'clip-glb-bytes');

    // A real published rig for the run to read: staged and published through the same
    // helper the auto-skin lane uses, so its digest is genuine.
    const rigPaths = rigRunPaths({ recordDir, rigId: RIG_ID });
    await mkdir(rigPaths.stageDir, { recursive: true });
    await writeFile(rigPaths.stagedGlb, 'rigged-glb-bytes');
    await publishRigArtifacts({ paths: rigPaths, report: { armature: { bone_count: 17 } } });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const run = (overrides = {}) => runRetarget({
    modelId: 'image3d-example',
    recordDir,
    rigId: RIG_ID,
    clipPath,
    readiness: READY,
    retargetId: RETARGET_ID,
    ...overrides,
  });

  it('publishes the animated pair, names it in its own report, and never touches the rig', async () => {
    const passes = [];
    const result = await run({ spawnImpl: fakeWorker({ probe: cleanProbe(), report: cleanReport(), passes }) });
    const paths = retargetRunPaths({ recordDir, retargetId: RETARGET_ID });

    expect(passes).toEqual(['probe', 'apply']);
    const report = JSON.parse(await readFile(paths.publishedReport, 'utf8'));
    expect(report.output_file).toBe(RETARGETED_GLB_NAME);
    expect(report.output_sha256).toBe(result.sha256);
    expect(report).toMatchObject({ kind: 'retarget', source_rig_id: RIG_ID, source_clip: 'walk.glb' });
    // The same reader every consumer uses resolves the animated GLB from that key.
    expect(await readRiggedArtifact({ publishDir: paths.publishDir })).toMatchObject({ ok: true });
    expect(result.assetPath)
      .toBe(`/data/image-to-3d/image3d-example/retarget/${RETARGET_ID}/${RETARGETED_GLB_NAME}`);
    expect(result.summary).toMatchObject({ clip: 'Walk', mode: 'diagnostic', changedCleanupVertices: 0 });

    const rigPaths = rigRunPaths({ recordDir, rigId: RIG_ID });
    expect(await readFile(rigPaths.publishedGlb, 'utf8')).toBe('rigged-glb-bytes');
    expect(existsSync(paths.stageDir)).toBe(false);
  });

  it('refuses a partial skeleton after the probe, without ever spawning the apply pass', async () => {
    // The clip animates a finger the humanoid armature does not have — the all-or-nothing
    // mapping contract from `skeletonMapping.js`. Nothing may be written on this path:
    // the apply pass is the only one that can export, so it must not run at all.
    const passes = [];
    const probe = cleanProbe({ clip_bones: [...MIXAMO_BONES, 'mixamorig:LeftHandThumb1'] });
    await expect(run({ spawnImpl: fakeWorker({ probe, report: cleanReport(), passes }) }))
      .rejects.toMatchObject({ code: 'RIGGING_SKELETON_INCOMPATIBLE', status: 422 });

    expect(passes).toEqual(['probe']);
    const paths = retargetRunPaths({ recordDir, retargetId: RETARGET_ID });
    expect(existsSync(paths.publishedGlb)).toBe(false);
    expect(existsSync(paths.stageDir)).toBe(false);
  });

  it('refuses a clip the file does not contain rather than animating a different one', async () => {
    const passes = [];
    await expect(run({
      clipName: 'Backflip',
      spawnImpl: fakeWorker({ probe: cleanProbe(), report: cleanReport(), passes }),
    })).rejects.toMatchObject({ code: 'RIGGING_CLIP_NOT_FOUND' });
    expect(passes).toEqual(['probe']);
  });

  it('publishes NEITHER artifact when the gate refuses the run', async () => {
    const failing = cleanReport();
    failing.motion = { sampled_frames: 8, max_joint_translation: 0 };
    await expect(run({
      spawnImpl: fakeWorker({ probe: cleanProbe(), report: failing, applyCode: 2 }),
    })).rejects.toThrow(/never moves/);

    const paths = retargetRunPaths({ recordDir, retargetId: RETARGET_ID });
    expect(existsSync(paths.publishedGlb)).toBe(false);
    expect(existsSync(paths.publishedReport)).toBe(false);
    expect(existsSync(paths.stageDir)).toBe(false);
  });

  it('surfaces the cap sentence when a write-mode run refused its own over-cap cleanup', async () => {
    // The shape a CORRECT worker produces: it measured an over-cap proposal, changed
    // nothing, and exited non-zero. The user must get the numbers, not a generic
    // "worker exited 2" — and nothing may be published.
    const overCap = cleanReport();
    overCap.head_cleanup = { ...overCap.head_cleanup, mode: 'write', proposed_vertices: 900, changed_vertices: 0 };
    await expect(run({
      mode: 'write',
      spawnImpl: fakeWorker({ probe: cleanProbe(), report: overCap, applyCode: 2 }),
    })).rejects.toMatchObject({
      code: 'RIGGING_RETARGET_GATE_FAILED',
      message: expect.stringContaining('re-bind 900 of 10000 vertices, and the cap is 200'),
    });

    expect(existsSync(retargetRunPaths({ recordDir, retargetId: RETARGET_ID }).publishedGlb)).toBe(false);
  });

  it('refuses to record an animation whose published pair does not read back', async () => {
    // The publish itself succeeded, but the pair does not verify — the exact state an
    // interrupted run leaves behind. The SOURCE rig still has to verify, or the run would
    // fail earlier for the wrong reason.
    const rigDir = join(recordDir, 'rig', RIG_ID);
    await expect(run({
      spawnImpl: fakeWorker({ probe: cleanProbe(), report: cleanReport() }),
      verify: async ({ publishDir }) => (publishDir === rigDir
        ? readRiggedArtifact({ publishDir })
        : { ok: false, reason: 'digest-mismatch' }),
    })).rejects.toMatchObject({ code: 'RIGGING_PUBLISH_UNVERIFIED' });
  });

  it('refuses to animate a rig that is not a readable published pair', async () => {
    await rm(rigRunPaths({ recordDir, rigId: RIG_ID }).publishedGlb);
    await expect(run({ spawnImpl: fakeWorker({ probe: cleanProbe(), report: cleanReport() }) }))
      .rejects.toMatchObject({ code: 'RIGGING_NO_SOURCE_RIG', status: 422 });
  });

  it('reports the probe exit when the worker produced no readable probe at all', async () => {
    await expect(run({ spawnImpl: fakeWorker({ probeCode: 3 }) }))
      .rejects.toMatchObject({ code: 'RIGGING_CLIP_UNREADABLE' });
  });

  it('refuses to run at all when the Blender runtime is not ready', async () => {
    await expect(run({
      readiness: { ready: false, reason: 'module-unimportable' },
      spawnImpl: fakeWorker({ probe: cleanProbe(), report: cleanReport() }),
    })).rejects.toMatchObject({ code: 'RIGGING_RUNTIME_UNAVAILABLE', status: 409 });
  });
});

describe('clip selection', () => {
  it('defaults to the only clip in a single-clip file, so a drop needs no internal name', () => {
    expect(selectClip([{ name: 'Walk' }], null)).toEqual({ ok: true, clip: { name: 'Walk' } });
  });

  it('honours an explicit request and refuses an absent one rather than substituting', () => {
    const clips = [{ name: 'Walk' }, { name: 'Idle' }];
    expect(selectClip(clips, 'Idle')).toMatchObject({ ok: true, clip: { name: 'Idle' } });
    expect(selectClip(clips, 'Backflip')).toEqual({ ok: false, available: ['Walk', 'Idle'] });
  });

  it('refuses a file with no animations instead of returning an unnamed clip', () => {
    expect(selectClip([], null)).toEqual({ ok: false, available: [] });
    expect(selectClip([{ name: '' }, { duration: 1 }], null)).toEqual({ ok: false, available: [] });
  });
});
