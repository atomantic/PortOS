import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { mkdir, readFile, readdir, rename, symlink, truncate, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const state = vi.hoisted(() => ({ project: null, jobs: [], spawns: [], outputSizes: [], duringPass: null, failPass: null, realEncode: false, saveError: null, missingFfmpeg: false, cleanupError: false, observerError: null, openedFiles: [] }));
vi.mock('fs/promises', async original => {
  const actual = await original();
  return { ...actual, open: async (...args) => { const file = await actual.open(...args); state.openedFiles.push(file); return file; }, rm: async (path, options) => {
    if (state.cleanupError && String(path).includes('sharing-work-')) throw new Error('Synthetic cleanup I/O error');
    return actual.rm(path, options);
  } };
});
vi.mock('../../lib/maintenanceAdmission.js', () => ({ maintenance: { markCurrentUnsettled: vi.fn(), markResourceUnsettled: vi.fn() } }));
vi.mock('../../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('sharing-copy-test-') }));
vi.mock('./projects.js', () => ({
  getProject: vi.fn(async () => state.project),
  listProjects: async () => [state.project],
  mutateProjectRecord: async (_id, transform) => { if (state.saveError) throw state.saveError; const out = transform(state.project); state.project = out.project; return out; },
}));
vi.mock('../videoGen/history.js', () => ({ getHistoryItem: async id => ({ id, filename: `${id}.mp4` }) }));
vi.mock('../mediaJobQueue/index.js', () => ({
  listJobs: () => state.jobs,
  enqueueJob: vi.fn(async job => { state.jobs.push({ ...job, id: 'queued-example', status: 'queued' }); return { jobId: 'queued-example', status: 'queued' }; }),
}));
vi.mock('../../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: async fn => fn() }));
vi.mock('../../lib/ffmpeg.js', async original => {
  const actual = await original();
  return { ...actual,
    findFfmpeg: async () => state.missingFfmpeg ? null : state.realEncode ? actual.findFfmpeg() : 'ffmpeg',
    probeVideoDuration: async path => state.realEncode ? actual.probeVideoDuration(path) : 120,
    probeVideoStreamInfo: async path => state.realEncode ? actual.probeVideoStreamInfo(path) : ({ width: 1280, height: 720, fps: 60 }),
  };
});
vi.mock('../../lib/detachedSpawn.js', async original => ({ spawnDetached: vi.fn(async (bin, args, options) => {
  if (state.realEncode) return (await original()).spawnDetached(bin, args, options);
  state.spawns.push(args);
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => { queueMicrotask(() => proc.emit('close', null, 'SIGTERM')); return true; };
  proc.exitCode = null;
  proc.signalCode = null;
  if (state.observerError) {
    proc.pid = 123;
    setImmediate(() => { proc.emit('error', new Error('Synthetic observer I/O error')); state.observerError(proc); });
    // This test controls physical exit rather than the ordinary pass fixture.
    proc.kill = vi.fn(() => true);
    return proc;
  }
  setImmediate(async () => {
    try {
      await state.duringPass?.(args);
      if (state.failPass) { proc.emit('close', 1); return; }
      if (args[args.indexOf('-pass') + 1] === '2') {
        const file = args.at(-1);
        await writeFile(file, 'sharing fixture');
        if (state.outputSizes.length) await truncate(file, state.outputSizes.shift());
      }
      proc.exitCode = 0;
      proc.emit('close', 0);
    } catch (err) { proc.emit('error', err); }
  });
  return proc;
}) }));

const { PATHS } = await import('../../lib/fileUtils.js');
const sharing = await import('./sharingCopy.js');
const { videoGenEvents } = await import('../videoGen/events.js');
const { enqueueJob } = await import('../mediaJobQueue/index.js');

beforeEach(async () => {
  await drainOwnedExport();
  state.project = { id: 'mv-example', renderHistoryId: 'final-example' };
  state.jobs = []; state.spawns = []; state.outputSizes = []; state.duringPass = null; state.failPass = null; state.realEncode = false; state.saveError = null; state.missingFfmpeg = false; state.cleanupError = false; state.observerError = null; state.openedFiles = [];
  vi.clearAllMocks();
  const { getProject } = await import('./projects.js');
  getProject.mockImplementation(async () => state.project);
  await mkdir(PATHS.videos, { recursive: true });
  await writeFile(join(PATHS.videos, 'final-example.mp4'), 'original final fixture');
});
afterAll(cleanupTempDataRoots);

let ownedRun = null;
let ownedJobId = null;

async function drainOwnedExport() {
  if (ownedJobId) sharing.cancel(ownedJobId);
  const owned = ownedRun;
  ownedRun = null;
  ownedJobId = null;
  if (owned) await owned.catch(() => {});
}

async function runExport(jobId = '00000000-0000-4000-8000-000000000001') {
  await drainOwnedExport();
  ownedJobId = jobId;
  const queued = await sharing.prepareSharingCopy('mv-example');
  const params = state.jobs.find(j => j.id === queued.jobId).params;
  const completed = vi.fn(); const failed = vi.fn();
  videoGenEvents.once('completed', completed); videoGenEvents.once('failed', failed);
  const run = sharing.runSharingCopy({ ...params, jobId });
  ownedRun = run;
  try {
    await run;
  } finally {
    if (ownedRun === run) ownedRun = null;
  }
  videoGenEvents.removeListener('completed', completed); videoGenEvents.removeListener('failed', failed);
  return { completed, failed };
}

describe('private sharing export workflow', () => {
  it('retains process ownership after an observer error until physical close', async () => {
    let reportError;
    const observed = new Promise(resolve => { reportError = resolve; });
    state.observerError = reportError;
    let settled = false;
    const outcome = runExport('00000000-0000-4000-8000-000000000066').then(result => { settled = true; return result; });
    const proc = await observed;
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect((await readdir(join(PATHS.videos, '.detached'))).some(name => name.startsWith('sharing-work-'))).toBe(true);
    proc.exitCode = 1;
    proc.emit('close', 1);
    expect((await outcome).failed).toHaveBeenCalledWith(expect.objectContaining({ error: 'Synthetic observer I/O error' }));
    expect(await readdir(join(PATHS.videos, '.detached'))).toEqual([]);
  });

  it('preserves a maintenance blocker when owned scratch cleanup cannot finish', async () => {
    state.failPass = true;
    state.cleanupError = true;
    const { failed } = await runExport('00000000-0000-4000-8000-000000000067');
    expect(failed).toHaveBeenCalled();
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    expect(maintenance.markCurrentUnsettled).toHaveBeenCalled();
    expect(maintenance.markResourceUnsettled).toHaveBeenCalledWith('media', '00000000-0000-4000-8000-000000000067');
    expect(state.project.publishKit).toBeUndefined();
    state.cleanupError = false;
    const actualFs = await vi.importActual('fs/promises');
    for (const name of await readdir(join(PATHS.videos, '.detached'))) {
      if (name.startsWith('sharing-work-')) await actualFs.rm(join(PATHS.videos, '.detached', name), { recursive: true, force: true });
    }
  });

  it('coalesces repeated clicks, preserves the final, and caches only the exact final bytes', async () => {
    const requests = await Promise.all([sharing.prepareSharingCopy('mv-example'), sharing.prepareSharingCopy('mv-example')]);
    expect(requests[0]).toEqual(requests[1]);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const { completed, failed } = await runExport();
    expect(failed).not.toHaveBeenCalled();
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ bytes: 15, width: 1280, fps: 60 }));
    expect(await readFile(join(PATHS.videos, 'final-example.mp4'), 'utf8')).toBe('original final fixture');
    state.jobs = [];
    const cached = await sharing.prepareSharingCopy('mv-example');
    expect(cached.copy.filename).toBe('music-video-sharing-00000000-0000-4000-8000-000000000001.mp4');
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const download = await sharing.sharingCopyDownload('mv-example');
    try { expect(download.copy).toEqual(cached.copy); } finally { await download.file.close(); }
    await writeFile(join(PATHS.videos, 'final-example.mp4'), 'changed final fixture');
    expect((await sharing.getSharingCopy('mv-example')).copy).toBeNull();
    await expect(sharing.sharingCopyDownload('mv-example')).rejects.toThrow('current final render');
    await sharing.prepareSharingCopy('mv-example');
    expect(enqueueJob).toHaveBeenCalledTimes(2);
    const firstArgs = state.spawns[0];
    expect(firstArgs).toEqual(expect.arrayContaining(['-threads', '2', '-r', '60', '-protocol_whitelist', 'file,pipe', '-f', 'mov']));
  });

  it('retries an oversized encode with a smaller budget and refuses any still oversized result', async () => {
    state.outputSizes = [100_000_000, 100_000_001];
    const { failed, completed } = await runExport('00000000-0000-4000-8000-000000000002');
    expect(state.spawns).toHaveLength(4);
    const rate = args => Number(args[args.indexOf('-b:v') + 1]);
    expect(rate(state.spawns[2])).toBeLessThan(rate(state.spawns[0]));
    expect(completed).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('verification') }));
    expect(state.project.publishKit).toBeUndefined();
    expect(await readdir(join(PATHS.videos, '.detached'))).toEqual([]);
  });

  it('cancels between passes and removes partial output before reporting failure', async () => {
    state.duringPass = args => { if (args[args.indexOf('-pass') + 1] === '1') sharing.cancel('00000000-0000-4000-8000-000000000003'); };
    const { failed, completed } = await runExport('00000000-0000-4000-8000-000000000003');
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('cancelled') }));
    expect(completed).not.toHaveBeenCalled();
    expect(state.spawns).toHaveLength(1);
    expect(await readdir(join(PATHS.videos, '.detached'))).toEqual([]);
  });

  it('refuses a final changed during encode and leaves its source untouched', async () => {
    state.duringPass = async args => { if (args[args.indexOf('-pass') + 1] === '2') await writeFile(join(PATHS.videos, 'final-example.mp4'), 'replacement final'); };
    const { failed, completed } = await runExport('00000000-0000-4000-8000-000000000004');
    expect(completed).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('changed during export') }));
    expect(await readFile(join(PATHS.videos, 'final-example.mp4'), 'utf8')).toBe('replacement final');
    expect(state.project.publishKit).toBeUndefined();
  });

  it('refuses a removed source before delivery and a final selection changed during verification', async () => {
    await runExport('00000000-0000-4000-8000-000000000061');
    await unlink(join(PATHS.videos, 'final-example.mp4'));
    await expect(sharing.sharingCopyDownload('mv-example')).rejects.toMatchObject({ status: 409, code: 'SHARING_COPY_UNAVAILABLE' });
    await writeFile(join(PATHS.videos, 'final-example.mp4'), 'original final fixture');
    const { getProject } = await import('./projects.js');
    getProject.mockImplementationOnce(async () => ({ ...state.project }));
    getProject.mockImplementationOnce(async () => ({ ...state.project, renderHistoryId: 'replacement-example' }));
    await expect(sharing.getSharingCopy('mv-example')).rejects.toThrow('final render changed');
  });

  it('removes partial files when ffmpeg fails, the source disappears, or the record write fails', async () => {
    state.failPass = true;
    let outcome = await runExport('00000000-0000-4000-8000-000000000062');
    expect(outcome.failed).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('Sharing encode failed') }));
    state.failPass = null;
    state.duringPass = async args => { if (args[args.indexOf('-pass') + 1] === '2') await unlink(join(PATHS.videos, 'final-example.mp4')); };
    outcome = await runExport('00000000-0000-4000-8000-000000000063');
    expect(outcome.completed).not.toHaveBeenCalled();
    expect(outcome.failed).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('missing or unsafe') }));
    await writeFile(join(PATHS.videos, 'final-example.mp4'), 'original final fixture');
    state.duringPass = null;
    state.saveError = new Error('Synthetic storage full');
    outcome = await runExport('00000000-0000-4000-8000-000000000064');
    expect(outcome.failed).toHaveBeenCalledWith(expect.objectContaining({ error: 'Synthetic storage full' }));
    expect(state.project.publishKit).toBeUndefined();
    expect(await readdir(PATHS.videos)).not.toContain('music-video-sharing-00000000-0000-4000-8000-000000000064.mp4');
    expect(await readdir(join(PATHS.videos, '.detached'))).toEqual([]);
    expect(await readFile(join(PATHS.videos, 'final-example.mp4'), 'utf8')).toBe('original final fixture');
  });

  it('fails before spawning if ffmpeg is unavailable and rejects a corrupted job identity', async () => {
    state.missingFfmpeg = true;
    const { failed } = await runExport('00000000-0000-4000-8000-000000000065');
    expect(failed).toHaveBeenCalled();
    expect(state.spawns).toHaveLength(0);
    await expect(sharing.runSharingCopy({ jobId: '../unowned', sharingProjectId: 'mv-example' })).rejects.toThrow('Invalid sharing job identity');
    expect(state.project.publishKit).toBeUndefined();
  });

  it('refuses an output-name collision without overwriting or deleting the existing file', async () => {
    const jobId = '00000000-0000-4000-8000-000000000088';
    const destination = join(PATHS.videos, `music-video-sharing-${jobId}.mp4`);
    await writeFile(destination, 'existing owned video');
    const { failed, completed } = await runExport(jobId);
    expect(completed).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalled();
    expect(await readFile(destination, 'utf8')).toBe('existing owned video');
    expect(state.project.publishKit).toBeUndefined();
  });

  it('rejects symlinked sources and detects a changed sharing file before download', async () => {
    await runExport('00000000-0000-4000-8000-000000000005');
    await writeFile(join(PATHS.videos, state.project.publishKit.sharingCopy.filename), 'tampered bytes!');
    await expect(sharing.sharingCopyDownload('mv-example')).rejects.toThrow('current final render');
    await symlink(join(PATHS.videos, 'final-example.mp4'), join(PATHS.videos, 'linked-example.mp4'));
    state.project.renderHistoryId = 'linked-example';
    await expect(sharing.prepareSharingCopy('mv-example')).rejects.toThrow('unsafe');
  });

  it.each(['replacement', 'symlink'])('retains the certified inode across a %s swap during final validation', async swap => {
    await runExport(swap === 'replacement' ? '00000000-0000-4000-8000-000000000071' : '00000000-0000-4000-8000-000000000072');
    const copyPath = join(PATHS.videos, state.project.publishKit.sharingCopy.filename);
    const { getProject } = await import('./projects.js');
    let lookups = 0;
    getProject.mockImplementation(async () => {
      if (++lookups === 3) {
        await rename(copyPath, `${copyPath}.old`);
        if (swap === 'symlink') await symlink(join(PATHS.videos, 'final-example.mp4'), copyPath);
        else await writeFile(copyPath, 'replacement bytes must not be delivered');
      }
      return state.project;
    });
    const { file } = await sharing.sharingCopyDownload('mv-example');
    try {
      const chunks = [];
      for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe('sharing fixture');
    } finally { await file.close(); }
  });

  it('a cancelled export cannot write the next case project', async () => {
    let releasePass;
    state.duringPass = () => new Promise(resolve => { releasePass = resolve; });
    const pending = runExport('00000000-0000-4000-8000-000000000098');
    await vi.waitFor(() => expect(state.spawns.length).toBeGreaterThan(0));
    await new Promise(resolve => setImmediate(resolve));
    await drainOwnedExport();
    const sentinel = { id: 'mv-example', renderHistoryId: 'final-example', marker: 'next-case' };
    state.project = sentinel;
    releasePass();
    await pending;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(state.project).toBe(sentinel);
    expect(state.project.publishKit?.sharingCopy).toBeUndefined();
  });

  it('closes the retained descriptor when source validation refuses delivery', async () => {
    await runExport('00000000-0000-4000-8000-000000000073');
    const { getProject } = await import('./projects.js');
    let lookups = 0;
    getProject.mockImplementation(async () => ++lookups === 3 ? { ...state.project, renderHistoryId: 'replacement-final' } : state.project);
    await expect(sharing.sharingCopyDownload('mv-example')).rejects.toThrow('final render changed');
    expect(state.openedFiles.every(file => file.fd === -1)).toBe(true);
  });
});

// Two seconds only: catches ffmpeg argument/container/pass-log mistakes that stubs cannot.
const actualFfmpeg = await vi.importActual('../../lib/ffmpeg.js');
const realBinary = await actualFfmpeg.findFfmpeg();
it.skipIf(!realBinary)('exports a bounded real MP4 fixture through the supervised process runner', async () => {
  state.realEncode = true;
  const { execFile } = await import('../../lib/childProcess.js');
  const { promisify } = await import('util');
  const { safeChildProcessOptions } = await import('../../lib/processEnv.js');
  const sourcePath = join(PATHS.videos, 'final-example.mp4');
  await promisify(execFile)(realBinary, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1440x810:rate=60', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-c:a', 'aac', '-y', sourcePath], safeChildProcessOptions({ timeout: 20_000 }));
  const original = await readFile(sourcePath);
  const { completed, failed } = await runExport('00000000-0000-4000-8000-000000000099');
  expect(failed).not.toHaveBeenCalled();
  expect(completed).toHaveBeenCalledWith(expect.objectContaining({ width: 1280, height: 720, fps: 60 }));
  const { file, copy } = await sharing.sharingCopyDownload('mv-example');
  await file.close();
  const path = join(PATHS.videos, copy.filename);
  expect(copy.bytes).toBeLessThan(sharing.SHARING_COPY_MAX_BYTES);
  expect(copy.durationSec).toBeCloseTo(2, 1);
  expect(await readFile(sourcePath)).toEqual(original);
  // A complete decode is cheap for this fixture and proves a playable full copy.
  await promisify(execFile)(realBinary, ['-v', 'error', '-i', path, '-f', 'null', '-'], safeChildProcessOptions({ timeout: 20_000 }));
}, 30_000);
