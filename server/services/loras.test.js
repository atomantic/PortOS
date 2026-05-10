import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Point PATHS.loras at a temp dir for the duration of each test. PATHS is
// computed at module load against process.cwd / __dirname, so the cleanest
// way to swap it is to mock fileUtils for the loras service.
let tmpRoot;
let tmpLoras;
let lorasService;
let civitaiLib;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'portos-loras-test-'));
  tmpLoras = join(tmpRoot, 'loras');

  vi.resetModules();
  vi.doMock('../lib/fileUtils.js', async () => {
    const actual = await vi.importActual('../lib/fileUtils.js');
    return {
      ...actual,
      PATHS: { ...actual.PATHS, loras: tmpLoras },
    };
  });
  // Stub settings so resolveCivitaiKey doesn't read the real data/settings.json.
  vi.doMock('./settings.js', () => ({
    getSettings: async () => ({}),
  }));
  lorasService = await import('./loras.js');
  civitaiLib = await import('../lib/civitai.js');
});

afterEach(() => {
  vi.doUnmock('../lib/fileUtils.js');
  vi.doUnmock('./settings.js');
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('listLoras', () => {
  it('returns an empty list when the loras dir is missing', async () => {
    expect(await lorasService.listLoras()).toEqual([]);
  });

  it('lists .safetensors files and merges sidecar metadata', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    await fs.writeFile(join(tmpLoras, 'lora-realstagram-v7.safetensors'), 'fake-weights');
    await fs.writeFile(join(tmpLoras, 'lora-realstagram-v7.safetensors.metadata.json'), JSON.stringify({
      filename: 'lora-realstagram-v7.safetensors',
      name: 'RealStagram',
      runnerFamily: 'mflux',
      triggerWords: ['rstgrm'],
      recommendedScale: 0.85,
      installedAt: '2026-05-09T00:00:00.000Z',
    }));
    // A legacy file the user dropped in pre-Civitai (no sidecar).
    await fs.writeFile(join(tmpLoras, 'lora-legacy.safetensors'), 'older-weights');

    const list = await lorasService.listLoras();
    const realstagram = list.find((l) => l.filename === 'lora-realstagram-v7.safetensors');
    const legacy = list.find((l) => l.filename === 'lora-legacy.safetensors');
    expect(realstagram.name).toBe('RealStagram');
    expect(realstagram.runnerFamily).toBe('mflux');
    expect(realstagram.triggerWords).toEqual(['rstgrm']);
    expect(realstagram.recommendedScale).toBe(0.85);
    expect(legacy.name).toBe('legacy');
    expect(legacy.runnerFamily).toBe(null);
    expect(legacy.recommendedScale).toBe(1.0);
  });

  it('survives an unparseable sidecar', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    await fs.writeFile(join(tmpLoras, 'lora-broken.safetensors'), 'w');
    await fs.writeFile(join(tmpLoras, 'lora-broken.safetensors.metadata.json'), '{ this is not json');
    const list = await lorasService.listLoras();
    expect(list).toHaveLength(1);
    expect(list[0].filename).toBe('lora-broken.safetensors');
    expect(list[0].runnerFamily).toBe(null);
  });
});

describe('deleteLora', () => {
  it('removes file + sidecar', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    await fs.writeFile(join(tmpLoras, 'lora-x.safetensors'), 'w');
    await fs.writeFile(join(tmpLoras, 'lora-x.safetensors.metadata.json'), '{}');
    await lorasService.deleteLora('lora-x.safetensors');
    expect(existsSync(join(tmpLoras, 'lora-x.safetensors'))).toBe(false);
    expect(existsSync(join(tmpLoras, 'lora-x.safetensors.metadata.json'))).toBe(false);
  });
  it('rejects path traversal', async () => {
    await expect(lorasService.deleteLora('../escape.safetensors')).rejects.toThrow(/Invalid LoRA filename/);
    await expect(lorasService.deleteLora('foo/bar.safetensors')).rejects.toThrow(/Invalid LoRA filename/);
    await expect(lorasService.deleteLora('foo.bin')).rejects.toThrow(/Invalid LoRA filename/);
  });
  it('404s for missing files', async () => {
    await expect(lorasService.deleteLora('lora-missing.safetensors')).rejects.toThrow(/not found/);
  });
});

describe('patchLoraSidecar', () => {
  it('creates a sidecar when none exists', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    await fs.writeFile(join(tmpLoras, 'lora-y.safetensors'), 'w');
    const patched = await lorasService.patchLoraSidecar('lora-y.safetensors', { recommendedScale: 0.5, name: 'Custom' });
    expect(patched.recommendedScale).toBe(0.5);
    expect(patched.name).toBe('Custom');
    expect(JSON.parse(readFileSync(join(tmpLoras, 'lora-y.safetensors.metadata.json'), 'utf-8')).name).toBe('Custom');
  });
});

describe('installFromCivitai', () => {
  // Build a fake Civitai model JSON we can hand to the fetchImpl.
  const FAKE_MODEL = {
    id: 2600698,
    name: 'RealStagram',
    description: 'photoreal LoRA',
    type: 'LORA',
    creator: { username: 'someone' },
    tags: ['photo'],
    nsfw: false,
    modelVersions: [
      {
        id: 7,
        baseModel: 'Flux.1 D',
        trainedWords: ['rstgrm'],
        settings: { strength: 0.85 },
        images: [{ url: 'https://civitai.com/p.jpg', nsfwLevel: 1 }],
        files: [
          { name: 'realstagram.safetensors', primary: true, sizeKB: 1024, hashes: { SHA256: 'abc' }, downloadUrl: 'https://civitai.com/api/download/models/7' },
        ],
      },
    ],
  };

  it('downloads, writes the file, writes the sidecar', async () => {
    const downloadedBytes = Buffer.from('fake-lora-weights');
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.startsWith('https://civitai.com/api/v1/models/2600698')) {
        return { ok: true, status: 200, json: async () => FAKE_MODEL };
      }
      if (url.startsWith('https://civitai.com/api/download/models/7')) {
        // Return a Web ReadableStream so Readable.fromWeb can consume it.
        const stream = new ReadableStream({
          start(c) { c.enqueue(new Uint8Array(downloadedBytes)); c.close(); },
        });
        return { ok: true, status: 200, body: stream };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const sidecar = await lorasService.installFromCivitai({ url: 'https://civitai.red/models/2600698/realstagram' }, { fetchImpl });
    expect(sidecar.filename).toBe('lora-realstagram-v7.safetensors');
    expect(sidecar.civitai.modelId).toBe(2600698);
    expect(sidecar.civitai.versionId).toBe(7);
    expect(sidecar.runnerFamily).toBe('mflux');
    expect(sidecar.triggerWords).toEqual(['rstgrm']);
    expect(sidecar.recommendedScale).toBe(0.85);
    // File on disk
    const installedPath = join(tmpLoras, sidecar.filename);
    expect(existsSync(installedPath)).toBe(true);
    expect(readFileSync(installedPath, 'utf-8')).toBe('fake-lora-weights');
    // Sidecar on disk
    const sidecarPath = `${installedPath}.metadata.json`;
    expect(JSON.parse(readFileSync(sidecarPath, 'utf-8')).civitai.modelId).toBe(2600698);
    // Two HTTP calls — metadata + download
    expect(calls).toHaveLength(2);
  });

  it('refuses to install non-LoRA model types', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ...FAKE_MODEL, type: 'Checkpoint' }) });
    await expect(
      lorasService.installFromCivitai({ url: 'https://civitai.com/models/2600698' }, { fetchImpl }),
    ).rejects.toThrow(/not a LoRA/);
  });

  it('accepts LoRA-family types case-insensitively (DoRA, Lora, lycoris)', async () => {
    // Civitai's `type` casing isn't stable in the wild — DoRA / LoHA / Lora
    // / lower-case variants are all the same family from diffusers' POV.
    const fetchImpl = async (url) => {
      if (url.startsWith('https://civitai.com/api/v1/models/')) {
        return { ok: true, status: 200, json: async () => ({ ...FAKE_MODEL, type: 'DoRA' }) };
      }
      const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(Buffer.from('w'))); c.close(); } });
      return { ok: true, status: 200, body: stream };
    };
    const sidecar = await lorasService.installFromCivitai({ url: 'https://civitai.com/models/2600698' }, { fetchImpl });
    expect(sidecar.civitai.type).toBe('DoRA');
  });

  it('refuses to clobber an already-installed file', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    await fs.writeFile(join(tmpLoras, 'lora-realstagram-v7.safetensors'), 'pre-existing');
    const fetchImpl = async (url) => {
      if (url.startsWith('https://civitai.com/api/v1/models/')) return { ok: true, status: 200, json: async () => FAKE_MODEL };
      throw new Error(`should not download: ${url}`);
    };
    await expect(
      lorasService.installFromCivitai({ url: 'https://civitai.com/models/2600698' }, { fetchImpl }),
    ).rejects.toThrow(/Already installed/);
  });

  it('surfaces a friendly auth error when download is gated', async () => {
    const fetchImpl = async (url) => {
      if (url.startsWith('https://civitai.com/api/v1/models/')) return { ok: true, status: 200, json: async () => FAKE_MODEL };
      return { ok: false, status: 401, statusText: 'Unauthorized' };
    };
    await expect(
      lorasService.installFromCivitai({ url: 'https://civitai.com/models/2600698' }, { fetchImpl }),
    ).rejects.toThrow(/may require an API key/);
  });
});
