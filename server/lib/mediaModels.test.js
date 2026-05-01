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
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to parse'));
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
});
