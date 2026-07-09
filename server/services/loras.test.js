import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockJsonResponse } from '../lib/testHelper.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

// Minimal structurally-valid safetensors blob: 8-byte LE header length + JSON
// header. verifyDownloadedLora (issue #2199) rejects anything that isn't a
// parseable safetensors header, so download fixtures below must be valid.
const validSafetensors = (header = {}) => {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([len, json]);
};
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

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
    // Non-flux2 LoRAs: compat key is just the runner family.
    expect(realstagram.loraCompatKey).toBe('mflux');
    expect(realstagram.fluxVariant).toBe(null);
    expect(realstagram.triggerWords).toEqual(['rstgrm']);
    expect(realstagram.recommendedScale).toBe(0.85);
    expect(legacy.name).toBe('legacy');
    expect(legacy.runnerFamily).toBe(null);
    expect(legacy.loraCompatKey).toBe(null);
    expect(legacy.recommendedScale).toBe(1.0);
  });

  it('tags a flux2 LoRA size from the Civitai baseModel without reading the header', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    // Garbage file contents — must NOT be read since baseModel carries the size.
    await fs.writeFile(join(tmpLoras, 'lora-f2-9b.safetensors'), 'not-a-real-safetensors');
    await fs.writeFile(join(tmpLoras, 'lora-f2-9b.safetensors.metadata.json'), JSON.stringify({
      filename: 'lora-f2-9b.safetensors',
      name: 'Flux2 9B LoRA',
      civitai: { baseModel: 'Flux.2 Klein 9B' },
    }));
    const list = await lorasService.listLoras();
    const lora = list.find((l) => l.filename === 'lora-f2-9b.safetensors');
    expect(lora.runnerFamily).toBe('flux2');
    expect(lora.fluxVariant).toBe('9b');
    expect(lora.loraCompatKey).toBe('flux2-9b');
  });

  it('detects a flux2 LoRA size from the safetensors header when baseModel lacks it', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    // Real header with a 9B-dim transformer tensor (16384 = 4096×4).
    const header = {
      'transformer.single_transformer_blocks.0.attn.to_out.lora_A.weight': { dtype: 'F16', shape: [32, 16384], data_offsets: [0, 1] },
    };
    const json = Buffer.from(JSON.stringify(header), 'utf-8');
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(json.length), 0);
    await fs.writeFile(join(tmpLoras, 'lora-selftrained.safetensors'), Buffer.concat([len, json, Buffer.from([0])]));
    // baseModel is the bare family — no size — forcing the header read.
    await fs.writeFile(join(tmpLoras, 'lora-selftrained.safetensors.metadata.json'), JSON.stringify({
      filename: 'lora-selftrained.safetensors',
      name: 'Self-trained 9B',
      civitai: { baseModel: 'Flux.2 Klein' },
    }));
    const list = await lorasService.listLoras();
    const lora = list.find((l) => l.filename === 'lora-selftrained.safetensors');
    expect(lora.runnerFamily).toBe('flux2');
    expect(lora.fluxVariant).toBe('9b');
    expect(lora.loraCompatKey).toBe('flux2-9b');
  });

  it('leaves loraCompatKey at bare flux2 when the size is indeterminate', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    // Unreadable header + no size in baseModel → can't determine the variant.
    await fs.writeFile(join(tmpLoras, 'lora-f2-unknown.safetensors'), 'garbage');
    await fs.writeFile(join(tmpLoras, 'lora-f2-unknown.safetensors.metadata.json'), JSON.stringify({
      filename: 'lora-f2-unknown.safetensors',
      civitai: { baseModel: 'Flux.2 Klein' },
    }));
    const list = await lorasService.listLoras();
    const lora = list.find((l) => l.filename === 'lora-f2-unknown.safetensors');
    expect(lora.runnerFamily).toBe('flux2');
    expect(lora.fluxVariant).toBe(null);
    expect(lora.loraCompatKey).toBe('flux2');
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
    const downloadedBytes = validSafetensors();
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.startsWith('https://civitai.com/api/v1/models/2600698')) {
        return mockJsonResponse(FAKE_MODEL);
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
    // Flux.1 D is not a flux2 family → no size variant.
    expect(sidecar.fluxVariant).toBe(null);
    expect(sidecar.triggerWords).toEqual(['rstgrm']);
    expect(sidecar.recommendedScale).toBe(0.85);
    // File on disk
    const installedPath = join(tmpLoras, sidecar.filename);
    expect(existsSync(installedPath)).toBe(true);
    expect(readFileSync(installedPath)).toEqual(downloadedBytes);
    // Sidecar on disk
    const sidecarPath = `${installedPath}.metadata.json`;
    expect(JSON.parse(readFileSync(sidecarPath, 'utf-8')).civitai.modelId).toBe(2600698);
    // Two HTTP calls — metadata + download
    expect(calls).toHaveLength(2);
  });

  it('refuses to install non-LoRA model types', async () => {
    const fetchImpl = async () => (mockJsonResponse({ ...FAKE_MODEL, type: 'Checkpoint' }));
    await expect(
      lorasService.installFromCivitai({ url: 'https://civitai.com/models/2600698' }, { fetchImpl }),
    ).rejects.toThrow(/not a LoRA/);
  });

  it('accepts LoRA-family types case-insensitively (DoRA, Lora, lycoris)', async () => {
    // Civitai's `type` casing isn't stable in the wild — DoRA / LoHA / Lora
    // / lower-case variants are all the same family from diffusers' POV.
    const fetchImpl = async (url) => {
      if (url.startsWith('https://civitai.com/api/v1/models/')) {
        return mockJsonResponse({ ...FAKE_MODEL, type: 'DoRA' });
      }
      const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(validSafetensors())); c.close(); } });
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
      if (url.startsWith('https://civitai.com/api/v1/models/')) return mockJsonResponse(FAKE_MODEL);
      throw new Error(`should not download: ${url}`);
    };
    await expect(
      lorasService.installFromCivitai({ url: 'https://civitai.com/models/2600698' }, { fetchImpl }),
    ).rejects.toThrow(/Already installed/);
  });

  it('surfaces a friendly auth error when download is gated (no key)', async () => {
    const fetchImpl = async (url) => {
      if (url.startsWith('https://civitai.com/api/v1/models/')) return mockJsonResponse(FAKE_MODEL);
      return { ok: false, status: 401, statusText: 'Unauthorized' };
    };
    await expect(
      lorasService.installFromCivitai({ url: 'https://civitai.com/models/2600698' }, { fetchImpl }),
    ).rejects.toThrow(/Configure a Civitai API key in PortOS Settings/);
  });

  it('surfaces a different auth error message when a key was provided but download still fails', async () => {
    const fetchImpl = async (url) => {
      if (url.startsWith('https://civitai.com/api/v1/models/')) return mockJsonResponse(FAKE_MODEL);
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
      if (url.startsWith('https://civitai.com/api/v1/models/')) return mockJsonResponse(FAKE_MODEL);
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

  it('rejects a truncated/corrupt download and deletes the partial file', async () => {
    // A short download that isn't a parseable safetensors header — the leading
    // non-Metal cause of "mosaic" garbage output at generate time (issue #2199).
    const fetchImpl = async (url) => {
      if (url.startsWith('https://civitai.com/api/v1/models/')) return mockJsonResponse(FAKE_MODEL);
      const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(Buffer.from('truncated'))); c.close(); } });
      return { ok: true, status: 200, body: stream };
    };
    const err = await lorasService.installFromCivitai({ url: 'https://civitai.com/models/2600698' }, { fetchImpl }).catch((e) => e);
    expect(err.code).toBe('CIVITAI_LORA_CORRUPT');
    // The corrupt file must be gone so the next install re-downloads.
    expect(existsSync(join(tmpLoras, 'lora-realstagram-v7.safetensors'))).toBe(false);
    // No sidecar should have been written.
    expect(existsSync(join(tmpLoras, 'lora-realstagram-v7.safetensors.metadata.json'))).toBe(false);
  });

  it('rejects a structurally-valid download whose SHA-256 mismatches the Civitai digest', async () => {
    const bytes = validSafetensors();
    // A different, well-formed sha256 so the deep compare fails.
    const wrongSha = 'f'.repeat(64);
    const model = { ...FAKE_MODEL, modelVersions: [{ ...FAKE_MODEL.modelVersions[0], files: [{ ...FAKE_MODEL.modelVersions[0].files[0], hashes: { SHA256: wrongSha } }] }] };
    const fetchImpl = async (url) => {
      if (url.startsWith('https://civitai.com/api/v1/models/')) return mockJsonResponse(model);
      const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } });
      return { ok: true, status: 200, body: stream };
    };
    const err = await lorasService.installFromCivitai({ url: 'https://civitai.com/models/2600698' }, { fetchImpl }).catch((e) => e);
    expect(err.code).toBe('CIVITAI_LORA_CORRUPT');
    expect(existsSync(join(tmpLoras, 'lora-realstagram-v7.safetensors'))).toBe(false);
  });

  it('accepts a download whose SHA-256 matches the Civitai digest (case-insensitive)', async () => {
    const bytes = validSafetensors();
    // Civitai reports hashes in uppercase; sha256File returns lowercase.
    const rightSha = sha256Hex(bytes).toUpperCase();
    const model = { ...FAKE_MODEL, modelVersions: [{ ...FAKE_MODEL.modelVersions[0], files: [{ ...FAKE_MODEL.modelVersions[0].files[0], hashes: { SHA256: rightSha } }] }] };
    const fetchImpl = async (url) => {
      if (url.startsWith('https://civitai.com/api/v1/models/')) return mockJsonResponse(model);
      const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } });
      return { ok: true, status: 200, body: stream };
    };
    const sidecar = await lorasService.installFromCivitai({ url: 'https://civitai.com/models/2600698' }, { fetchImpl });
    expect(sidecar.filename).toBe('lora-realstagram-v7.safetensors');
    expect(existsSync(join(tmpLoras, 'lora-realstagram-v7.safetensors'))).toBe(true);
  });
});

describe('installFromHuggingface', () => {
  const HF_MODEL = {
    id: 'fal/ltx2.3-audio-reactive-lora',
    tags: ['ltxv', 'lora'],
    cardData: { base_model: 'Lightricks/LTX-2.3', instance_prompt: 'audio reactive' },
    siblings: [
      { rfilename: 'README.md' },
      { rfilename: 'pytorch_lora_weights.safetensors' },
    ],
  };

  it('fetches metadata, downloads the .safetensors, writes a video-LoRA sidecar', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.startsWith('https://huggingface.co/api/models/fal/ltx2.3-audio-reactive-lora')) {
        return mockJsonResponse(HF_MODEL);
      }
      if (url.includes('/resolve/main/pytorch_lora_weights.safetensors')) {
        const stream = new ReadableStream({
          start(c) { c.enqueue(new Uint8Array(validSafetensors())); c.close(); },
        });
        return { ok: true, status: 200, body: stream };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const sidecar = await lorasService.installFromHuggingface(
      { url: 'https://huggingface.co/fal/ltx2.3-audio-reactive-lora', token: 'hf_test' },
      { fetchImpl },
    );
    expect(sidecar.filename).toBe('lora-fal-ltx2.3-audio-reactive-lora-hf.safetensors');
    expect(sidecar.runnerFamily).toBe('ltx-video');
    expect(sidecar.source).toBe('huggingface');
    expect(sidecar.huggingface.repo).toBe('fal/ltx2.3-audio-reactive-lora');
    expect(sidecar.triggerWords).toEqual(['audio reactive']);
    // The picked file is the canonical diffusers weights, not the README.
    expect(calls.some((u) => u.includes('/resolve/main/pytorch_lora_weights.safetensors'))).toBe(true);
  });

  it('refuses a repo it cannot classify as a supported video family', async () => {
    const fetchImpl = async (url) => {
      if (url.startsWith('https://huggingface.co/api/models/')) {
        return mockJsonResponse({ id: 'someone/sdxl-lora', tags: ['sdxl'], siblings: [{ rfilename: 'lora.safetensors' }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    await expect(
      lorasService.installFromHuggingface({ url: 'someone/sdxl-lora', token: 'hf_test' }, { fetchImpl }),
    ).rejects.toMatchObject({ code: 'HF_UNKNOWN_FAMILY' });
  });

  it('reports byte-level download progress via onProgress', async () => {
    const fetchImpl = async (url) => {
      if (url.startsWith('https://huggingface.co/api/models/')) {
        return mockJsonResponse(HF_MODEL);
      }
      if (url.includes('/resolve/main/pytorch_lora_weights.safetensors')) {
        // Split a structurally-valid 10-byte safetensors blob across two chunks
        // so the byte-progress accounting is exercised without tripping the
        // post-download integrity check (issue #2199).
        const bytes = validSafetensors();
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(bytes.subarray(0, 5)));
            c.enqueue(new Uint8Array(bytes.subarray(5)));
            c.close();
          },
        });
        // Carry a Content-Length so the total is known.
        return { ok: true, status: 200, body: stream, headers: { get: (h) => (h === 'content-length' ? String(bytes.length) : null) } };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const ticks = [];
    await lorasService.installFromHuggingface(
      { url: 'https://huggingface.co/fal/ltx2.3-audio-reactive-lora', token: 'hf_test' },
      { fetchImpl, onProgress: (p) => ticks.push(p) },
    );
    expect(ticks.length).toBeGreaterThan(0);
    // The flush tick always fires last with the full byte count.
    const last = ticks[ticks.length - 1];
    expect(last.received).toBe(10);
    expect(last.total).toBe(10);
  });

  it('tolerates a missing Content-Length (total 0, still completes)', async () => {
    const fetchImpl = async (url) => {
      if (url.startsWith('https://huggingface.co/api/models/')) {
        return mockJsonResponse(HF_MODEL);
      }
      if (url.includes('/resolve/main/pytorch_lora_weights.safetensors')) {
        const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(validSafetensors())); c.close(); } });
        return { ok: true, status: 200, body: stream }; // no headers
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const ticks = [];
    const sidecar = await lorasService.installFromHuggingface(
      { url: 'https://huggingface.co/fal/ltx2.3-audio-reactive-lora', token: 'hf_test' },
      { fetchImpl, onProgress: (p) => ticks.push(p) },
    );
    expect(sidecar.runnerFamily).toBe('ltx-video');
    expect(ticks[ticks.length - 1]).toEqual({ received: 10, total: 0 });
  });

  it('forwards an AbortSignal to the download fetch so an SSE disconnect can cancel it', async () => {
    const controller = new AbortController();
    let sawSignal;
    const fetchImpl = async (url, opts) => {
      if (url.startsWith('https://huggingface.co/api/models/')) return mockJsonResponse(HF_MODEL);
      if (url.includes('/resolve/main/pytorch_lora_weights.safetensors')) {
        sawSignal = opts?.signal;
        const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(validSafetensors())); c.close(); } });
        return { ok: true, status: 200, body: stream };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    await lorasService.installFromHuggingface(
      { url: 'https://huggingface.co/fal/ltx2.3-audio-reactive-lora', token: 'hf_test' },
      { fetchImpl, signal: controller.signal },
    );
    // The controller's signal must reach the actual weights download (not just
    // the metadata fetch) — that's the transfer a disconnect needs to cancel.
    expect(sawSignal).toBe(controller.signal);
  });

  it('accepts an explicit family override', async () => {
    const fetchImpl = async (url) => {
      if (url.startsWith('https://huggingface.co/api/models/')) {
        return mockJsonResponse({ id: 'someone/mystery-lora', siblings: [{ rfilename: 'lora.safetensors' }] });
      }
      if (url.includes('/resolve/main/lora.safetensors')) {
        const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(validSafetensors())); c.close(); } });
        return { ok: true, status: 200, body: stream };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const sidecar = await lorasService.installFromHuggingface(
      { url: 'someone/mystery-lora', family: 'ltx-video', token: 'hf_test' },
      { fetchImpl },
    );
    expect(sidecar.runnerFamily).toBe('ltx-video');
  });

  it('rejects a truncated/corrupt HF download and deletes the partial file', async () => {
    const fetchImpl = async (url) => {
      if (url.startsWith('https://huggingface.co/api/models/')) return mockJsonResponse(HF_MODEL);
      if (url.includes('/resolve/main/pytorch_lora_weights.safetensors')) {
        const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(Buffer.from('truncated'))); c.close(); } });
        return { ok: true, status: 200, body: stream };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const err = await lorasService.installFromHuggingface(
      { url: 'https://huggingface.co/fal/ltx2.3-audio-reactive-lora', token: 'hf_test' },
      { fetchImpl },
    ).catch((e) => e);
    expect(err.code).toBe('HF_LORA_CORRUPT');
    expect(existsSync(join(tmpLoras, 'lora-fal-ltx2.3-audio-reactive-lora-hf.safetensors'))).toBe(false);
  });
});
