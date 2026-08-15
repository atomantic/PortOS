import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { pinPlatform } from './testHelper.js';

const __dirname_self = dirname(fileURLToPath(import.meta.url));
const SAMPLE_REGISTRY_PATH = join(__dirname_self, '..', '..', 'data.reference', 'media-models.json');

let tmpDir;
let registryFile;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'portos-media-models-'));
  registryFile = join(tmpDir, 'media-models.json');
  process.env.PORTOS_MEDIA_MODELS_FILE = registryFile;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.PORTOS_MEDIA_MODELS_FILE;
  rmSync(tmpDir, { recursive: true, force: true });
});

// data.reference/media-models.json must mirror the in-code DEFAULT_REGISTRY so
// `npm run setup:data` (which copies data.reference → data on fresh installs)
// produces the same starting state as the runtime `seedIfMissing()` fallback.
// Compares the seed file to a freshly-bootstrapped registry with
// _shippedDefaults stripped (that's a runtime-only field).
describe('data.reference seed file', () => {
  it('matches the runtime-seeded DEFAULT_REGISTRY', async () => {
    const sample = JSON.parse(readFileSync(SAMPLE_REGISTRY_PATH, 'utf-8'));
    const { loadMediaModels } = await import('./mediaModels.js');
    const live = loadMediaModels();
    const { _shippedDefaults: _omit, ...liveSeed } = live;
    expect(sample).toEqual(liveSeed);
  });
});

describe('mediaModels registry', () => {
  it('seeds the registry file on first load', async () => {
    expect(existsSync(registryFile)).toBe(false);
    const { loadMediaModels } = await import('./mediaModels.js');
    loadMediaModels();
    expect(existsSync(registryFile)).toBe(true);
    const seeded = JSON.parse(readFileSync(registryFile, 'utf-8'));
    expect(seeded.video).toBeDefined();
    expect(seeded.image).toBeDefined();
    expect(seeded.textEncoders).toBeDefined();
    expect(seeded.selectedTextEncoder).toBe('gemma-bf16');
  });

  it('returns the platform-specific video model list', async () => {
    const { getVideoModels } = await import('./mediaModels.js');
    const list = getVideoModels();
    expect(Array.isArray(list)).toBe(true);
    expect(list.every((m) => m.id && m.name)).toBe(true);
  });

  it('ships LTX-2.5 MLX Q8 as a sibling runtime of the 2.3 dgrauet pin', async () => {
    const { loadMediaModels } = await import('./mediaModels.js');
    const ltx25 = loadMediaModels().video.mlx.find((model) => model.id === 'ltx25_mlx_q8');
    expect(ltx25).toMatchObject({
      runtime: 'ltx25',
      repo: 'MrMofer/ltx-2.5-mlx-q8',
      revision: 'f1b56e7dc89f71a9af2cddac787b89ed22a8b7fc',
      steps: 8,
    });
    expect(ltx25.disclosure.weightsLicense.name).toBe('LTX-2.x Community License');
    expect(ltx25.disclosure.estimatedDownloadGb).toBe(67.7);
  });

  it('ships MiniMax H3 as a pinned, keyframe-capable 128 GB BYOV profile', async () => {
    const { loadMediaModels } = await import('./mediaModels.js');
    // H3 is an Apple-silicon MLX runtime, so inspect the shipped macOS catalog
    // directly instead of the current platform's filtered model list.
    const h3 = loadMediaModels().video.mlx.find((model) => model.id === 'minimax_h3_8bit');
    expect(h3).toMatchObject({
      runtime: 'minimax_h3',
      repo: 'pipenetwork/MiniMax-H3-MLX-8bit',
      revision: '3ac52081470b0488921c3ec3ba84a39097bf2361',
      supportedModes: ['text', 'image', 'fflf'],
      defaultFrames: 124,
      defaultWidth: 1344,
      defaultHeight: 768,
      resolutionStep: 32,
      fpsOptions: [24],
      memoryGb: 128,
      samplerLocked: true,
      steps: 8,
    });
    expect(h3.frameOptions).toEqual([107, 124, 141, 158, 175, 192, 209, 226, 243, 260, 277, 294, 311, 328, 345, 362]);
    expect(h3.resolutionOptions).toEqual([
      { label: '1536x672 (21:9 H3 native)', w: 1536, h: 672 },
      { label: '1344x768 (16:9 H3 default)', w: 1344, h: 768 },
      { label: '1024x768 (4:3 H3 native)', w: 1024, h: 768 },
      { label: '768x768 (1:1 H3 native)', w: 768, h: 768 },
      { label: '768x1024 (3:4 H3 native)', w: 768, h: 1024 },
      { label: '768x1344 (9:16 H3 native)', w: 768, h: 1344 },
    ]);
    expect(h3.requiredWeights[0]).toMatchObject({
      repo: 'MiniMaxAI/MiniMax-H3',
      revision: '6818f6c32d12b210915e44ad56a4228c2608f160',
    });
    // Keyframe conditioning runs each image through Qwen3-VL's AutoProcessor,
    // which reads `processor/` — not the `tokenizer/` directory the text path
    // uses. Without these the vision path dies on a cache miss ~83 GB into
    // loading, so they belong in the base download, not a second opt-in pull.
    expect(h3.requiredWeights[0].files.filter((file) => file.startsWith('FL2VA/processor/')))
      .toEqual([
        'FL2VA/processor/chat_template.json',
        'FL2VA/processor/merges.txt',
        'FL2VA/processor/preprocessor_config.json',
        'FL2VA/processor/tokenizer.json',
        'FL2VA/processor/tokenizer_config.json',
        'FL2VA/processor/video_preprocessor_config.json',
        'FL2VA/processor/vocab.json',
      ]);
    // The pinned port builds only decoder layers 0-49. Shards 12/13 contain
    // only layers 53-63, which its _wanted() loader deliberately skips; shard
    // 14 remains required for the final norm — and, since every `model.visual.*`
    // tensor also lives there, for the vision tower keyframes load. Keep this
    // selective 12-shard contract explicit so a generic "download every index
    // shard" rewrite does not add roughly 10 GB of weights H3 never loads.
    expect(h3.requiredWeights[0].files.filter((file) => /model-\d{5}-of-00014\.safetensors$/.test(file)))
      .toEqual([
        ...Array.from(
          { length: 11 },
          (_, index) => `FL2VA/text_encoder/model-${String(index + 1).padStart(5, '0')}-of-00014.safetensors`,
        ),
        'FL2VA/text_encoder/model-00014-of-00014.safetensors',
      ]);
    expect(h3.termsGate.id).toBe('minimax-h3-community-license-2026-08-02');
  });

  it('ships MiniMax H3 CUDA as the NVIDIA H3 profile', async () => {
    const { loadMediaModels } = await import('./mediaModels.js');
    // The CUDA entry is CUDA-bucket-only, so inspect the shipped catalog
    // directly rather than the current platform's filtered list.
    const h3 = loadMediaModels().video.cuda.find((model) => model.id === 'minimax_h3_cuda');
    expect(h3).toMatchObject({
      runtime: 'minimax_h3_cuda',
      repo: 'MiniMaxAI/MiniMax-H3',
      revision: '42ed227ee7df40d41602854ae760620d6eb651fe',
      supportedModes: ['text', 'image', 'fflf'],
      defaultFrames: 124,
      fpsOptions: [24],
      samplerLocked: true,
      supportsNegativePrompt: false,
      supportsDisableAudio: false,
      steps: 8,
    });
    // Same canvas contract as the MLX profile — it's the checkpoint's, not the
    // runner's — so these must not drift apart.
    const mlx = loadMediaModels().video.mlx.find((model) => model.id === 'minimax_h3_8bit');
    expect(h3.defaultWidth).toBe(mlx.defaultWidth);
    expect(h3.defaultHeight).toBe(mlx.defaultHeight);
    expect(h3.resolutionStep).toBe(mlx.resolutionStep);
    expect(h3.resolutionOptions).toEqual(mlx.resolutionOptions);
    // The frame grid, by contrast, MUST differ: diffusers snaps to 17n+5 and
    // then requires 5-15 s, so the MLX grid's 107 (4.46 s) and 362 (15.08 s)
    // ends are both illegal here.
    expect(h3.frameOptions).toEqual([124, 141, 158, 175, 192, 209, 226, 243, 260, 277, 294, 311, 328, 345]);
    expect(h3.frameOptions).not.toContain(107);
    expect(h3.frameOptions).not.toContain(362);
    expect(h3.frameOptions.every((n) => n % 17 === 5)).toBe(true);
    // Same weights, same license, so one acceptance covers both entries.
    expect(h3.termsGate.id).toBe(mlx.termsGate.id);
  });

  it('pins an explicit file list for MiniMax H3 CUDA rather than a repo snapshot', async () => {
    const { loadMediaModels } = await import('./mediaModels.js');
    const h3 = loadMediaModels().video.cuda.find((model) => model.id === 'minimax_h3_cuda');
    // `MiniMaxAI/MiniMax-H3` is ~498 GB: it carries the diffusers layout, the
    // `transformer_ref/` partition for the ref2va workflow PortOS doesn't
    // expose, AND the original non-diffusers FL2VA/ + Ref2VA/ layouts the MLX
    // port consumes. Snapshotting it would pull 3.5x what the runner loads, so
    // the absence of this list is a download bug, not a missing optimization.
    expect(Array.isArray(h3.repoFiles)).toBe(true);
    expect(h3.repoFiles).not.toHaveLength(0);
    for (const prefix of ['transformer_ref/', 'FL2VA/', 'Ref2VA/', 'assets/', 'scripts/', 'docs/']) {
      expect(h3.repoFiles.filter((file) => file.startsWith(prefix)), prefix).toEqual([]);
    }
    // Every sharded component needs its index AND all of its shards; a missing
    // shard only surfaces as a cache-resolve failure deep into a render.
    for (const [dir, stem, count] of [
      ['transformer', 'diffusion_pytorch_model', 14],
      ['text_encoder', 'model', 14],
      ['vae', 'diffusion_pytorch_model', 3],
    ]) {
      expect(h3.repoFiles, `${dir} index`).toContain(`${dir}/${stem}.safetensors.index.json`);
      const shards = h3.repoFiles.filter((file) => new RegExp(`^${dir}/${stem}-\\d{5}-of-\\d{5}\\.safetensors$`).test(file));
      expect(shards, `${dir} shards`).toEqual(Array.from(
        { length: count },
        (_, i) => `${dir}/${stem}-${String(i + 1).padStart(5, '0')}-of-${String(count).padStart(5, '0')}.safetensors`,
      ));
    }
    // Keyframe conditioning runs each image through Qwen3-VL's AutoProcessor,
    // which reads `processor/` — same requirement as the MLX profile.
    expect(h3.repoFiles).toContain('processor/preprocessor_config.json');
    expect(h3.repoFiles).toContain('audio_vae/diffusion_pytorch_model.safetensors');
    expect(h3.repoFiles).toContain('modular_model_index.json');
    // Every path stays repo-relative POSIX — the download route rejects
    // anything else as VIDEO_MODEL_MISCONFIGURED.
    expect(h3.repoFiles.every((file) => !file.startsWith('/') && !file.includes('..') && !file.includes('\\'))).toBe(true);
  });

  // #3737: capability has to be answerable off the entry, or every consumer
  // re-derives it from `runtime` string comparisons and the two ends drift.
  describe('supportedModes resolution (#3737)', () => {
    it('resolves supportedModes for every entry this platform can run', async () => {
      const { getVideoModels } = await import('./mediaModels.js');
      for (const entry of getVideoModels()) {
        expect(Array.isArray(entry.supportedModes), entry.id).toBe(true);
        expect(entry.supportedModes.length, entry.id).toBeGreaterThan(0);
      }
    });

    it('ships a runtime table row for every runtime in the seed, on both platforms', async () => {
      const { VIDEO_RUNTIME_MODES } = await import('./videoModeProfiles.js');
      const { loadMediaModels } = await import('./mediaModels.js');
      const { video } = loadMediaModels();
      for (const entry of [...video.mlx, ...video.cuda]) {
        expect(Object.keys(VIDEO_RUNTIME_MODES), entry.id).toContain(entry.runtime);
      }
    });

    it('retires the hunyuan legacy `mode: t2v` field for a text-only contract', async () => {
      const { loadMediaModels, getVideoModels } = await import('./mediaModels.js');
      expect(loadMediaModels().video.mlx.find((m) => m.id === 'hunyuan_video').mode).toBeUndefined();
      const hunyuan = getVideoModels().find((m) => m.id === 'hunyuan_video');
      // The CUDA bucket ships no hunyuan entry, so only assert where it's runnable.
      if (hunyuan) expect(hunyuan.supportedModes).toEqual(['text']);
    });

    it('is derived on read — never persisted back into the registry file', async () => {
      const { loadMediaModels, getVideoModels } = await import('./mediaModels.js');
      loadMediaModels();
      expect(getVideoModels().every((m) => Array.isArray(m.supportedModes))).toBe(true);
      // A persisted copy would read back as a *declared* list, freezing this
      // install's built-ins against any later correction to VIDEO_RUNTIME_MODES.
      const onDisk = JSON.parse(readFileSync(registryFile, 'utf-8'));
      const mlx = [...onDisk.video.mlx, ...onDisk.video.cuda]
        .find((m) => m.runtime === 'mlx_video');
      expect(mlx.supportedModes).toBeUndefined();
    });

    it('keeps a user entry that declares its own list, and resolves one that does not', async () => {
      const platform = process.platform === 'darwin' ? 'mlx' : 'cuda';
      writeFileSync(registryFile, JSON.stringify({
        video: {
          mlx: [], cuda: [], defaultMlx: 'custom-narrow', defaultCuda: 'custom-narrow',
          [platform]: [
            { id: 'custom-narrow', name: 'Custom', runtime: 'mlx_video', supportedModes: ['text'], source: 'user' },
            { id: 'custom-bare', name: 'Bare', runtime: 'mlx_video', source: 'user' },
          ],
        },
        // Non-empty so the deletion-survives-upgrade union doesn't re-append
        // the built-ins over the two entries under test.
        _shippedDefaults: { video: { mlx: ['custom-narrow', 'custom-bare'], cuda: ['custom-narrow', 'custom-bare'] } },
      }));
      const { getVideoModels } = await import('./mediaModels.js');
      const byId = new Map(getVideoModels().map((m) => [m.id, m]));
      expect(byId.get('custom-narrow').supportedModes).toEqual(['text']);
      expect(byId.get('custom-bare').supportedModes).toEqual(['text', 'image', 'fflf', 'extend']);
    });
  });

  it('hides models with broken === current platform', async () => {
    const here = process.platform === 'darwin' ? 'mlx' : 'cuda';
    const elsewhere = process.platform === 'darwin' ? 'cuda' : 'mlx';
    writeFileSync(registryFile, JSON.stringify({
      video: { mlx: [], cuda: [], defaultMlx: 'x', defaultCuda: 'x' },
      image: [
        { id: 'works', name: 'Works' },
        { id: 'broken-here', name: 'Broken Here', broken: here },
        { id: 'broken-other', name: 'Broken Elsewhere', broken: elsewhere },
      ],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
    }));
    const { getImageModels } = await import('./mediaModels.js');
    const ids = getImageModels().map((m) => m.id);
    expect(ids).toContain('works');
    expect(ids).toContain('broken-other');
    expect(ids).not.toContain('broken-here');
  });

  it('expandHome resolves ~/ correctly without dropping the home dir', async () => {
    writeFileSync(registryFile, JSON.stringify({
      video: { mlx: [], cuda: [], defaultMlx: 'x', defaultCuda: 'x' },
      image: [],
      textEncoders: [
        { id: 'tilde-only', label: 't', repo: 'r1', localPath: '~' },
        { id: 'tilde-slash', label: 't', repo: 'r2', localPath: '~/some/nonexistent/path' },
      ],
      selectedTextEncoder: 'tilde-slash',
    }));
    const { getTextEncoderEntries } = await import('./mediaModels.js');
    const entries = getTextEncoderEntries();
    const tilde = entries.find((e) => e.id === 'tilde-only');
    const slash = entries.find((e) => e.id === 'tilde-slash');
    // The bug being guarded against: `path.join(homedir(), '/.foo')` discards
    // the homedir because the second segment starts with /. The fix strips
    // the `~/` prefix before joining. Result MUST start with the user's
    // actual home directory, not just `/`.
    expect(slash.localPath.startsWith(homedir())).toBe(true);
    // Use path.join to assemble the expected suffix so the assertion
    // works on Windows (where the joined path uses backslashes) as well
    // as POSIX. The earlier `toContain('/some/nonexistent/path')` would
    // fail under win32's backslash-separated paths.
    expect(slash.localPath.endsWith(join('some', 'nonexistent', 'path'))).toBe(true);
    expect(tilde.localPath).toBe(homedir());
  });

  it('getTextEncoderRepo prefers existing localPath over repo', async () => {
    writeFileSync(registryFile, JSON.stringify({
      video: { mlx: [], cuda: [], defaultMlx: 'x', defaultCuda: 'x' },
      image: [],
      textEncoders: [
        { id: 'has-local', label: 'L', repo: 'org/repo', localPath: tmpDir },
      ],
      selectedTextEncoder: 'has-local',
    }));
    const { getTextEncoderRepo } = await import('./mediaModels.js');
    expect(getTextEncoderRepo()).toBe(tmpDir);
  });

  it('getTextEncoderRepo falls back to repo when localPath does not exist', async () => {
    writeFileSync(registryFile, JSON.stringify({
      video: { mlx: [], cuda: [], defaultMlx: 'x', defaultCuda: 'x' },
      image: [],
      textEncoders: [{ id: 't', label: 't', repo: 'org/repo', localPath: '/definitely/not/existing/12345' }],
      selectedTextEncoder: 't',
    }));
    const { getTextEncoderRepo } = await import('./mediaModels.js');
    expect(getTextEncoderRepo()).toBe('org/repo');
  });

  it('falls back to defaults on malformed JSON without crashing', async () => {
    writeFileSync(registryFile, '{ this is not valid json');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadMediaModels } = await import('./mediaModels.js');
    const reg = loadMediaModels();
    expect(reg.video).toBeDefined();
    expect(reg.selectedTextEncoder).toBe('gemma-bf16');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load'));
    logSpy.mockRestore();
  });

  it('caches the registry across calls (no repeat parse)', async () => {
    const { loadMediaModels } = await import('./mediaModels.js');
    const first = loadMediaModels();
    writeFileSync(registryFile, JSON.stringify({ ...first, selectedTextEncoder: 'gemma-4bit' }));
    const second = loadMediaModels();
    expect(second.selectedTextEncoder).toBe(first.selectedTextEncoder);
  });

  it('getDefaultVideoModelId returns the per-platform default', async () => {
    const { getDefaultVideoModelId } = await import('./mediaModels.js');
    const id = getDefaultVideoModelId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('normalizes a registry missing the video key without crashing consumers', async () => {
    // Simulates a user editing media-models.json down to just textEncoders.
    // Without normalization, getVideoModels() / buildAppModels() would throw
    // at module import-time and take down the server.
    writeFileSync(registryFile, JSON.stringify({
      image: [],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
    }));
    const { loadMediaModels, getVideoModels, getDefaultVideoModelId } = await import('./mediaModels.js');
    const reg = loadMediaModels();
    expect(reg.video).toBeDefined();
    expect(Array.isArray(reg.video.mlx)).toBe(true);
    expect(Array.isArray(reg.video.cuda)).toBe(true);
    expect(getVideoModels().length).toBeGreaterThan(0);
    expect(typeof getDefaultVideoModelId()).toBe('string');
  });

  it('coerces wrong-type fields back to defaults', async () => {
    // Parseable JSON but with non-array values where the consumers expect
    // arrays — without coercion, getImageModels()/getVideoModels() throw at
    // module import-time.
    writeFileSync(registryFile, JSON.stringify({
      video: { mlx: 'ltx', cuda: { id: 'oops' } },
      image: {},
      textEncoders: 'gemma',
      selectedTextEncoder: 'gemma-bf16',
    }));
    const { loadMediaModels, getVideoModels, getImageModels } = await import('./mediaModels.js');
    const reg = loadMediaModels();
    expect(Array.isArray(reg.video.mlx)).toBe(true);
    expect(Array.isArray(reg.video.cuda)).toBe(true);
    expect(Array.isArray(reg.image)).toBe(true);
    expect(Array.isArray(reg.textEncoders)).toBe(true);
    expect(() => getVideoModels()).not.toThrow();
    expect(() => getImageModels()).not.toThrow();
  });

  it('normalizes an empty object registry by merging defaults', async () => {
    writeFileSync(registryFile, JSON.stringify({}));
    const { loadMediaModels } = await import('./mediaModels.js');
    const reg = loadMediaModels();
    expect(reg.video.defaultMlx).toBeDefined();
    expect(reg.textEncoders.length).toBeGreaterThan(0);
  });

  it('getDefaultVideoModelId falls back to first available when configured id is unknown', async () => {
    const platformKey = process.platform === 'darwin' ? 'mlx' : 'cuda';
    const otherKey = process.platform === 'darwin' ? 'cuda' : 'mlx';
    writeFileSync(registryFile, JSON.stringify({
      video: {
        mlx: [],
        cuda: [],
        [platformKey]: [
          { id: 'real-model', name: 'Real' },
          { id: 'other', name: 'Other' },
        ],
        [otherKey]: [],
        defaultMlx: 'nonexistent-typo',
        defaultCuda: 'nonexistent-typo',
      },
      image: [],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { getDefaultVideoModelId } = await import('./mediaModels.js');
    expect(getDefaultVideoModelId()).toBe('real-model');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('falling back'));
    logSpy.mockRestore();
  });

  it('getTextEncoderRepo falls back when entry has no repo string', async () => {
    writeFileSync(registryFile, JSON.stringify({
      video: { mlx: [], cuda: [], defaultMlx: 'x', defaultCuda: 'x' },
      image: [],
      textEncoders: [{ id: 't', label: 't' }], // no repo field
      selectedTextEncoder: 't',
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { getTextEncoderRepo } = await import('./mediaModels.js');
    const repo = getTextEncoderRepo();
    expect(typeof repo).toBe('string');
    expect(repo.length).toBeGreaterThan(0);
    logSpy.mockRestore();
  });

  it('falls back to defaults when registry file read fails (e.g., permissions)', async () => {
    // Point at a path that exists as a directory — readFileSync will throw
    // EISDIR rather than parse-fail, exercising the read error path.
    process.env.PORTOS_MEDIA_MODELS_FILE = tmpDir;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadMediaModels } = await import('./mediaModels.js');
    const reg = loadMediaModels();
    expect(reg.video).toBeDefined();
    expect(reg.selectedTextEncoder).toBe('gemma-bf16');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load'));
    logSpy.mockRestore();
  });

  it('getDefaultVideoModelId skips broken-on-platform models when falling back', async () => {
    const platformKey = process.platform === 'darwin' ? 'mlx' : 'cuda';
    const here = process.platform === 'darwin' ? 'mlx' : 'cuda';
    const otherKey = process.platform === 'darwin' ? 'cuda' : 'mlx';
    writeFileSync(registryFile, JSON.stringify({
      video: {
        mlx: [],
        cuda: [],
        [platformKey]: [
          { id: 'broken-here', name: 'Broken', broken: here },
          { id: 'works', name: 'Works' },
        ],
        [otherKey]: [],
        defaultMlx: 'broken-here',
        defaultCuda: 'broken-here',
      },
      image: [],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { getDefaultVideoModelId } = await import('./mediaModels.js');
    expect(getDefaultVideoModelId()).toBe('works');
    logSpy.mockRestore();
  });

  // _shippedDefaults — editable-registry contract tests

  it('fresh install: all default video models present; _shippedDefaults populated', async () => {
    // No file exists yet → seedIfMissing writes DEFAULT_REGISTRY, then
    // normalizeRegistry runs over it and sets _shippedDefaults.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadMediaModels } = await import('./mediaModels.js');
    const reg = loadMediaModels();
    // All built-in MLX models should be present
    const { DEFAULT_VIDEO_MODEL_IDS } = await import('./mediaModels.js').then(async (m) => {
      // We don't export the ids directly, so read them from the registry itself
      const r = m.loadMediaModels();
      return { DEFAULT_VIDEO_MODEL_IDS: r.video.mlx.map((e) => e.id) };
    });
    for (const id of DEFAULT_VIDEO_MODEL_IDS) {
      expect(reg.video.mlx.some((e) => e.id === id)).toBe(true);
    }
    // _shippedDefaults should be populated
    expect(reg._shippedDefaults?.video?.mlx?.length).toBeGreaterThan(0);
    // Disk should now contain _shippedDefaults
    const onDisk = JSON.parse(readFileSync(registryFile, 'utf-8'));
    expect(onDisk._shippedDefaults?.video?.mlx?.length).toBeGreaterThan(0);
    logSpy.mockRestore();
  });

  // Retirement has to bite at LOAD, not only in the migration: the registry is
  // cached at import time (before bootstrapServices runs migrations) and
  // persistRegistry writes the whole cached object back on the next edit, so a
  // migration-only retirement is undone by the boot that applied it.
  describe('retired video models', () => {
    const RETIRED_ID = 'ltx2_unified';
    const SHIPPED_REPO = 'notapalindrome/ltx2-mlx-av';

    // _shippedDefaults claims every current built-in so appendNewlyShippedEntries
    // adds nothing — these cases are about what the load REMOVES, and an
    // "everything else is new" fixture would bury it under a dozen appends.
    const shippedMlxIds = JSON.parse(readFileSync(SAMPLE_REGISTRY_PATH, 'utf-8'))
      .video.mlx.map((e) => e.id).concat(RETIRED_ID);

    const writeRegistry = (mlx, defaultMlx = 'ltx23_distilled_q4') => writeFileSync(
      registryFile,
      JSON.stringify({
        video: { mlx, cuda: [], defaultMlx, defaultCuda: 'ltx_video' },
        image: [],
        textEncoders: [{ id: 't', label: 't', repo: 'r' }],
        selectedTextEncoder: 't',
        _shippedDefaults: { video: { mlx: shippedMlxIds, cuda: [] } },
      }),
    );
    const retiredEntry = (repo = SHIPPED_REPO) => ({
      id: RETIRED_ID, name: 'LTX-2 Unified', repo, runtime: 'mlx_video', steps: 30, guidance: 3.0,
    });
    const survivor = { id: 'ltx23_distilled_q4', name: 'LTX-2.3 Q4', repo: 'notapalindrome/ltx23-mlx-av-q4', runtime: 'mlx_video', steps: 25, guidance: 3.0 };

    it('drops a persisted entry that still points at the shipped repo', async () => {
      writeRegistry([retiredEntry(), survivor]);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { loadMediaModels } = await import('./mediaModels.js');
      expect(loadMediaModels().video.mlx.map((e) => e.id)).toEqual(['ltx23_distilled_q4']);
      logSpy.mockRestore();
    });

    // The fork is the escape hatch: a user who re-pointed the entry owns it.
    it('keeps an entry the user re-pointed at another repo', async () => {
      writeRegistry([retiredEntry('example-org/ltx2-fork'), survivor]);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { loadMediaModels } = await import('./mediaModels.js');
      expect(loadMediaModels().video.mlx.map((e) => e.id)).toContain(RETIRED_ID);
      logSpy.mockRestore();
    });

    it('repoints a default that named the retired model at its replacement', async () => {
      writeRegistry([retiredEntry(), survivor], RETIRED_ID);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { loadMediaModels, getDefaultVideoModelId } = await import('./mediaModels.js');
      expect(loadMediaModels().video.defaultMlx).toBe('ltx23_distilled_q4');
      if (process.platform !== 'win32') expect(getDefaultVideoModelId()).toBe('ltx23_distilled_q4');
      logSpy.mockRestore();
    });

    it('leaves the default alone when the fork kept the retired entry', async () => {
      writeRegistry([retiredEntry('example-org/ltx2-fork'), survivor], RETIRED_ID);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { loadMediaModels } = await import('./mediaModels.js');
      expect(loadMediaModels().video.defaultMlx).toBe(RETIRED_ID);
      logSpy.mockRestore();
    });

    it('leaves the stale default alone when the replacement is gone too', async () => {
      writeRegistry([retiredEntry()], RETIRED_ID);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { loadMediaModels } = await import('./mediaModels.js');
      // Nothing left to name — getDefaultVideoModelId's "unknown default →
      // first available" warning is the honest outcome.
      expect(loadMediaModels().video.defaultMlx).toBe(RETIRED_ID);
      logSpy.mockRestore();
    });

    it('does not re-add the retired model as a newly-shipped built-in', async () => {
      writeRegistry([survivor]);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { loadMediaModels } = await import('./mediaModels.js');
      expect(loadMediaModels().video.mlx.some((e) => e.id === RETIRED_ID)).toBe(false);
      logSpy.mockRestore();
    });
  });

  // Like retirement, migration 267's H3 upgrade must also happen at LOAD:
  // routes cache this registry before bootstrap migrations run, and mutators
  // persist the cached object wholesale later in the same boot.
  describe('MiniMax H3 output-control upgrade', () => {
    const OLD_FRAMES = [124, 141, 158, 175, 192, 209, 226, 243, 260, 277, 294, 311, 328, 345, 362];
    const shippedMlxIds = JSON.parse(readFileSync(SAMPLE_REGISTRY_PATH, 'utf-8'))
      .video.mlx.map((entry) => entry.id);
    const legacyH3 = (extra = {}) => ({
      id: 'minimax_h3_8bit',
      name: 'MiniMax H3',
      repo: 'pipenetwork/MiniMax-H3-MLX-8bit',
      runtime: 'minimax_h3',
      defaultFrames: 124,
      frameOptions: [...OLD_FRAMES],
      steps: 8,
      guidance: 0,
      ...extra,
    });
    const writeRegistry = (entry) => writeFileSync(registryFile, JSON.stringify({
      video: { mlx: [entry], cuda: [], defaultMlx: entry.id, defaultCuda: 'ltx_video' },
      image: [],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
      _shippedDefaults: { video: { mlx: shippedMlxIds, cuda: [] } },
    }));

    it('upgrades the cached legacy shipped row before migrations run', async () => {
      writeRegistry(legacyH3());
      const { loadMediaModels } = await import('./mediaModels.js');
      const entry = loadMediaModels().video.mlx[0];
      expect(entry).toMatchObject({
        defaultWidth: 1344,
        defaultHeight: 768,
        resolutionStep: 32,
      });
      expect(entry.frameOptions[0]).toBe(107);
      expect(entry.resolutionOptions).toContainEqual({
        label: '1536x672 (21:9 H3 native)', w: 1536, h: 672,
      });
    });

    it('preserves a repointed row and a partial custom geometry contract', async () => {
      writeRegistry(legacyH3({ repo: 'example-org/h3-fork' }));
      let module = await import('./mediaModels.js');
      expect(module.loadMediaModels().video.mlx[0]).not.toHaveProperty('defaultWidth');

      vi.resetModules();
      writeRegistry(legacyH3({ resolutionStep: 64 }));
      module = await import('./mediaModels.js');
      const entry = module.loadMediaModels().video.mlx[0];
      expect(entry.resolutionStep).toBe(64);
      expect(entry).not.toHaveProperty('resolutionOptions');
    });
  });

  it('user-deleted built-in video model is NOT re-added on subsequent load', async () => {
    const platformKey = process.platform === 'darwin' ? 'mlx' : 'cuda';
    const otherKey = process.platform === 'darwin' ? 'cuda' : 'mlx';
    // Simulate a registry that already has _shippedDefaults (post-bootstrap)
    // but is missing one model the user deleted. The id MUST still be a current
    // built-in — a retired one would pass this assertion for the wrong reason
    // (nothing re-adds a model that left DEFAULT_REGISTRY).
    const deletedId = 'ltx23_dgrauet_q8';
    const remainingMlx = [
      { id: 'ltx23_unified', name: 'LTX-2.3 Unified Beta (~48 GB)', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      { id: 'ltx23_distilled_q4', name: 'LTX-2.3 Distilled Q4 (~22 GB)', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      { id: 'ltx23_dgrauet_q4', name: 'LTX-2.3 dgrauet Q4', runtime: 'ltx2', steps: 8, guidance: 3.0 },
    ];
    const shippedMlxIds = [deletedId, ...remainingMlx.map((e) => e.id)];
    writeFileSync(registryFile, JSON.stringify({
      video: {
        [platformKey]: platformKey === 'mlx' ? remainingMlx : [{ id: 'ltx_video', name: 'LTX', runtime: 'mlx_video', steps: 25, guidance: 3.0 }],
        [otherKey]: [],
        defaultMlx: 'ltx23_distilled_q4',
        defaultCuda: 'ltx_video',
      },
      image: [],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
      _shippedDefaults: {
        video: {
          mlx: shippedMlxIds,
          cuda: ['ltx_video'],
        },
      },
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadMediaModels } = await import('./mediaModels.js');
    const reg = loadMediaModels();
    // The deleted model must NOT be back
    expect(reg.video.mlx.some((e) => e.id === deletedId)).toBe(false);
    // The shipped id must still be tracked
    expect(reg._shippedDefaults.video.mlx).toContain(deletedId);
    logSpy.mockRestore();
  });

  it('new built-in id not in _shippedDefaults is added AND recorded', async () => {
    const platformKey = process.platform === 'darwin' ? 'mlx' : 'cuda';
    const otherKey = process.platform === 'darwin' ? 'cuda' : 'mlx';
    // Simulate a registry that pre-dates a newly-shipped model: _shippedDefaults
    // exists but does NOT include 'ltx23_dgrauet_q8' (as if it shipped later).
    const existingMlx = [
      { id: 'ltx23_unified', name: 'LTX-2.3 Unified', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      { id: 'ltx23_distilled_q4', name: 'LTX-2.3 Q4', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      { id: 'ltx23_dgrauet_q4', name: 'LTX-2.3 dgrauet Q4', runtime: 'ltx2', steps: 8, guidance: 3.0 },
    ];
    // _shippedDefaults does NOT include ltx23_dgrauet_q8
    const shippedMlxIds = existingMlx.map((e) => e.id);
    writeFileSync(registryFile, JSON.stringify({
      video: {
        [platformKey]: platformKey === 'mlx' ? existingMlx : [{ id: 'ltx_video', name: 'LTX', runtime: 'mlx_video', steps: 25, guidance: 3.0 }],
        [otherKey]: [],
        defaultMlx: 'ltx23_distilled_q4',
        defaultCuda: 'ltx_video',
      },
      image: [],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
      _shippedDefaults: {
        video: {
          mlx: shippedMlxIds,
          cuda: ['ltx_video'],
        },
      },
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadMediaModels } = await import('./mediaModels.js');
    const reg = loadMediaModels();
    // ltx23_dgrauet_q8 is a current DEFAULT_REGISTRY entry not yet shipped →
    // should be added to the user's list
    expect(reg.video.mlx.some((e) => e.id === 'ltx23_dgrauet_q8')).toBe(true);
    expect(reg.video.mlx.some((e) => e.id === 'minimax_h3_8bit')).toBe(true);
    // And should now be recorded in _shippedDefaults
    expect(reg._shippedDefaults.video.mlx).toContain('ltx23_dgrauet_q8');
    expect(reg._shippedDefaults.video.mlx).toContain('minimax_h3_8bit');
    // Persisted to disk
    const onDisk = JSON.parse(readFileSync(registryFile, 'utf-8'));
    expect(onDisk._shippedDefaults.video.mlx).toContain('ltx23_dgrauet_q8');
    logSpy.mockRestore();
  });

  // Image-side _shippedDefaults — same contract as video, but tracked as a
  // single list (image entries are platform-agnostic).

  it('fresh install: z-image and flux2 entries seeded; _shippedDefaults.image populated', async () => {
    const { loadMediaModels, getImageModels } = await import('./mediaModels.js');
    loadMediaModels();
    const ids = getImageModels().map((m) => m.id);
    expect(ids).toContain('z-image-turbo-bf16');
    expect(ids).toContain('flux2-klein-4b');
    // Quantized z-image stub is gated off behind broken:true until the user
    // fills in a community repo, so it shouldn't appear in the platform list.
    expect(ids).not.toContain('z-image-turbo-quant');
    const onDisk = JSON.parse(readFileSync(registryFile, 'utf-8'));
    expect(onDisk._shippedDefaults?.image?.list?.length).toBeGreaterThan(0);
    expect(onDisk._shippedDefaults.image.list).toContain('z-image-turbo-bf16');
  });

  // editOnly — backfilled like cfgDisabled so the route/UI can reject a
  // text-only render against a pipeline that requires a source image.

  it('fresh install: qwen-image-edit ships with editOnly: true', async () => {
    const { loadMediaModels, getImageModels, isEditOnly } = await import('./mediaModels.js');
    loadMediaModels();
    const qwenEdit = getImageModels().find((m) => m.id === 'qwen-image-edit');
    expect(qwenEdit).toBeDefined();
    expect(qwenEdit.editOnly).toBe(true);
    expect(isEditOnly(qwenEdit)).toBe(true);
    // The plain text-to-image qwen entry must NOT be flagged edit-only.
    const qwen = getImageModels().find((m) => m.id === 'qwen-image');
    expect(isEditOnly(qwen)).toBe(false);
  });

  it('backfills editOnly onto a pre-flag qwen-image-edit entry (no migration needed)', async () => {
    // Simulate an install that stored qwen-image-edit before the editOnly flag
    // existed — the entry lacks the field entirely.
    writeFileSync(registryFile, JSON.stringify({
      video: { mlx: [], cuda: [], defaultMlx: 'x', defaultCuda: 'x' },
      image: [
        { id: 'qwen-image-edit', name: 'Qwen-Image-Edit', runner: 'qwen', repo: 'Qwen/Qwen-Image-Edit', pipelineClass: 'QwenImageEditPipeline', steps: 30, guidance: 4 },
      ],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
    }));
    const { getImageModels } = await import('./mediaModels.js');
    const qwenEdit = getImageModels().find((m) => m.id === 'qwen-image-edit');
    expect(qwenEdit.editOnly).toBe(true);
  });

  it('preserves an explicit editOnly: false user override', async () => {
    writeFileSync(registryFile, JSON.stringify({
      video: { mlx: [], cuda: [], defaultMlx: 'x', defaultCuda: 'x' },
      image: [
        { id: 'qwen-image-edit', name: 'Qwen-Image-Edit', runner: 'qwen', repo: 'Qwen/Qwen-Image-Edit', pipelineClass: 'QwenImageEditPipeline', steps: 30, guidance: 4, editOnly: false },
      ],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
    }));
    const { getImageModels } = await import('./mediaModels.js');
    const qwenEdit = getImageModels().find((m) => m.id === 'qwen-image-edit');
    expect(qwenEdit.editOnly).toBe(false);
  });

  // kvRepo — bf16 multi-reference editing loads the `-kv` sibling repo. Backfilled
  // at load like cfgDisabled/editOnly, plus a durable migration (064).

  it('fresh install: flux2-klein-9b-bf16 ships with kvRepo set to the kv sibling repo', async () => {
    const { loadMediaModels, getImageModels } = await import('./mediaModels.js');
    loadMediaModels();
    const bf16 = getImageModels().find((m) => m.id === 'flux2-klein-9b-bf16');
    expect(bf16).toBeDefined();
    expect(bf16.kvRepo).toBe('black-forest-labs/FLUX.2-klein-9B-kv');
  });

  it('backfills kvRepo onto a pre-flag flux2-klein-9b-bf16 entry (no migration needed)', async () => {
    writeFileSync(registryFile, JSON.stringify({
      video: { mlx: [], cuda: [], defaultMlx: 'x', defaultCuda: 'x' },
      image: [
        { id: 'flux2-klein-9b-bf16', name: 'Flux 2 Klein 9B (bf16)', runner: 'flux2', quantization: 'none', repo: 'black-forest-labs/FLUX.2-klein-9B', steps: 20, guidance: 3.5 },
      ],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
    }));
    const { getImageModels } = await import('./mediaModels.js');
    const bf16 = getImageModels().find((m) => m.id === 'flux2-klein-9b-bf16');
    expect(bf16.kvRepo).toBe('black-forest-labs/FLUX.2-klein-9B-kv');
  });

  it('preserves an explicit kvRepo user override (including empty-string clear)', async () => {
    writeFileSync(registryFile, JSON.stringify({
      video: { mlx: [], cuda: [], defaultMlx: 'x', defaultCuda: 'x' },
      image: [
        { id: 'flux2-klein-9b-bf16', name: 'Flux 2 Klein 9B (bf16)', runner: 'flux2', quantization: 'none', repo: 'black-forest-labs/FLUX.2-klein-9B', steps: 20, guidance: 3.5, kvRepo: '' },
      ],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
    }));
    const { getImageModels } = await import('./mediaModels.js');
    const bf16 = getImageModels().find((m) => m.id === 'flux2-klein-9b-bf16');
    expect(bf16.kvRepo).toBe('');
  });

  it('does NOT inject kvRepo when repo points at a fork (fork-preservation, mirrors migration 064)', async () => {
    writeFileSync(registryFile, JSON.stringify({
      video: { mlx: [], cuda: [], defaultMlx: 'x', defaultCuda: 'x' },
      image: [
        { id: 'flux2-klein-9b-bf16', name: 'Flux 2 Klein 9B (bf16)', runner: 'flux2', quantization: 'none', repo: 'my-fork/FLUX.2-klein-9B', steps: 20, guidance: 3.5 },
      ],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
    }));
    const { getImageModels } = await import('./mediaModels.js');
    const bf16 = getImageModels().find((m) => m.id === 'flux2-klein-9b-bf16');
    expect('kvRepo' in bf16).toBe(false);
  });

  it('existing install without _shippedDefaults.image gains the new z-image entries on upgrade', async () => {
    // Simulate a pre-z-image registry: only flux2 and Flux 1 entries, no
    // _shippedDefaults.image at all.
    writeFileSync(registryFile, JSON.stringify({
      video: { mlx: [], cuda: [], defaultMlx: 'x', defaultCuda: 'x' },
      image: [
        { id: 'dev', name: 'Flux 1 Dev', steps: 20, guidance: 3.5 },
        { id: 'schnell', name: 'Flux 1 Schnell', steps: 4, guidance: 0 },
      ],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
      _shippedDefaults: { video: { mlx: [], cuda: [] } }, // image key missing
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadMediaModels, getImageModels } = await import('./mediaModels.js');
    const reg = loadMediaModels();
    const ids = getImageModels().map((m) => m.id);
    // New z-image entry must be present after upgrade
    expect(ids).toContain('z-image-turbo-bf16');
    // Pre-existing user entries preserved
    expect(ids).toContain('dev');
    expect(ids).toContain('schnell');
    // _shippedDefaults.image written out
    expect(reg._shippedDefaults.image.list).toContain('z-image-turbo-bf16');
    expect(reg._shippedDefaults.image.list).toContain('dev');
    const onDisk = JSON.parse(readFileSync(registryFile, 'utf-8'));
    expect(onDisk._shippedDefaults.image.list).toContain('z-image-turbo-bf16');
    logSpy.mockRestore();
  });

  it('user deletion of z-image entry survives next load', async () => {
    // _shippedDefaults.image already records z-image-turbo-bf16, but the user
    // has removed it from their image list.
    writeFileSync(registryFile, JSON.stringify({
      video: { mlx: [], cuda: [], defaultMlx: 'x', defaultCuda: 'x' },
      image: [
        { id: 'dev', name: 'Flux 1 Dev', steps: 20, guidance: 3.5 },
        // z-image-turbo-bf16 deliberately absent
      ],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
      _shippedDefaults: {
        video: { mlx: [], cuda: [] },
        image: { list: ['dev', 'z-image-turbo-bf16', 'flux2-klein-4b', 'flux2-klein-9b', 'flux2-klein-4b-int8', 'schnell', 'z-image-turbo-quant'] },
      },
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadMediaModels, getImageModels } = await import('./mediaModels.js');
    const reg = loadMediaModels();
    const ids = getImageModels().map((m) => m.id);
    expect(ids).not.toContain('z-image-turbo-bf16');
    // Still recorded in _shippedDefaults so subsequent loads also honour the deletion
    expect(reg._shippedDefaults.image.list).toContain('z-image-turbo-bf16');
    logSpy.mockRestore();
  });

  it('user deletes a model that was newly added; deletion survives next load', async () => {
    const platformKey = process.platform === 'darwin' ? 'mlx' : 'cuda';
    const otherKey = process.platform === 'darwin' ? 'cuda' : 'mlx';
    // _shippedDefaults includes ltx23_dgrauet_q8 (it was added in a prior
    // load), but the user has now removed it from their video list.
    const userMlx = [
      { id: 'ltx23_unified', name: 'LTX-2.3 Unified', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      { id: 'ltx23_distilled_q4', name: 'LTX-2.3 Q4', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      { id: 'ltx23_dgrauet_q4', name: 'LTX-2.3 dgrauet Q4', runtime: 'ltx2', steps: 8, guidance: 3.0 },
      // ltx23_dgrauet_q8 intentionally absent
    ];
    const shippedMlxIds = [...userMlx.map((e) => e.id), 'ltx23_dgrauet_q8'];
    writeFileSync(registryFile, JSON.stringify({
      video: {
        [platformKey]: platformKey === 'mlx' ? userMlx : [{ id: 'ltx_video', name: 'LTX', runtime: 'mlx_video', steps: 25, guidance: 3.0 }],
        [otherKey]: [],
        defaultMlx: 'ltx23_distilled_q4',
        defaultCuda: 'ltx_video',
      },
      image: [],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
      _shippedDefaults: {
        video: {
          mlx: shippedMlxIds,
          cuda: ['ltx_video'],
        },
      },
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadMediaModels } = await import('./mediaModels.js');
    const reg = loadMediaModels();
    // Deletion must be respected — model NOT re-added
    expect(reg.video.mlx.some((e) => e.id === 'ltx23_dgrauet_q8')).toBe(false);
    // The id stays in _shippedDefaults so future loads also honour the deletion
    expect(reg._shippedDefaults.video.mlx).toContain('ltx23_dgrauet_q8');
    logSpy.mockRestore();
  });

  // _shippedDefaults ↔ image[] drift — surfaced as a loud warning at boot.
  // The deletion-survives-upgrade contract means any built-in in
  // `_shippedDefaults` AND in DEFAULT_REGISTRY but missing from the user's
  // image[] will never be re-added on its own. The drift was real (a
  // 2026-05-09 install hit it after a partial editor save / write race).

  it('drift warning fires when a shipped built-in is missing from image[]', async () => {
    // _shippedDefaults claims z-image-turbo-bf16 was shipped, but the user's
    // image[] array doesn't have it (and it IS a current DEFAULT_REGISTRY
    // entry, so this is true drift — not a legitimate deletion).
    writeFileSync(registryFile, JSON.stringify({
      video: { mlx: [], cuda: [], defaultMlx: 'x', defaultCuda: 'x' },
      image: [
        { id: 'dev', name: 'Flux 1 Dev' },
        // 'z-image-turbo-bf16' deliberately missing
      ],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
      _shippedDefaults: {
        video: { mlx: [], cuda: [] },
        image: { list: ['dev', 'z-image-turbo-bf16'] },
      },
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadMediaModels } = await import('./mediaModels.js');
    loadMediaModels();
    const driftCalls = logSpy.mock.calls
      .map((args) => args.join(' '))
      .filter((line) => line.includes('media-models drift'));
    expect(driftCalls.length).toBeGreaterThan(0);
    expect(driftCalls.some((c) => c.includes('z-image-turbo-bf16'))).toBe(true);
    logSpy.mockRestore();
  });

  it('drift warning does NOT fire for an id no longer in DEFAULT_REGISTRY', async () => {
    // _shippedDefaults includes a legacy id (e.g. an old experimental model
    // that we removed from DEFAULT_REGISTRY) — that's not drift, it's normal
    // upgrade churn. The warning must skip it.
    writeFileSync(registryFile, JSON.stringify({
      video: { mlx: [], cuda: [], defaultMlx: 'x', defaultCuda: 'x' },
      image: [{ id: 'dev', name: 'Flux 1 Dev' }],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
      _shippedDefaults: {
        video: { mlx: [], cuda: [] },
        image: { list: ['dev', 'ancient-removed-model'] },
      },
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadMediaModels } = await import('./mediaModels.js');
    loadMediaModels();
    const driftCalls = logSpy.mock.calls
      .map((args) => args.join(' '))
      .filter((line) => line.includes('media-models drift'));
    expect(driftCalls.some((c) => c.includes('ancient-removed-model'))).toBe(false);
    logSpy.mockRestore();
  });

  it('drift warning fires for the video bucket as well as image', async () => {
    const platformKey = process.platform === 'darwin' ? 'mlx' : 'cuda';
    const otherKey = process.platform === 'darwin' ? 'cuda' : 'mlx';
    // _shippedDefaults claims ltx23_dgrauet_q4 was shipped (and it IS still
    // in DEFAULT_REGISTRY.video.mlx), but the user's mlx list doesn't
    // have it.
    const driftedId = 'ltx23_dgrauet_q4';
    const userPlatformList = platformKey === 'mlx' ? [
      { id: 'ltx23_unified', name: 'LTX-2.3 Unified', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      // ltx23_dgrauet_q4 deliberately absent (drift)
    ] : [
      { id: 'ltx_video', name: 'LTX', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
    ];
    writeFileSync(registryFile, JSON.stringify({
      video: {
        [platformKey]: userPlatformList,
        [otherKey]: [],
        defaultMlx: 'ltx23_unified',
        defaultCuda: 'ltx_video',
      },
      image: [],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
      _shippedDefaults: {
        video: {
          mlx: platformKey === 'mlx' ? ['ltx23_unified', driftedId] : [],
          cuda: platformKey === 'cuda' ? ['ltx_video'] : [],
        },
        image: { list: [] },
      },
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadMediaModels } = await import('./mediaModels.js');
    loadMediaModels();
    const driftCalls = logSpy.mock.calls
      .map((args) => args.join(' '))
      .filter((line) => line.includes('media-models drift'));
    // Only assert on mlx to avoid platform divergence in CI — the MLX
    // built-in list is the populated one for both test runs.
    if (platformKey === 'mlx') {
      expect(driftCalls.some((c) => c.includes(driftedId) && c.includes('video.mlx'))).toBe(true);
    }
    logSpy.mockRestore();
  });

  it('isHfRepoId accepts canonical org/name shape and rejects local paths cross-platform', async () => {
    const { isHfRepoId } = await import('./mediaModels.js');
    expect(isHfRepoId('black-forest-labs/FLUX.1-dev')).toBe(true);
    expect(isHfRepoId('mlx-community/gemma-3-12b-it-4bit')).toBe(true);
    // POSIX / home-relative
    expect(isHfRepoId('/usr/local/share/model')).toBe(false);
    expect(isHfRepoId('~/.cache/huggingface/hub')).toBe(false);
    // Windows drive paths — both backslash and forward-slash style.
    // These would silently pass the old `includes('/')` check and trip the
    // download endpoints into treating an LM Studio path as a Hub repo.
    expect(isHfRepoId('C:/Users/foo/model')).toBe(false);
    expect(isHfRepoId('C:\\Users\\foo\\model')).toBe(false);
    expect(isHfRepoId('D:/lmstudio/models')).toBe(false);
    // UNC and other backslash-bearing paths
    expect(isHfRepoId('\\\\server\\share\\model')).toBe(false);
    // Multi-slash shapes are paths, not repo ids
    expect(isHfRepoId('org/name/subdir')).toBe(false);
    // Empty / non-string / non-namespaced legacy bare names
    expect(isHfRepoId('')).toBe(false);
    expect(isHfRepoId(null)).toBe(false);
    expect(isHfRepoId('bare-name')).toBe(false);
  });

  it('does NOT auto-recover the drifted entry (warn loud, but trust the registry on disk)', async () => {
    // Same setup as the first drift test — confirm that the warning does
    // NOT cause normalizeRegistry to silently re-add the missing built-in.
    // Auto-recovery would defeat real deletions.
    writeFileSync(registryFile, JSON.stringify({
      video: { mlx: [], cuda: [], defaultMlx: 'x', defaultCuda: 'x' },
      image: [{ id: 'dev', name: 'Flux 1 Dev' }],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
      _shippedDefaults: {
        video: { mlx: [], cuda: [] },
        image: { list: ['dev', 'z-image-turbo-bf16'] },
      },
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadMediaModels, getImageModels } = await import('./mediaModels.js');
    loadMediaModels();
    const ids = getImageModels().map((m) => m.id);
    expect(ids).not.toContain('z-image-turbo-bf16');
    logSpy.mockRestore();
  });
});

describe('user model entry mutators (#2124)', () => {
  const videoEntry = {
    id: 'hf-test-video', name: 'Test Video', repo: 'test/video',
    runtime: 'mlx_video', steps: 25, guidance: 3.0, source: 'user',
  };
  const imageEntry = {
    id: 'hf-test-image', name: 'Test Image', repo: 'test/image',
    runner: 'flux2', steps: 8, guidance: 3.5, source: 'user',
  };

  it('isUserModelEntry distinguishes user from built-in', async () => {
    const { isUserModelEntry } = await import('./mediaModels.js');
    expect(isUserModelEntry({ source: 'user' })).toBe(true);
    expect(isUserModelEntry({})).toBe(false);
    expect(isUserModelEntry({ source: 'trained' })).toBe(false);
  });

  it('adds a user video entry, persists it, and hot-reloads the cache', async () => {
    const { addUserModelEntry, getVideoModels, loadMediaModels } = await import('./mediaModels.js');
    loadMediaModels(); // prime the cache
    addUserModelEntry(videoEntry, { kind: 'video' });
    // Reads back through the (busted + re-read) cache — no restart needed.
    expect(getVideoModels().some((m) => m.id === 'hf-test-video')).toBe(true);
    // And it's persisted to disk.
    const onDisk = JSON.parse(readFileSync(registryFile, 'utf-8'));
    const inList = [...onDisk.video.mlx, ...onDisk.video.cuda].some((m) => m.id === 'hf-test-video');
    expect(inList).toBe(true);
    // The mutators bypass normalizeRegistry, so the mode backfill has to run
    // here too — otherwise the new model carries no supportedModes and the
    // picker (which no longer reads "absent" as "everything") hides it in every
    // mode until the next restart.
    expect(getVideoModels().find((m) => m.id === 'hf-test-video').supportedModes)
      .toEqual(['text', 'image', 'fflf', 'extend']);
  });

  it('adds a user image entry', async () => {
    const { addUserModelEntry, getImageModels } = await import('./mediaModels.js');
    addUserModelEntry(imageEntry, { kind: 'image' });
    expect(getImageModels().some((m) => m.id === 'hf-test-image')).toBe(true);
  });

  it('refuses a duplicate id', async () => {
    const { addUserModelEntry } = await import('./mediaModels.js');
    addUserModelEntry(videoEntry, { kind: 'video' });
    expect(() => addUserModelEntry(videoEntry, { kind: 'video' })).toThrow(/already/i);
  });

  it('rejects a duplicate repo even under a different id', async () => {
    const { addUserModelEntry } = await import('./mediaModels.js');
    addUserModelEntry(imageEntry, { kind: 'image' }); // repo: test/image
    expect(() => addUserModelEntry(
      { ...imageEntry, id: 'hf-different-id' },
      { kind: 'image' },
    )).toThrow(/already in this install's image registry/i);
  });

  it('conflict-checks only the target platform list, not every list', async () => {
    // A video id present ONLY on the OTHER platform's list must remain addable
    // in the current bucket (shared media-models.json across an MLX and a CUDA box).
    const { loadMediaModels } = await import('./mediaModels.js');
    const reg = loadMediaModels();
    const currentKey = process.platform === 'darwin' ? 'mlx' : 'cuda';
    const otherKey = currentKey === 'mlx' ? 'cuda' : 'mlx';
    reg.video[otherKey] = [...(reg.video[otherKey] || []), { ...videoEntry }];
    writeFileSync(registryFile, JSON.stringify(reg, null, 2) + '\n');
    vi.resetModules();
    const m2 = await import('./mediaModels.js');
    expect(() => m2.addUserModelEntry({ ...videoEntry }, { kind: 'video' })).not.toThrow();
    expect(m2.getVideoModels().some((x) => x.id === videoEntry.id)).toBe(true);
  });

  it('patches a user entry but refuses built-ins', async () => {
    const { addUserModelEntry, patchUserModelEntry, getImageModels } = await import('./mediaModels.js');
    addUserModelEntry(imageEntry, { kind: 'image' });
    const updated = patchUserModelEntry('hf-test-image', { name: 'Renamed', steps: 12 });
    expect(updated.name).toBe('Renamed');
    expect(updated.steps).toBe(12);
    expect(getImageModels().find((m) => m.id === 'hf-test-image').name).toBe('Renamed');
    // 'dev' is a shipped built-in
    expect(() => patchUserModelEntry('dev', { name: 'Hack' })).toThrow(/built-in/i);
    expect(() => patchUserModelEntry('does-not-exist', { name: 'x' })).toThrow(/Unknown/i);
  });

  it('removes a user entry but refuses built-ins', async () => {
    const { addUserModelEntry, removeUserModelEntry, getVideoModels } = await import('./mediaModels.js');
    addUserModelEntry(videoEntry, { kind: 'video' });
    expect(removeUserModelEntry('hf-test-video')).toEqual({ ok: true, id: 'hf-test-video' });
    expect(getVideoModels().some((m) => m.id === 'hf-test-video')).toBe(false);
    expect(() => removeUserModelEntry('dev')).toThrow(/built-in/i);
    expect(() => removeUserModelEntry('nope')).toThrow(/Unknown/i);
  });

  it('reloadMediaModels busts the cache', async () => {
    const { loadMediaModels, reloadMediaModels } = await import('./mediaModels.js');
    const first = loadMediaModels();
    const second = loadMediaModels();
    expect(first).toBe(second); // cached identity
    const reloaded = reloadMediaModels();
    expect(reloaded).not.toBe(first); // fresh object after bust
  });
});

// Issue #4142. The catalog used to select `IS_WIN ? video.windows : video.macos`,
// which handed a Linux install the MLX list — every entry on it unrunnable there —
// while the two torch+CUDA entries that DO run on Linux sat in an unreachable
// `windows` list. The axis is the runtime family, so the selector is "is this a
// Mac?" and the buckets are named for what they hold.
describe('video bucket selection is an MLX/CUDA axis, not an OS one', () => {
  let restorePlatform = () => {};
  const asPlatform = (value) => { restorePlatform = pinPlatform(value); };
  afterEach(() => restorePlatform());

  const MLX_ONLY = { id: 'mlx-only', name: 'MLX only', runtime: 'mlx_video', steps: 25, guidance: 3.0 };
  const CUDA_ONLY = { id: 'cuda-only', name: 'CUDA only', runtime: 'minimax_h3_cuda', steps: 8, guidance: 0 };

  // Canonical (post-#4142) and legacy (any registry written before it) spellings
  // of the same two-bucket registry. Both must resolve identically on every
  // platform — the legacy read aliases are the whole compatibility story for
  // installs that upgrade on their own schedule.
  // _shippedDefaults claims every current built-in so appendNewlyShippedEntries
  // adds nothing and each bucket holds exactly the one probe entry.
  const seed = JSON.parse(readFileSync(SAMPLE_REGISTRY_PATH, 'utf-8'));
  const shippedMlx = [...seed.video.mlx.map((m) => m.id), MLX_ONLY.id];
  const shippedCuda = [...seed.video.cuda.map((m) => m.id), CUDA_ONLY.id];
  const shippedImage = seed.image.map((m) => m.id);

  const CANONICAL = {
    video: { mlx: [MLX_ONLY], cuda: [CUDA_ONLY], defaultMlx: MLX_ONLY.id, defaultCuda: CUDA_ONLY.id },
    image: [],
    textEncoders: [{ id: 't', label: 't', repo: 'r' }],
    selectedTextEncoder: 't',
    _shippedDefaults: { video: { mlx: shippedMlx, cuda: shippedCuda }, image: { list: shippedImage } },
  };
  const LEGACY = {
    ...CANONICAL,
    video: { macos: [MLX_ONLY], windows: [CUDA_ONLY], defaultMacos: MLX_ONLY.id, defaultWindows: CUDA_ONLY.id },
    _shippedDefaults: { video: { macos: shippedMlx, windows: shippedCuda }, image: { list: shippedImage } },
  };

  const resolveOn = async (platform, registry) => {
    writeFileSync(registryFile, JSON.stringify(registry));
    asPlatform(platform);
    const { getVideoModels, getDefaultVideoModelId } = await import('./mediaModels.js');
    return { ids: getVideoModels().map((m) => m.id), defaultId: getDefaultVideoModelId() };
  };

  for (const [shape, registry] of [['canonical mlx/cuda keys', CANONICAL], ['legacy macos/windows keys', LEGACY]]) {
    describe(shape, () => {
      it('serves the MLX list on darwin', async () => {
        expect(await resolveOn('darwin', registry)).toEqual({ ids: [MLX_ONLY.id], defaultId: MLX_ONLY.id });
      });

      it('serves the CUDA list on win32', async () => {
        expect(await resolveOn('win32', registry)).toEqual({ ids: [CUDA_ONLY.id], defaultId: CUDA_ONLY.id });
      });

      // The bug: linux used to fall through to the macOS/MLX branch.
      it('serves the CUDA list on linux', async () => {
        expect(await resolveOn('linux', registry)).toEqual({ ids: [CUDA_ONLY.id], defaultId: CUDA_ONLY.id });
      });
    });
  }

  it('normalizes a legacy-keyed registry to the canonical keys on disk', async () => {
    writeFileSync(registryFile, JSON.stringify(LEGACY));
    const { loadMediaModels } = await import('./mediaModels.js');
    loadMediaModels();
    const onDisk = JSON.parse(readFileSync(registryFile, 'utf-8'));
    // Exactly one spelling survives — two would let a hand-edit land on the
    // copy nothing reads.
    expect(Object.keys(onDisk.video).sort()).toEqual(['cuda', 'defaultCuda', 'defaultMlx', 'mlx']);
    expect(onDisk.video.mlx.map((m) => m.id)).toEqual([MLX_ONLY.id]);
    expect(onDisk.video.cuda.map((m) => m.id)).toEqual([CUDA_ONLY.id]);
    expect(onDisk.video.defaultMlx).toBe(MLX_ONLY.id);
    expect(onDisk.video.defaultCuda).toBe(CUDA_ONLY.id);
    expect(Object.keys(onDisk._shippedDefaults.video).sort()).toEqual(['cuda', 'mlx']);
  });

  it('hides an entry whose legacy per-bucket `broken` flag names the active bucket', async () => {
    writeFileSync(registryFile, JSON.stringify({
      ...LEGACY,
      video: { ...LEGACY.video, windows: [{ ...CUDA_ONLY, broken: 'windows' }] },
    }));
    asPlatform('linux');
    const { getVideoModels } = await import('./mediaModels.js');
    expect(getVideoModels()).toEqual([]);
  });

  // The warning tells the user which key to edit, so it has to quote the
  // spelling THEIR file uses — and the two halves can legitimately disagree
  // (migration 242 writes a canonical snapshot onto a legacy-keyed video).
  it('names the on-disk key each half of a mixed-spelling registry actually uses', async () => {
    const driftedId = seed.video.mlx[0].id;
    writeFileSync(registryFile, JSON.stringify({
      ...LEGACY,
      video: { ...LEGACY.video, macos: [MLX_ONLY] },
      _shippedDefaults: { video: { mlx: [...shippedMlx, driftedId], windows: shippedCuda }, image: { list: shippedImage } },
    }));
    asPlatform('darwin');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadMediaModels } = await import('./mediaModels.js');
    loadMediaModels();
    const drift = logSpy.mock.calls.map((args) => args.join(' '))
      .filter((line) => line.includes('media-models drift') && line.includes(driftedId));
    logSpy.mockRestore();
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain('missing from video.macos[]');
    expect(drift[0]).toContain('delete _shippedDefaults.video.mlx');
  });

  it('adds a user video entry to the bucket this machine actually runs', async () => {
    writeFileSync(registryFile, JSON.stringify(CANONICAL));
    asPlatform('linux');
    const { addUserModelEntry, loadMediaModels } = await import('./mediaModels.js');
    addUserModelEntry({ id: 'user-cuda', name: 'User', repo: 'example/user', source: 'user' }, { kind: 'video' });
    const reg = loadMediaModels();
    expect(reg.video.cuda.map((m) => m.id)).toContain('user-cuda');
    expect(reg.video.mlx.map((m) => m.id)).not.toContain('user-cuda');
  });
});
