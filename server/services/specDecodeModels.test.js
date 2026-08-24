import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { isAbsolute, join } from 'path';
import { Readable } from 'stream';
import {
  downloadSpecDecodeModel,
  cancelSpecDecodeModelDownload,
  getSpecDecodePresetStatus,
  pickGgufSibling,
  resolveSpecModelPath,
  _resetSpecDecodeDownloadsForTests,
} from './specDecodeModels.js';
import * as specDecodePresets from '../lib/specDecodePresets.js';
import * as hfToken from './hfToken.js';
import * as huggingfaceLora from '../lib/huggingfaceLora.js';

const siblings = (...names) => ({ siblings: names.map((rfilename) => ({ rfilename })) });

describe('pickGgufSibling', () => {
  it('matches a quant hint across the naming styles repos actually publish', () => {
    const model = siblings('README.md', 'Qwen3.8-27B-q4_k_m.gguf', 'Qwen3.8-27B-Q8_0.gguf');
    expect(pickGgufSibling(model, { quant: 'Q4_K_M', repo: 'o/r' })).toBe('Qwen3.8-27B-q4_k_m.gguf');
  });

  it('prefers the plainest name when several builds carry the quant', () => {
    const model = siblings('Qwen3.8-27B-Q4_K_M-abliterated.gguf', 'Qwen3.8-27B-Q4_K_M.gguf');
    expect(pickGgufSibling(model, { quant: 'Q4_K_M', repo: 'o/r' })).toBe('Qwen3.8-27B-Q4_K_M.gguf');
  });

  it('honours an exact filename over the quant hint', () => {
    const model = siblings('pinned.gguf', 'Qwen3.8-27B-Q4_K_M.gguf');
    expect(pickGgufSibling(model, { file: 'pinned.gguf', quant: 'Q4_K_M', repo: 'o/r' })).toBe('pinned.gguf');
  });

  // A preset pins `file` only where the quant tag can't discriminate the target,
  // so falling back to the hint when the pin is gone reinstates the ambiguity —
  // here it would fetch the 1.6 GB drafter into the base model's path.
  it('refuses to fall back to the quant hint when a pinned file is gone', () => {
    const model = siblings(
      'Muse-Glimmer-30B-KQuant-Dynamic-Q4_K_XL.gguf',
      'dflash-Muse-Glimmer-30B-Q4_K_M.gguf',
    );
    expect(() => pickGgufSibling(model, {
      file: 'Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf',
      quant: 'Q4_K_M',
      repo: 'meta-models/Muse-Glimmer-30B-GGUF',
    })).toThrow(/no longer publishes the pinned file/i);
  });

  // A lone shard on disk would satisfy the launcher's existence check and then
  // fail at load — the exact confusion this module exists to remove.
  it('refuses a sharded-only repo instead of fetching part one', () => {
    const model = siblings('Qwen3.8-27B-Q4_K_M-00001-of-00003.gguf', 'Qwen3.8-27B-Q4_K_M-00002-of-00003.gguf');
    expect(() => pickGgufSibling(model, { quant: 'Q4_K_M', repo: 'o/r' })).toThrow(/sharded/i);
  });

  it('names the available builds when the requested quant is absent', () => {
    const model = siblings('Qwen3.8-27B-Q8_0.gguf');
    expect(() => pickGgufSibling(model, { quant: 'Q4_K_M', repo: 'o/r' })).toThrow(/Q8_0/);
  });

  it('rejects a repo with no GGUF at all', () => {
    expect(() => pickGgufSibling(siblings('model.safetensors'), { quant: 'Q4_K_M', repo: 'o/r' })).toThrow(/no \.gguf/i);
  });

  // meta-models/Muse-Glimmer-30B-GGUF ships the projector and the repo's own
  // drafter beside the target, all three tagged Q4_K_M. Shortest-name-wins would
  // hand back the 1.4 GB `mmproj-…`, which then satisfies the launcher's
  // existence check and fails at load.
  it('never auto-picks an mmproj projector that carries the wanted quant', () => {
    const model = siblings(
      'Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf',
      'mmproj-Muse-Glimmer-30B-Q4_K_M.gguf',
    );
    expect(pickGgufSibling(model, { quant: 'Q4_K_M', repo: 'meta-models/Muse-Glimmer-30B-GGUF' }))
      .toBe('Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf');
  });

  it('says "projectors only" rather than blaming sharding when that is all a repo has', () => {
    expect(() => pickGgufSibling(siblings('mmproj-model-Q4_K_M.gguf'), { quant: 'Q4_K_M', repo: 'o/r' }))
      .toThrow(/projector \(mmproj\) sidecars/i);
  });

  it('still honours an explicit projector filename', () => {
    const model = siblings('model-Q4_K_M.gguf', 'mmproj-model-Q4_K_M.gguf');
    expect(pickGgufSibling(model, { file: 'mmproj-model-Q4_K_M.gguf', quant: 'Q4_K_M', repo: 'o/r' }))
      .toBe('mmproj-model-Q4_K_M.gguf');
  });

  // The preset pins `file` precisely because the quant hint is ambiguous here;
  // this asserts the pin still resolves against the repo's real sibling list.
  it('resolves the Muse-Glimmer preset to the 17 GB target, not its dflash sidecar', () => {
    const entry = specDecodePresets.findSpecDecodePreset('muse-glimmer-30b').model;
    const model = siblings(
      'Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf',
      'Muse-Glimmer-30B-KQuant-Dynamic-Q4_K_XL.gguf',
      'dflash-Muse-Glimmer-30B-Q4_K_M.gguf',
      'mmproj-Muse-Glimmer-30B-Q4_K_M.gguf',
    );
    expect(pickGgufSibling(model, { file: entry.file, quant: entry.quant, repo: entry.repo }))
      .toBe('Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf');
  });
});

describe('getSpecDecodePresetStatus', () => {
  it('reports each preset file as on-disk or not, without reaching Hugging Face', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const presets = await getSpecDecodePresetStatus();

    const recommended = presets.find((p) => p.id === 'qwen3.8-27b-dspark');
    expect(recommended.model.path).toMatch(/\.gguf$/);
    expect(recommended.model.exists).toBe(false);
    expect(recommended.model.downloadable).toBe(true);
    expect(recommended.model.repoUrl).toContain('huggingface.co');
    const q2k = presets.find((p) => p.id === 'qwen3.8-27b-dflash2-q2k');
    expect(q2k.specType).toBe('draft-dflash');
    expect(q2k.draftModel.path).toMatch(/DFlash2-Q2_K\.gguf$/);
    expect(q2k.draftModel.repo).toBe('analogalok/Qwen3.8-27B-DFlash2-Q2_K-GGUF');
    expect(q2k.draftModel.downloadable).toBe(true);
    // `custom` carries no paths, so it has no weights rows to render.
    expect(presets.find((p) => p.id === 'custom').model).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('downloadSpecDecodeModel', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'portos-spec-decode-'));
    _resetSpecDecodeDownloadsForTests();
    vi.spyOn(hfToken, 'getHfToken').mockResolvedValue(null);
  });

  afterEach(async () => {
    _resetSpecDecodeDownloadsForTests();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const stubPreset = (overrides = {}) => {
    const preset = {
      id: 'test-preset',
      label: 'Test',
      specType: 'draft-dspark',
      model: { path: join(dir, 'base.gguf'), repo: 'acme/Example-GGUF', quant: 'Q4_K_M' },
      draftModel: { path: join(dir, 'draft.gguf') },
      ...overrides,
    };
    vi.spyOn(specDecodePresets, 'specDecodeSource').mockImplementation((id, role) => {
      if (id !== preset.id) return null;
      const entry = preset[role];
      return entry?.repo && entry?.path ? entry : null;
    });
    return preset;
  };

  it('streams the resolved GGUF into the launcher path', async () => {
    stubPreset();
    vi.spyOn(huggingfaceLora, 'fetchHuggingfaceModel').mockResolvedValue(siblings('Example-Q4_K_M.gguf'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => '6' },
      body: Readable.toWeb(Readable.from([Buffer.from('gg'), Buffer.from('ufgg')])),
    });
    const frames = [];

    const result = await downloadSpecDecodeModel({
      presetId: 'test-preset',
      role: 'model',
      onProgress: (frame) => frames.push(frame),
    });

    expect(result.file).toBe('Example-Q4_K_M.gguf');
    expect(await readFile(join(dir, 'base.gguf'), 'utf8')).toBe('ggufgg');
    expect(frames.at(-1)).toMatchObject({ event: 'complete', role: 'model' });
  });

  it('leaves no .partial behind when the transfer fails mid-stream', async () => {
    stubPreset();
    vi.spyOn(huggingfaceLora, 'fetchHuggingfaceModel').mockResolvedValue(siblings('Example-Q4_K_M.gguf'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => '99' },
      body: Readable.toWeb(new Readable({
        read() { this.destroy(new Error('connection reset')); },
      })),
    });

    await expect(downloadSpecDecodeModel({ presetId: 'test-preset', role: 'model' }))
      .rejects.toThrow(/connection reset/);
    const { readdir } = await import('fs/promises');
    expect(await readdir(dir)).toEqual([]);
  });

  it('cancels an active transfer, emits a terminal frame, and removes its partial file', async () => {
    stubPreset();
    vi.spyOn(huggingfaceLora, 'fetchHuggingfaceModel').mockResolvedValue(siblings('Example-Q4_K_M.gguf'));
    let signal;
    const stream = new Readable({ read() {} });
    stream.push(Buffer.from('gg'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      signal = options.signal;
      signal.addEventListener('abort', () => stream.destroy(new Error('aborted')));
      return {
        ok: true,
        status: 200,
        headers: { get: () => '99' },
        body: Readable.toWeb(stream),
      };
    });
    const frames = [];
    const download = downloadSpecDecodeModel({
      presetId: 'test-preset', role: 'model', onProgress: (frame) => frames.push(frame),
    });

    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(cancelSpecDecodeModelDownload({ presetId: 'test-preset', role: 'model' })).toBe(true);
    await expect(download).rejects.toMatchObject({ code: 'SPEC_DOWNLOAD_CANCELLED' });

    const { readdir } = await import('fs/promises');
    expect(await readdir(dir)).toEqual([]);
    expect(frames.at(-1)).toMatchObject({ event: 'cancelled', message: 'Download cancelled' });
  });

  it('aborts a byte-silent transfer when its idle watchdog expires', async () => {
    vi.useFakeTimers();
    stubPreset();
    vi.spyOn(huggingfaceLora, 'fetchHuggingfaceModel').mockResolvedValue(siblings('Example-Q4_K_M.gguf'));
    let signal;
    const stream = new Readable({ read() {} });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      signal = options.signal;
      signal.addEventListener('abort', () => stream.destroy(new Error('aborted')));
      return {
        ok: true,
        status: 200,
        headers: { get: () => '99' },
        body: Readable.toWeb(stream),
      };
    });

    const download = downloadSpecDecodeModel({ presetId: 'test-preset', role: 'model' });
    await vi.waitFor(() => expect(signal).toBeDefined());
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    await expect(download).rejects.toMatchObject({ code: 'SPEC_DOWNLOAD_STALLED' });
    vi.useRealTimers();
  });

  // The slot is claimed before the Hugging Face round trip: a second click
  // landing inside that window would otherwise clear the in-flight check and
  // start a parallel multi-gigabyte transfer of the same file.
  it('refuses a second request that arrives while the repo is still being resolved', async () => {
    stubPreset();
    let releaseMetadata;
    vi.spyOn(huggingfaceLora, 'fetchHuggingfaceModel').mockImplementation(
      () => new Promise((resolve) => { releaseMetadata = () => resolve(siblings('Example-Q4_K_M.gguf')); }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => '2' },
      body: Readable.toWeb(Readable.from([Buffer.from('gg')])),
    });

    const first = downloadSpecDecodeModel({ presetId: 'test-preset', role: 'model' });
    await vi.waitFor(() => expect(releaseMetadata).toBeTypeOf('function'));

    await expect(downloadSpecDecodeModel({ presetId: 'test-preset', role: 'model' }))
      .rejects.toThrow(/already downloading/);

    releaseMetadata();
    await expect(first).resolves.toMatchObject({ success: true });
  });

  // …and the claim is released when that resolution fails, or the file could
  // never be retried without restarting the server.
  it('releases the claim when resolving the repo fails', async () => {
    stubPreset();
    vi.spyOn(huggingfaceLora, 'fetchHuggingfaceModel').mockRejectedValue(new Error('HF unreachable'));

    await expect(downloadSpecDecodeModel({ presetId: 'test-preset', role: 'model' }))
      .rejects.toThrow(/HF unreachable/);

    const status = await getSpecDecodePresetStatus();
    expect(status.every((p) => !p.model?.downloading && !p.draftModel?.downloading)).toBe(true);
  });

  it('short-circuits when the weights are already on disk', async () => {
    stubPreset();
    await writeFile(join(dir, 'base.gguf'), 'already here');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await downloadSpecDecodeModel({ presetId: 'test-preset', role: 'model' });

    expect(result).toMatchObject({ success: true, alreadyDownloaded: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // The drafter half of some pairs ships safetensors only — the UI links out
  // rather than offering a button, and the route has to agree.
  it('refuses a role with no registered Hugging Face source', async () => {
    stubPreset();
    await expect(downloadSpecDecodeModel({ presetId: 'test-preset', role: 'draftModel' }))
      .rejects.toThrow(/No Hugging Face source/);
  });

  it('rejects an unknown role outright', async () => {
    await expect(downloadSpecDecodeModel({ presetId: 'test-preset', role: 'sneaky' }))
      .rejects.toThrow(/Unknown model role/);
  });
});

describe('resolveSpecModelPath', () => {
  it('resolves a relative launcher path to an absolute one', () => {
    const resolved = resolveSpecModelPath('models/base.gguf');
    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(join('models', 'base.gguf'))).toBe(true);
  });

  // `spawn` performs no shell expansion, so a `~` path has to be expanded here
  // or the launcher and the downloader disagree about which file they mean.
  it('expands a leading ~ rather than passing it through literally', () => {
    const resolved = resolveSpecModelPath('~/models/base.gguf');
    expect(resolved.startsWith(homedir())).toBe(true);
    expect(resolved).not.toContain('~');
  });
});
