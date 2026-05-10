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

  it('returns [] when PATHS.loras is a file, not a directory', async () => {
    const fs = await import('fs/promises');
    // Write a plain file at the loras path — stat will show isDirectory()=false.
    await fs.mkdir(tmpRoot, { recursive: true });
    await fs.writeFile(tmpLoras, 'not-a-directory');
    expect(await lorasService.listLoras()).toEqual([]);
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

  it('re-derives runnerFamily from civitai.baseModel at read time (heals stale sidecars)', async () => {
    // Simulates a LoRA whose sidecar was written before baseModelToRunner()
    // recognized 'Ernie' — `runnerFamily` was stored as null at install
    // time. After the mapping update, listLoras must NOT trust the cached
    // null and must re-derive from the still-correct civitai.baseModel
    // (otherwise this LoRA leaks into every runner's compat filter).
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    await fs.writeFile(join(tmpLoras, 'lora-stale-v1.safetensors'), 'w');
    await fs.writeFile(join(tmpLoras, 'lora-stale-v1.safetensors.metadata.json'), JSON.stringify({
      filename: 'lora-stale-v1.safetensors',
      name: 'Stale Ernie LoRA',
      runnerFamily: null,                      // ← stale value from old install
      civitai: { baseModel: 'Ernie' },         // ← still-correct baseModel
      triggerWords: [],
      installedAt: '2026-05-09T00:00:00.000Z',
    }));
    const list = await lorasService.listLoras();
    const stale = list.find((l) => l.filename === 'lora-stale-v1.safetensors');
    expect(stale.runnerFamily).toBe('ernie');
  });

  it('falls back to stored runnerFamily when civitai.baseModel is absent (legacy LoRAs)', async () => {
    // User-dropped LoRA pre-Civitai integration: no civitai block at all,
    // just whatever runnerFamily someone may have hand-edited in. Read
    // path must respect that rather than coerce to null.
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    await fs.writeFile(join(tmpLoras, 'lora-handcrafted.safetensors'), 'w');
    await fs.writeFile(join(tmpLoras, 'lora-handcrafted.safetensors.metadata.json'), JSON.stringify({
      filename: 'lora-handcrafted.safetensors',
      name: 'Handcrafted',
      runnerFamily: 'mflux',
    }));
    const list = await lorasService.listLoras();
    const lora = list.find((l) => l.filename === 'lora-handcrafted.safetensors');
    expect(lora.runnerFamily).toBe('mflux');
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
  it('400s with INVALID_LORA_FILE when path is a directory, not a regular file', async () => {
    const fs = await import('fs/promises');
    // Create a directory whose name ends in .safetensors — exotic but possible.
    await fs.mkdir(join(tmpLoras, 'lora-dir.safetensors'), { recursive: true });
    const err = await lorasService.deleteLora('lora-dir.safetensors').catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.code).toBe('INVALID_LORA_FILE');
  });
});

describe('getLora', () => {
  it('404s when file does not exist', async () => {
    await expect(lorasService.getLora('lora-missing.safetensors')).rejects.toThrow(/not found/i);
  });
  it('404s when file exists but is not a regular .safetensors file (e.g. directory)', async () => {
    const fs = await import('fs/promises');
    // listLoras filters out non-file entries, so getLora must surface a 404
    // rather than returning null.
    await fs.mkdir(join(tmpLoras, 'lora-dir.safetensors'), { recursive: true });
    const err = await lorasService.getLora('lora-dir.safetensors').catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });
  it('returns a full lora entry when the file is valid', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    await fs.writeFile(join(tmpLoras, 'lora-x.safetensors'), 'w');
    const lora = await lorasService.getLora('lora-x.safetensors');
    expect(lora.filename).toBe('lora-x.safetensors');
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

  it('surfaces a friendly auth error when download is gated (no key)', async () => {
    const fetchImpl = async (url) => {
      if (url.startsWith('https://civitai.com/api/v1/models/')) return { ok: true, status: 200, json: async () => FAKE_MODEL };
      return { ok: false, status: 401, statusText: 'Unauthorized' };
    };
    await expect(
      lorasService.installFromCivitai({ url: 'https://civitai.com/models/2600698' }, { fetchImpl }),
    ).rejects.toThrow(/Configure a Civitai API key in PortOS Settings/);
  });

  it('surfaces a different auth error message when a key was provided but download still fails', async () => {
    const fetchImpl = async (url) => {
      if (url.startsWith('https://civitai.com/api/v1/models/')) return { ok: true, status: 200, json: async () => FAKE_MODEL };
      return { ok: false, status: 403, statusText: 'Forbidden' };
    };
    // Provide apiKey inline so hasApiKey=true
    await expect(
      lorasService.installFromCivitai({ url: 'https://civitai.com/models/2600698', apiKey: 'my-key' }, { fetchImpl }),
    ).rejects.toThrow(/even with your saved API key/);
  });

  it('atomic no-clobber: CIVITAI_ALREADY_INSTALLED when concurrent install wins the link race', async () => {
    // Simulate a concurrent install winning by pre-creating the dest file
    // AFTER the existsSync precheck passes but BEFORE link() runs. We do this
    // by planting the dest file before the download — since our fetchImpl
    // creates it synchronously (no real I/O delay) and the precheck is in
    // installFromCivitai (before mkdir+download), we plant it inside the
    // download body stream start to mimic the timing. The simplest way: make
    // the download fetchImpl write the dest file first before returning.
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    const destFilename = 'lora-realstagram-v7.safetensors';

    const fetchImpl = async (url) => {
      if (url.startsWith('https://civitai.com/api/v1/models/')) return { ok: true, status: 200, json: async () => FAKE_MODEL };
      if (url.startsWith('https://civitai.com/api/download/models/7')) {
        // Plant the dest file to simulate a concurrent install winning before
        // our link() call — this is what makes link() return EEXIST.
        await fs.writeFile(join(tmpLoras, destFilename), 'other-install-won');
        const stream = new ReadableStream({
          start(c) { c.enqueue(new Uint8Array(Buffer.from('race-loser'))); c.close(); },
        });
        return { ok: true, status: 200, body: stream };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const err = await lorasService.installFromCivitai({ url: 'https://civitai.com/models/2600698' }, { fetchImpl }).catch((e) => e);
    expect(err.code).toBe('CIVITAI_ALREADY_INSTALLED');
    // The original file written by the "winning" install must be preserved.
    expect(existsSync(join(tmpLoras, destFilename))).toBe(true);
    // The tmp .partial file must be cleaned up.
    const tmpFiles = await fs.readdir(tmpLoras);
    expect(tmpFiles.some((f) => f.endsWith('.partial'))).toBe(false);
  });
});
