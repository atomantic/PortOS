import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdir, writeFile, stat, readdir, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/fileUtils.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('topaz-job-') }));
const state = vi.hoisted(() => ({ rows: [], result: {}, key: 'test-key', phase: null, fetches: [], audio: true, invalid: false, failPreparedProbe: false, invalidOutput: false, pixelAspect: { numerator: 1, denominator: 1 } }));
vi.mock('../settings.js', () => ({ getSettings: async () => ({ videoGen: { topaz: { apiKey: state.key } } }) }));
vi.mock('./history.js', () => ({
  HISTORY_UNCHANGED: Symbol('unchanged'),
  loadHistory: async () => state.rows,
  mutateVideoHistory: async fn => {
    const next = await fn([...state.rows]);
    if (state.failHistoryOnce) { state.failHistoryOnce = false; throw new Error('synthetic history failure'); }
    if (Array.isArray(next)) state.rows = next;
  },
}));
vi.mock('./upscaleVideo.js', () => ({
  resolveHistoryItem: async id => state.rows.find(row => row.id === id),
  resolveSourcePath: row => join(state.videos, row.filename),
}));
vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(async job => { state.enqueued = job; return { jobId: state.jobId, status: 'queued' }; }),
  getJob: () => ({ ...state.job, result: state.result }),
  listJobs: () => state.related || [],
  updateJobResult: async (id, patch) => { state.updates.push({ id, patch }); Object.assign(state.result, patch); return true; },
}));
vi.mock('../../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: async fn => fn() }));
vi.mock('../../lib/ffmpeg.js', () => ({
  safeUnder: (base, name) => name && !name.includes('/') ? join(base, name) : null,
  probeVideoStreamInfo: async path => path.includes('source') ? { width: state.invalid ? 0 : 640, height: 480, fps: 24, frameCount: 24 } : path.includes('topaz-staging') && !path.endsWith('.output.mp4') && !path.endsWith('.final.mp4') ? { width: 864, height: 486, fps: 24, frameCount: state.failPreparedProbe ? null : 24 } : { width: state.invalidOutput ? 1280 : 1920, height: 1080, fps: 24, frameCount: 24 },
  probeFrameCount: async () => { if (state.failPreparedProbe) throw new Error('probe failed'); return 24; },
  probeVideoDuration: async () => 1,
  probeVideoPixelAspect: async () => state.pixelAspect,
  probeSquareVideoPixels: async () => true,
  hasAudioStream: async () => state.audio,
  generateThumbnail: async () => null,
}));
vi.mock('./upscaleFfmpeg.js', () => ({
  padSourceForUpscale: async (_input, output) => { await writeFile(output, 'prepared'); return { ok: true }; },
  finalizeUpscaleOutput: async (_input, output) => { await writeFile(output, 'final'); return { ok: true }; },
}));
const { PATHS } = await import('../../lib/fileUtils.js');
const { quoteTopaz } = await import('./topazQuote.js');
const { topazPreparedPath, registerStaging, releaseTopazStaging, cleanupTopazStaging, cleanupOrphanTopazStaging } = await import('./topazStaging.js');
const { enqueueTopazUpscale, runVideoUpscale, cancel, recoverTopazResult } = await import('./topazJob.js');
const { videoGenEvents } = await import('./events.js');
const sourceId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const jobId = '33333333-3333-4333-8333-333333333333';
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  state.videos = PATHS.videos;
  state.jobId = jobId;
  state.key = 'test-key'; state.rows = [{ id: sourceId, filename: 'source.mp4' }]; state.result = {}; state.job = {}; state.related = []; state.updates = []; state.fetches = []; state.audio = true; state.invalid = false; state.failPreparedProbe = false; state.invalidOutput = false; state.failHistoryOnce = false; state.pixelAspect = { numerator: 1, denominator: 1 };
  await mkdir(PATHS.videos, { recursive: true });
  await unlink(join(PATHS.videos, `${jobId}.mp4`)).catch(() => {});
  await writeFile(join(PATHS.videos, 'source.mp4'), 'source');
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    state.fetches.push([url, opts.method || 'GET']);
    if (url === 'https://api.topazlabs.com/video/') return response({ requestId, estimates: { cost: [4, 6] } });
    if (url.endsWith('/accept')) return response({ urls: ['https://bucket.s3.amazonaws.com/upload'] });
    if (url === 'https://bucket.s3.amazonaws.com/upload') return new Response('', { status: 200 });
    if (url.endsWith('/complete-upload/')) return response({});
    if (url.endsWith('/status')) return response({ status: 'complete', download: { url: 'https://bucket.s3.amazonaws.com/output' } });
    if (url === 'https://bucket.s3.amazonaws.com/output') return new Response('rendered');
    throw new Error('Unexpected request');
  }));
});
afterAll(() => { vi.unstubAllGlobals(); cleanupTempDataRoots(); });

async function queued() {
  const estimate = await quoteTopaz(sourceId);
  await enqueueTopazUpscale(sourceId, estimate.token);
  state.job = { kind: 'video-upscale', status: 'failed', params: state.enqueued.params };
  return { estimate, params: { ...state.enqueued.params, jobId } };
}

describe('Topaz job boundary', () => {
  it.each([true, false])('estimates without upload, then preserves the original with audio=%s', async audio => {
    state.audio = audio;
    const { estimate, params } = await queued();
    expect(estimate.credits).toEqual([4, 6]);
    expect(state.fetches).toEqual([['https://api.topazlabs.com/video/', 'POST']]);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ output: { resolution: { width: 1920, height: 1080 }, audioTransfer: 'None', cropToFit: false }, filters: [{ model: 'prob-4' }] });
    const completed = vi.fn(); videoGenEvents.once('completed', completed);
    await runVideoUpscale(params);
    expect(completed).toHaveBeenCalledOnce();
    expect(state.rows).toHaveLength(2);
    expect(state.rows[0]).toMatchObject({ id: jobId, upscaledFrom: sourceId, upscaleMethod: 'topaz', width: 1920, height: 1080 });
    expect(state.rows[1].filename).toBe('source.mp4');
    await expect(stat(topazPreparedPath(params.preparedId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not accept again when a restart finds an uncertain submission', async () => {
    const { params } = await queued();
    state.result.topazPhase = 'accepting';
    vi.stubGlobal('fetch', vi.fn(async () => response({ status: 'requested' })));
    const failed = vi.fn(); videoGenEvents.once('failed', failed);
    await runVideoUpscale(params);
    expect(failed.mock.calls[0][0].error).toMatch(/uncertain/);
    expect(fetch.mock.calls.every(([url]) => !url.endsWith('/accept'))).toBe(true);
    expect(state.rows).toHaveLength(1);
  });

  it('fails before upload if credentials are absent', async () => {
    state.key = '';
    await expect(quoteTopaz(sourceId)).rejects.toMatchObject({ code: 'TOPAZ_KEY_MISSING' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects invalid source dimensions before contacting Topaz', async () => {
    state.invalid = true;
    await expect(quoteTopaz(sourceId)).rejects.toMatchObject({ code: 'TOPAZ_INVALID_DIMENSIONS' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses unknown pixel aspect before a provider request', async () => {
    state.pixelAspect = null;
    await expect(quoteTopaz(sourceId)).rejects.toMatchObject({ code: 'TOPAZ_PIXEL_ASPECT_UNSUPPORTED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('discloses exact square-pixel normalization for an anamorphic source', async () => {
    state.pixelAspect = { numerator: 4, denominator: 3 };
    const quote = await quoteTopaz(sourceId);
    expect(quote.normalized).toEqual({ width: 864, height: 486 });
    expect(quote.padding).toEqual({ width: 864, height: 486 });
    await enqueueTopazUpscale(sourceId, quote.token);
    await runVideoUpscale({ ...state.enqueued.params, jobId });
  });

  it('cleans its prepared file when an estimate fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ message: 'private provider data' }, 500)));
    await expect(quoteTopaz(sourceId)).rejects.toMatchObject({ code: 'TOPAZ_REQUEST_FAILED' });
    expect(await readdir(join(PATHS.videos, '.topaz-staging'))).toEqual([]);
  });

  it('cleans its prepared file when the fallback frame probe fails', async () => {
    state.failPreparedProbe = true;
    await expect(quoteTopaz(sourceId)).rejects.toMatchObject({ code: 'TOPAZ_PREPARE_FAILED' });
    expect(await readdir(join(PATHS.videos, '.topaz-staging'))).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sweeps only marked orphan staging files, retaining live jobs and unrelated files', async () => {
    const orphan = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const live = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await registerStaging(orphan); await registerStaging(live);
    await writeFile(topazPreparedPath(orphan), 'orphan'); await writeFile(topazPreparedPath(live), 'live');
    releaseTopazStaging(orphan); releaseTopazStaging(live);
    const unrelated = join(PATHS.videos, '.topaz-staging', 'unrelated.mp4');
    await writeFile(unrelated, 'other');
    await cleanupOrphanTopazStaging([{ kind: 'video-upscale', status: 'queued', params: { mode: 'topaz', preparedId: live } }]);
    await expect(stat(topazPreparedPath(orphan))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(topazPreparedPath(live))).resolves.toBeDefined();
    await expect(stat(unrelated)).resolves.toBeDefined();
    await cleanupTopazStaging(live);
    await unlink(unrelated);
  });

  it('fails closed and removes local files after upload failure', async () => {
    const { params } = await queued();
    vi.stubGlobal('fetch', vi.fn(async url => {
      if (url.endsWith('/accept')) return response({ urls: ['https://bucket.s3.amazonaws.com/upload?secret=private'] });
      return response({ message: 'private provider data' }, 500);
    }));
    const failed = vi.fn(); videoGenEvents.once('failed', failed);
    await runVideoUpscale(params);
    expect(failed.mock.calls[0][0].error).not.toMatch(/secret|private/);
    expect(state.result.topazUncertain).toBe(true);
    expect(state.rows).toHaveLength(1);
    await expect(stat(topazPreparedPath(params.preparedId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unexpected provider geometry without publishing a result', async () => {
    const { params } = await queued();
    state.invalidOutput = true;
    const failed = vi.fn(); videoGenEvents.once('failed', failed);
    await runVideoUpscale(params);
    expect(failed.mock.calls[0][0].error).toMatch(/unexpected output dimensions/);
    expect(state.rows).toHaveLength(1);
    await expect(stat(topazPreparedPath(params.preparedId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retrieves an already completed provider result without accepting or uploading again', async () => {
    const { params } = await queued();
    state.invalidOutput = true;
    await runVideoUpscale(params);
    expect(state.result.topazRecoveryAvailable).toBe(true);
    state.invalidOutput = false;
    state.key = 'rotated-key-for-same-account';
    state.fetches = [];
    await recoverTopazResult(jobId);
    const recovered = { ...state.enqueued.params, jobId };
    expect(recovered.resumeOnly).toBe(true);
    expect(state.result.topazRecoveryAvailable).toBe(true);
    state.result = {};
    await runVideoUpscale(recovered);
    expect(state.rows[0]).toMatchObject({ upscaledFrom: sourceId, upscaleMethod: 'topaz' });
    expect(state.fetches.every(([url]) => !url.endsWith('/accept') && !url.includes('/upload'))).toBe(true);
  });

  it('retires the parent recovery offer when restart finds a published result', async () => {
    const { params } = await queued();
    state.rows.unshift({ id: jobId, filename: `${jobId}.mp4`, upscaledFrom: sourceId, upscaleMethod: 'topaz' });
    state.result.topazRecoveryAvailable = true;
    state.related = [
      { id: '44444444-4444-4444-8444-444444444444', params, result: { topazRecoveryAvailable: true } },
      { id: '55555555-5555-4555-8555-555555555555', params, result: { topazRecoveryAvailable: true } },
      { id: '66666666-6666-4666-8666-666666666666', params: { ...params, requestId: '77777777-7777-4777-8777-777777777777' }, result: { topazRecoveryAvailable: true } },
    ];
    await runVideoUpscale({ ...params, recoveryParentId: '44444444-4444-4444-8444-444444444444' });
    expect(state.updates.filter(update => update.patch.topazRecoveryAvailable === false).map(update => update.id)).toEqual([
      '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555',
    ]);
    expect(state.fetches).toEqual([['https://api.topazlabs.com/video/', 'POST']]);
  });

  it('does not overwrite a pre-existing output path', async () => {
    const { params } = await queued();
    const collision = join(PATHS.videos, `${jobId}.mp4`);
    await writeFile(collision, 'keep this');
    const failed = vi.fn(); videoGenEvents.once('failed', failed);
    await runVideoUpscale(params);
    expect(failed).toHaveBeenCalledOnce();
    expect(await readFile(collision, 'utf8')).toBe('keep this');
    expect(state.rows).toHaveLength(1);
  });

  it('rolls back the new output when its history publication fails', async () => {
    const { params } = await queued();
    state.failHistoryOnce = true;
    const failed = vi.fn(); videoGenEvents.once('failed', failed);
    await runVideoUpscale(params);
    expect(failed).toHaveBeenCalledOnce();
    expect(state.rows).toHaveLength(1);
    await expect(stat(join(PATHS.videos, `${jobId}.mp4`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(state.result.topazRecoveryAvailable).toBe(true);
  });

  it.each([['canceled', true, false, false], ['processing', false, true, false], ['complete', false, false, true]])('reports remote cancellation only when status is %s', async (providerStatus, confirmed, uncertain, recoverable) => {
    const { params } = await queued();
    let uploadStarted;
    const started = new Promise(resolve => { uploadStarted = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      if (url.endsWith('/accept')) return response({ urls: ['https://bucket.s3.amazonaws.com/upload'] });
      if (url.includes('amazonaws.com/upload')) return new Promise((_resolve, reject) => {
        uploadStarted(); opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
      if (opts.method === 'DELETE') return response({});
      if (url.endsWith('/status')) return response({ status: providerStatus });
      throw new Error('Unexpected request');
    }));
    const failed = vi.fn(); videoGenEvents.once('failed', failed);
    const running = runVideoUpscale(params);
    await started;
    expect(cancel(jobId)).toBe(true);
    await running;
    expect(failed.mock.calls[0][0].remoteCancellationConfirmed).toBe(confirmed);
    expect(state.result.topazUncertain).toBe(uncertain);
    expect(state.result.topazRecoveryAvailable === true).toBe(recoverable);
  });
});
