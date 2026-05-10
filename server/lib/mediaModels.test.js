import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname_self = dirname(fileURLToPath(import.meta.url));
const SAMPLE_REGISTRY_PATH = join(__dirname_self, '..', '..', 'data.sample', 'media-models.json');

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

// data.sample/media-models.json must mirror the in-code DEFAULT_REGISTRY so
// `npm run setup:data` (which copies data.sample → data on fresh installs)
// produces the same starting state as the runtime `seedIfMissing()` fallback.
// Compares the seed file to a freshly-bootstrapped registry with
// _shippedDefaults stripped (that's a runtime-only field).
describe('data.sample seed file', () => {
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

  it('hides models with broken === current platform', async () => {
    const here = process.platform === 'win32' ? 'windows' : 'macos';
    const elsewhere = process.platform === 'win32' ? 'macos' : 'windows';
    writeFileSync(registryFile, JSON.stringify({
      video: { macos: [], windows: [], defaultMacos: 'x', defaultWindows: 'x' },
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
      video: { macos: [], windows: [], defaultMacos: 'x', defaultWindows: 'x' },
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
      video: { macos: [], windows: [], defaultMacos: 'x', defaultWindows: 'x' },
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
      video: { macos: [], windows: [], defaultMacos: 'x', defaultWindows: 'x' },
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
    expect(Array.isArray(reg.video.macos)).toBe(true);
    expect(Array.isArray(reg.video.windows)).toBe(true);
    expect(getVideoModels().length).toBeGreaterThan(0);
    expect(typeof getDefaultVideoModelId()).toBe('string');
  });

  it('coerces wrong-type fields back to defaults', async () => {
    // Parseable JSON but with non-array values where the consumers expect
    // arrays — without coercion, getImageModels()/getVideoModels() throw at
    // module import-time.
    writeFileSync(registryFile, JSON.stringify({
      video: { macos: 'ltx', windows: { id: 'oops' } },
      image: {},
      textEncoders: 'gemma',
      selectedTextEncoder: 'gemma-bf16',
    }));
    const { loadMediaModels, getVideoModels, getImageModels } = await import('./mediaModels.js');
    const reg = loadMediaModels();
    expect(Array.isArray(reg.video.macos)).toBe(true);
    expect(Array.isArray(reg.video.windows)).toBe(true);
    expect(Array.isArray(reg.image)).toBe(true);
    expect(Array.isArray(reg.textEncoders)).toBe(true);
    expect(() => getVideoModels()).not.toThrow();
    expect(() => getImageModels()).not.toThrow();
  });

  it('normalizes an empty object registry by merging defaults', async () => {
    writeFileSync(registryFile, JSON.stringify({}));
    const { loadMediaModels } = await import('./mediaModels.js');
    const reg = loadMediaModels();
    expect(reg.video.defaultMacos).toBeDefined();
    expect(reg.textEncoders.length).toBeGreaterThan(0);
  });

  it('getDefaultVideoModelId falls back to first available when configured id is unknown', async () => {
    const platformKey = process.platform === 'win32' ? 'windows' : 'macos';
    const otherKey = process.platform === 'win32' ? 'macos' : 'windows';
    writeFileSync(registryFile, JSON.stringify({
      video: {
        macos: [],
        windows: [],
        [platformKey]: [
          { id: 'real-model', name: 'Real' },
          { id: 'other', name: 'Other' },
        ],
        [otherKey]: [],
        defaultMacos: 'nonexistent-typo',
        defaultWindows: 'nonexistent-typo',
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
      video: { macos: [], windows: [], defaultMacos: 'x', defaultWindows: 'x' },
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
    const platformKey = process.platform === 'win32' ? 'windows' : 'macos';
    const here = process.platform === 'win32' ? 'windows' : 'macos';
    const otherKey = process.platform === 'win32' ? 'macos' : 'windows';
    writeFileSync(registryFile, JSON.stringify({
      video: {
        macos: [],
        windows: [],
        [platformKey]: [
          { id: 'broken-here', name: 'Broken', broken: here },
          { id: 'works', name: 'Works' },
        ],
        [otherKey]: [],
        defaultMacos: 'broken-here',
        defaultWindows: 'broken-here',
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
    // All built-in macos models should be present
    const { DEFAULT_VIDEO_MODEL_IDS } = await import('./mediaModels.js').then(async (m) => {
      // We don't export the ids directly, so read them from the registry itself
      const r = m.loadMediaModels();
      return { DEFAULT_VIDEO_MODEL_IDS: r.video.macos.map((e) => e.id) };
    });
    for (const id of DEFAULT_VIDEO_MODEL_IDS) {
      expect(reg.video.macos.some((e) => e.id === id)).toBe(true);
    }
    // _shippedDefaults should be populated
    expect(reg._shippedDefaults?.video?.macos?.length).toBeGreaterThan(0);
    // Disk should now contain _shippedDefaults
    const onDisk = JSON.parse(readFileSync(registryFile, 'utf-8'));
    expect(onDisk._shippedDefaults?.video?.macos?.length).toBeGreaterThan(0);
    logSpy.mockRestore();
  });

  it('user-deleted built-in video model is NOT re-added on subsequent load', async () => {
    const platformKey = process.platform === 'win32' ? 'windows' : 'macos';
    const otherKey = process.platform === 'win32' ? 'macos' : 'windows';
    // Simulate a registry that already has _shippedDefaults (post-bootstrap)
    // but is missing one model the user deleted (ltx2_unified).
    const deletedId = 'ltx2_unified';
    const remainingMacos = [
      { id: 'ltx23_unified', name: 'LTX-2.3 Unified Beta (~48 GB)', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      { id: 'ltx23_distilled_q4', name: 'LTX-2.3 Distilled Q4 (~22 GB)', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      { id: 'ltx23_dgrauet_q4', name: 'LTX-2.3 dgrauet Q4', runtime: 'ltx2', steps: 8, guidance: 3.0 },
      { id: 'ltx23_dgrauet_q8', name: 'LTX-2.3 dgrauet Q8', runtime: 'ltx2', steps: 8, guidance: 3.0 },
    ];
    const shippedMacosIds = [deletedId, ...remainingMacos.map((e) => e.id)];
    writeFileSync(registryFile, JSON.stringify({
      video: {
        [platformKey]: platformKey === 'macos' ? remainingMacos : [{ id: 'ltx_video', name: 'LTX', runtime: 'mlx_video', steps: 25, guidance: 3.0 }],
        [otherKey]: [],
        defaultMacos: 'ltx23_distilled_q4',
        defaultWindows: 'ltx_video',
      },
      image: [],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
      _shippedDefaults: {
        video: {
          macos: shippedMacosIds,
          windows: ['ltx_video'],
        },
      },
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadMediaModels } = await import('./mediaModels.js');
    const reg = loadMediaModels();
    // The deleted model must NOT be back
    expect(reg.video.macos.some((e) => e.id === deletedId)).toBe(false);
    // The shipped id must still be tracked
    expect(reg._shippedDefaults.video.macos).toContain(deletedId);
    logSpy.mockRestore();
  });

  it('new built-in id not in _shippedDefaults is added AND recorded', async () => {
    const platformKey = process.platform === 'win32' ? 'windows' : 'macos';
    const otherKey = process.platform === 'win32' ? 'macos' : 'windows';
    // Simulate a registry that pre-dates a newly-shipped model: _shippedDefaults
    // exists but does NOT include 'ltx23_dgrauet_q8' (as if it shipped later).
    const existingMacos = [
      { id: 'ltx2_unified', name: 'LTX-2 Unified', runtime: 'mlx_video', steps: 30, guidance: 3.0 },
      { id: 'ltx23_unified', name: 'LTX-2.3 Unified', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      { id: 'ltx23_distilled_q4', name: 'LTX-2.3 Q4', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      { id: 'ltx23_dgrauet_q4', name: 'LTX-2.3 dgrauet Q4', runtime: 'ltx2', steps: 8, guidance: 3.0 },
    ];
    // _shippedDefaults does NOT include ltx23_dgrauet_q8
    const shippedMacosIds = existingMacos.map((e) => e.id);
    writeFileSync(registryFile, JSON.stringify({
      video: {
        [platformKey]: platformKey === 'macos' ? existingMacos : [{ id: 'ltx_video', name: 'LTX', runtime: 'mlx_video', steps: 25, guidance: 3.0 }],
        [otherKey]: [],
        defaultMacos: 'ltx23_distilled_q4',
        defaultWindows: 'ltx_video',
      },
      image: [],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
      _shippedDefaults: {
        video: {
          macos: shippedMacosIds,
          windows: ['ltx_video'],
        },
      },
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadMediaModels } = await import('./mediaModels.js');
    const reg = loadMediaModels();
    // ltx23_dgrauet_q8 is a current DEFAULT_REGISTRY entry not yet shipped →
    // should be added to the user's list
    expect(reg.video.macos.some((e) => e.id === 'ltx23_dgrauet_q8')).toBe(true);
    // And should now be recorded in _shippedDefaults
    expect(reg._shippedDefaults.video.macos).toContain('ltx23_dgrauet_q8');
    // Persisted to disk
    const onDisk = JSON.parse(readFileSync(registryFile, 'utf-8'));
    expect(onDisk._shippedDefaults.video.macos).toContain('ltx23_dgrauet_q8');
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

  it('existing install without _shippedDefaults.image gains the new z-image entries on upgrade', async () => {
    // Simulate a pre-z-image registry: only flux2 and Flux 1 entries, no
    // _shippedDefaults.image at all.
    writeFileSync(registryFile, JSON.stringify({
      video: { macos: [], windows: [], defaultMacos: 'x', defaultWindows: 'x' },
      image: [
        { id: 'dev', name: 'Flux 1 Dev', steps: 20, guidance: 3.5 },
        { id: 'schnell', name: 'Flux 1 Schnell', steps: 4, guidance: 0 },
      ],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
      _shippedDefaults: { video: { macos: [], windows: [] } }, // image key missing
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
      video: { macos: [], windows: [], defaultMacos: 'x', defaultWindows: 'x' },
      image: [
        { id: 'dev', name: 'Flux 1 Dev', steps: 20, guidance: 3.5 },
        // z-image-turbo-bf16 deliberately absent
      ],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
      _shippedDefaults: {
        video: { macos: [], windows: [] },
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
    const platformKey = process.platform === 'win32' ? 'windows' : 'macos';
    const otherKey = process.platform === 'win32' ? 'macos' : 'windows';
    // _shippedDefaults includes ltx23_dgrauet_q8 (it was added in a prior
    // load), but the user has now removed it from their video list.
    const userMacos = [
      { id: 'ltx2_unified', name: 'LTX-2 Unified', runtime: 'mlx_video', steps: 30, guidance: 3.0 },
      { id: 'ltx23_unified', name: 'LTX-2.3 Unified', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      { id: 'ltx23_distilled_q4', name: 'LTX-2.3 Q4', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      { id: 'ltx23_dgrauet_q4', name: 'LTX-2.3 dgrauet Q4', runtime: 'ltx2', steps: 8, guidance: 3.0 },
      // ltx23_dgrauet_q8 intentionally absent
    ];
    const shippedMacosIds = [...userMacos.map((e) => e.id), 'ltx23_dgrauet_q8'];
    writeFileSync(registryFile, JSON.stringify({
      video: {
        [platformKey]: platformKey === 'macos' ? userMacos : [{ id: 'ltx_video', name: 'LTX', runtime: 'mlx_video', steps: 25, guidance: 3.0 }],
        [otherKey]: [],
        defaultMacos: 'ltx23_distilled_q4',
        defaultWindows: 'ltx_video',
      },
      image: [],
      textEncoders: [{ id: 't', label: 't', repo: 'r' }],
      selectedTextEncoder: 't',
      _shippedDefaults: {
        video: {
          macos: shippedMacosIds,
          windows: ['ltx_video'],
        },
      },
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadMediaModels } = await import('./mediaModels.js');
    const reg = loadMediaModels();
    // Deletion must be respected — model NOT re-added
    expect(reg.video.macos.some((e) => e.id === 'ltx23_dgrauet_q8')).toBe(false);
    // The id stays in _shippedDefaults so future loads also honour the deletion
    expect(reg._shippedDefaults.video.macos).toContain('ltx23_dgrauet_q8');
    logSpy.mockRestore();
  });
});
