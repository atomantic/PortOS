import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('./hfToken.js', () => ({ getHfToken: async () => null }));

const { listSlotstreamCachedModels } = await import('../lib/slotstreamModels.js');
const {
  cancelSlotstreamModelDownload,
  downloadSlotstreamModel,
  previewSlotstreamDownload,
  isSlotstreamDownloadInFlight,
  slotstreamModelPath,
  _resetSlotstreamDownloadsForTests,
} = await import('./slotstreamModelManager.js');

const REPO = 'mlx-community/Qwen3-30B-A3B-4bit';
const DIR_NAME = 'mlx-community__Qwen3-30B-A3B-4bit';

// Two files: one big enough to stand in for a weight shard, one config.
const SHARD = 'S'.repeat(4096);
const CONFIG = '{"model_type":"qwen3_moe"}';
const FILES = { 'model.safetensors': SHARD, 'config.json': CONFIG };
const TOTAL = SHARD.length + CONFIG.length;

const metadataResponse = () => new Response(JSON.stringify({
  id: REPO,
  siblings: [
    { rfilename: 'model.safetensors', lfs: { size: SHARD.length } },
    { rfilename: 'config.json', size: CONFIG.length },
    // A mirrored PyTorch copy the runtime never loads — must not be fetched
    // (and must not inflate the size the user is asked to approve).
    { rfilename: 'pytorch_model.bin', lfs: { size: 999_999 } },
  ],
}), { status: 200, headers: { 'content-type': 'application/json' } });

let cacheDir;
let fetched;

const installFetch = (fileBodies = FILES) => {
  fetched = [];
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const href = String(url);
    fetched.push(href);
    if (href.startsWith('https://huggingface.co/api/models/')) return metadataResponse();
    const file = Object.keys(fileBodies).find((name) => href.endsWith(`/${name}`));
    if (!file) return new Response('nope', { status: 404, statusText: 'Not Found' });
    const body = fileBodies[file];
    return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
  }));
};

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'slotstream-cache-'));
  _resetSlotstreamDownloadsForTests();
  installFetch();
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('previewSlotstreamDownload', () => {
  it('reports the whole checkpoint size, the destination, and a disk verdict', async () => {
    const preview = await previewSlotstreamDownload({ model: REPO, cacheDir });
    expect(preview.kind).toBe('slotstream');
    expect(preview.repo).toBe(REPO);
    expect(preview.destPath).toBe(join(cacheDir, DIR_NAME));
    // The mirrored `.bin` is excluded, so the user approves what is actually moved.
    expect(preview.expectedBytes).toBe(TOTAL);
    expect(preview.files).toBe(2);
    expect(preview.alreadyDownloaded).toBe(false);
    expect(preview.verdict).toBe('ok');
  });

  it('credits bytes already on disk so a resume is not refused for the full size', async () => {
    // `requiredBytes` is what a nearly-full disk is judged against; charging the
    // full checkpoint again would reject a resume the volume can finish.
    const modelDir = join(cacheDir, DIR_NAME);
    await mkdir(modelDir, { recursive: true });
    await writeFile(join(modelDir, 'config.json'), CONFIG);
    await writeFile(join(modelDir, 'model.safetensors.partial'), SHARD.slice(0, 1000));

    const preview = await previewSlotstreamDownload({ model: REPO, cacheDir });
    // Size stays the whole checkpoint (what the user is committing to) while
    // the space actually reserved drops to what is left, which is what the
    // confirm modal renders as "Still needed".
    expect(preview.expectedBytes).toBe(TOTAL);
    expect(preview.requiredBytes - preview.headroomBytes).toBe(SHARD.length - 1000);
    expect(preview.requiredBytes).toBeLessThan(preview.expectedBytes + preview.headroomBytes);
  });

  it('does not credit a truncated leftover — the whole shard is re-fetched', async () => {
    // Crediting it would under-reserve the disk by exactly the bytes the run is
    // about to move again, so the modal could say "fits" on a volume that then
    // fills mid-transfer.
    const modelDir = join(cacheDir, DIR_NAME);
    await mkdir(modelDir, { recursive: true });
    await writeFile(join(modelDir, 'config.json'), CONFIG);
    await writeFile(join(modelDir, 'model.safetensors'), SHARD.slice(0, 2048));

    const preview = await previewSlotstreamDownload({ model: REPO, cacheDir });
    expect(preview.requiredBytes - preview.headroomBytes).toBe(SHARD.length);
    expect(preview.alreadyDownloaded).toBe(false);
  });

  it('does not call a full-size .partial "already downloaded"', async () => {
    // That flag DISABLES Confirm. A partial the size of the whole file is a
    // crash between the last byte and the rename — calling it done would strand
    // the download with no way to finish it from the UI.
    const modelDir = join(cacheDir, DIR_NAME);
    await mkdir(modelDir, { recursive: true });
    await writeFile(join(modelDir, 'config.json'), CONFIG);
    await writeFile(join(modelDir, 'model.safetensors.partial'), SHARD);

    const preview = await previewSlotstreamDownload({ model: REPO, cacheDir });
    expect(preview.alreadyDownloaded).toBe(false);
  });

  it('marks a fully cached checkpoint as already downloaded', async () => {
    const modelDir = join(cacheDir, DIR_NAME);
    await mkdir(modelDir, { recursive: true });
    for (const [name, body] of Object.entries(FILES)) await writeFile(join(modelDir, name), body);

    const preview = await previewSlotstreamDownload({ model: REPO, cacheDir });
    expect(preview.alreadyDownloaded).toBe(true);
    expect(preview.requiredBytes).toBe(0);
  });

  it('refuses a repo that publishes no weights it can stream', async () => {
    // Config and tokenizer alone would make a checkpoint directory the cache
    // walk reports as servable and a start then fails on.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: REPO,
      siblings: [{ rfilename: 'config.json', size: 10 }, { rfilename: 'pytorch_model.bin', lfs: { size: 999 } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    await expect(previewSlotstreamDownload({ model: REPO, cacheDir }))
      .rejects.toMatchObject({ code: 'SLOTSTREAM_NO_WEIGHTS' });
  });

  it('refuses an unknown model before it touches the network', async () => {
    await expect(previewSlotstreamDownload({ model: '../escape', cacheDir }))
      .rejects.toMatchObject({ code: 'SLOTSTREAM_INVALID_MODEL' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('downloadSlotstreamModel', () => {
  it('lands a servable checkpoint the cache walk reports, and skips mirrored formats', async () => {
    const frames = [];
    const result = await downloadSlotstreamModel({ model: REPO, cacheDir, onProgress: (f) => frames.push(f) });

    expect(result).toMatchObject({ success: true, repo: REPO, model: DIR_NAME, files: 2 });
    expect(await readFile(join(cacheDir, DIR_NAME, 'model.safetensors'), 'utf8')).toBe(SHARD);
    expect(await readFile(join(cacheDir, DIR_NAME, 'config.json'), 'utf8')).toBe(CONFIG);
    expect(fetched.some((url) => url.endsWith('pytorch_model.bin'))).toBe(false);

    // The whole point: a start can now resolve it with no restart.
    const cached = await listSlotstreamCachedModels({ cacheDir });
    expect(cached.error).toBeNull();
    expect(cached.models.map((m) => m.id)).toEqual([DIR_NAME]);
    expect(frames.at(-1)).toMatchObject({ event: 'complete', model: REPO });
  });

  it('accepts a catalog id as well as a repo id', async () => {
    const result = await downloadSlotstreamModel({ model: 'qwen3-30b-a3b-4bit', cacheDir });
    expect(result.success).toBe(true);
    expect(result.repo).toBe(REPO);
  });

  it('reports a transfer failure as a value with a terminal frame, not a rejection', async () => {
    // The route has already streamed progress by this point, so a thrown
    // rejection would leave the client's bar stuck with no terminal frame.
    installFetch({ 'config.json': CONFIG });
    const frames = [];
    const result = await downloadSlotstreamModel({ model: REPO, cacheDir, onProgress: (f) => frames.push(f) });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(frames.at(-1).event).toBe('error');
    expect(isSlotstreamDownloadInFlight(join(cacheDir, DIR_NAME))).toBe(false);
  });

  it('refuses a second download of the same checkpoint while one is running', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).endsWith('model.safetensors')) await gate;
      return realFetch(url);
    }));

    const first = downloadSlotstreamModel({ model: REPO, cacheDir });
    // Let the first call claim its slot before the second one checks.
    await vi.waitFor(() => expect(isSlotstreamDownloadInFlight(join(cacheDir, DIR_NAME))).toBe(true));
    await expect(downloadSlotstreamModel({ model: REPO, cacheDir }))
      .rejects.toMatchObject({ code: 'SLOTSTREAM_DOWNLOAD_IN_FLIGHT' });

    // A DIFFERENT checkpoint is refused too: one disk, one progress bar.
    await expect(downloadSlotstreamModel({ model: 'someone/other-moe', cacheDir }))
      .rejects.toMatchObject({ code: 'SLOTSTREAM_DOWNLOAD_IN_FLIGHT' });

    release();
    expect((await first).success).toBe(true);
  });

  // Before the shared download slot, Slotstream had no cancel at all: the idle
  // watchdog was the only thing that could abort a transfer, so a 100 GB+ pull
  // that was merely SLOW could only be waited out.
  it('cancels a running checkpoint download and keeps its partial for a resume', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const href = String(url);
      if (href.startsWith('https://huggingface.co/api/models/')) return metadataResponse();
      if (href.endsWith('/config.json')) {
        return new Response(CONFIG, { status: 200, headers: { 'content-length': String(CONFIG.length) } });
      }
      // The shard streams its first chunk, then hangs until the cancel aborts it.
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(SHARD.slice(0, 512)));
          gate.then(() => controller.error(new Error('aborted')));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-length': String(SHARD.length) } });
    }));

    const frames = [];
    const download = downloadSlotstreamModel({ model: REPO, cacheDir, onProgress: (f) => frames.push(f) });
    // Wait until the shard is genuinely mid-write: the slot is claimed before
    // the metadata round trip, so an in-flight check alone would cancel before
    // any bytes exist and prove nothing about what a cancel preserves.
    const shardPartial = join(cacheDir, DIR_NAME, 'model.safetensors.partial');
    await vi.waitFor(async () => expect((await readFile(shardPartial, 'utf8')).length).toBeGreaterThan(0));

    expect(cancelSlotstreamModelDownload({ model: REPO, cacheDir })).toBe(true);
    release();
    const result = await download;

    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.code).toBe('SLOTSTREAM_DOWNLOAD_CANCELLED');
    expect(frames.at(-1).event).toBe('cancelled');
    expect(isSlotstreamDownloadInFlight(join(cacheDir, DIR_NAME))).toBe(false);
    // The bytes that landed are kept, so pressing download again resumes rather
    // than restarting a multi-gigabyte shard from zero.
    expect((await readFile(shardPartial, 'utf8')).length).toBeGreaterThan(0);
  });

  it('reports no cancellation when nothing is downloading', () => {
    expect(cancelSlotstreamModelDownload({ model: REPO, cacheDir })).toBe(false);
  });

  it('protects a live shard from the orphaned-partial sweep', async () => {
    // The sweep asks about the `.partial` path a SHARD is being written to, one
    // level below the checkpoint directory. Answering false there would let the
    // daily GC unlink a transfer that is still running.
    const shardPartial = join(cacheDir, DIR_NAME, 'model.safetensors.partial');
    expect(slotstreamModelPath(REPO, { cacheDir })).toBe(join(cacheDir, DIR_NAME));
    expect(isSlotstreamDownloadInFlight(shardPartial)).toBe(false);

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).endsWith('model.safetensors')) await gate;
      return realFetch(url);
    }));

    const running = downloadSlotstreamModel({ model: REPO, cacheDir });
    await vi.waitFor(() => expect(isSlotstreamDownloadInFlight(shardPartial)).toBe(true));
    // A sibling checkpoint's partial is NOT protected by this one's transfer.
    expect(isSlotstreamDownloadInFlight(join(cacheDir, 'other__model', 'x.safetensors.partial'))).toBe(false);

    release();
    await running;
    expect(isSlotstreamDownloadInFlight(shardPartial)).toBe(false);
  });
});
