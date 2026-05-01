import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

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
    expect(slash.localPath).toContain('/some/nonexistent/path');
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
});
