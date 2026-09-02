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
let atomicWriteHook;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'portos-loras-test-'));
  tmpLoras = join(tmpRoot, 'loras');

  vi.resetModules();
  vi.doMock('../lib/fileUtils.js', async () => {
    const actual = await vi.importActual('../lib/fileUtils.js');
    return {
      ...actual,
      PATHS: { ...actual.PATHS, loras: tmpLoras },
      atomicWrite: (...args) => atomicWriteHook
        ? atomicWriteHook(actual.atomicWrite, ...args)
        : actual.atomicWrite(...args),
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
  atomicWriteHook = null;
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

  it('reuses cached metadata while the LoRA file mtime is unchanged', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    await fs.writeFile(join(tmpLoras, 'cached.safetensors'), 'weights');
    await fs.writeFile(join(tmpLoras, 'cached.safetensors.metadata.json'), JSON.stringify({
      filename: 'cached.safetensors', name: 'Cached', keyLayout: 'comfyui',
    }));

    const [first] = await lorasService.listLoras();
    const [second] = await lorasService.listLoras();

    expect(second).toBe(first);
  });

  it('invalidates cached metadata after a sidecar patch', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    await fs.writeFile(join(tmpLoras, 'patched.safetensors'), 'weights');
    await fs.writeFile(join(tmpLoras, 'patched.safetensors.metadata.json'), JSON.stringify({
      filename: 'patched.safetensors', name: 'Before', keyLayout: 'comfyui',
    }));

    const [before] = await lorasService.listLoras();
    await lorasService.patchLoraSidecar('patched.safetensors', { name: 'After' });
    const [after] = await lorasService.listLoras();

    expect(after).not.toBe(before);
    expect(after.name).toBe('After');
  });

  it('refreshes cached metadata when a sidecar is replaced outside this service', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    const filePath = join(tmpLoras, 'external.safetensors');
    const sidecarPath = `${filePath}.metadata.json`;
    await fs.writeFile(filePath, 'weights');
    await fs.writeFile(sidecarPath, JSON.stringify({
      filename: 'external.safetensors', name: 'Before', keyLayout: 'comfyui',
    }));

    const [before] = await lorasService.listLoras();
    await fs.writeFile(sidecarPath, JSON.stringify({
      filename: 'external.safetensors', name: 'After', keyLayout: 'comfyui',
    }));
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(sidecarPath, future, future);
    const [after] = await lorasService.listLoras();

    expect(after).not.toBe(before);
    expect(after.name).toBe('After');
  });

  it('refreshes cached metadata when the LoRA file mtime changes', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    const filePath = join(tmpLoras, 'updated.safetensors');
    await fs.writeFile(filePath, 'weights');
    await fs.writeFile(`${filePath}.metadata.json`, JSON.stringify({
      filename: 'updated.safetensors', name: 'Updated', keyLayout: 'comfyui',
    }));

    const [before] = await lorasService.listLoras();
    await fs.writeFile(filePath, 'larger-weights');
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(filePath, future, future);
    const [after] = await lorasService.listLoras();

    expect(after).not.toBe(before);
    expect(after.sizeBytes).toBe(Buffer.byteLength('larger-weights'));
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

// Adapter-effect diagnostic (#4872). listLoras is a PASSIVE read — a library
// page with 40 installed LoRAs must never fan out into 40 Python children — so
// it surfaces only what the explicit probe already measured, and only while
// that measurement still describes the file on disk.
describe('listLoras — cached adapter-effect report', () => {
  const report = (over = {}) => ({
    probeVersion: 1, status: 'ok', modules: 8, measured: 8, skippedNonFinite: 0,
    skippedUnsupported: 0, zeroModules: 0, medianRms: 0.004, maxRms: 0.02,
    reason: null, measuredAt: '2026-08-23T00:00:00.000Z', ...over,
  });
  // The cache key is the file's real size + mtime, so the sidecar has to be
  // written from the file that actually landed on disk — `stamp` overrides let a
  // test deliberately mismatch one of them.
  const writeLora = async (filename, bytes, effectReport, stamp = {}) => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    const path = join(tmpLoras, filename);
    await fs.writeFile(path, Buffer.alloc(bytes, 1));
    const s = await fs.stat(path);
    const sidecar = effectReport
      ? { effectReport: { ...effectReport, sizeBytes: s.size, mtimeMs: s.mtimeMs, ...stamp } }
      : { name: 'Unmeasured' };
    await fs.writeFile(join(tmpLoras, `${filename}.metadata.json`), JSON.stringify({ filename, ...sidecar }));
  };

  it('surfaces a stored report whose size and mtime still match the file', async () => {
    await writeLora('measured.safetensors', 512, report());
    const [lora] = await lorasService.listLoras();
    expect(lora.effectReport).toMatchObject({ status: 'ok', measured: 8, medianRms: 0.004, sizeBytes: 512 });
  });

  it('reports null when the LoRA was never measured', async () => {
    await writeLora('unmeasured.safetensors', 512, null);
    const [lora] = await lorasService.listLoras();
    expect(lora.effectReport).toBeNull();
  });

  it('drops a stored report once the file has been replaced under the same name', async () => {
    // A different size is a different adapter. Surfacing the old verdict would
    // badge a freshly-installed LoRA with the previous file's measurement.
    await writeLora('swapped.safetensors', 1024, report(), { sizeBytes: 512 });
    const [lora] = await lorasService.listLoras();
    expect(lora.effectReport).toBeNull();
  });

  it('drops a stored report when the file was rewritten at the SAME size', async () => {
    await writeLora('rewritten.safetensors', 512, report(), { mtimeMs: 1 });
    const [lora] = await lorasService.listLoras();
    expect(lora.effectReport).toBeNull();
  });

  it('drops a stored report written by a different probe version', async () => {
    await writeLora('old.safetensors', 512, report({ probeVersion: 99 }));
    const [lora] = await lorasService.listLoras();
    expect(lora.effectReport).toBeNull();
  });

  it('normalizes a hand-edited sidecar rather than trusting it', async () => {
    await writeLora('edited.safetensors', 512, report({ status: 'catastrophic', medianRms: 'lots', maxRms: null }));
    const [lora] = await lorasService.listLoras();
    expect(lora.effectReport).toMatchObject({ status: 'unmeasurable', medianRms: null, maxRms: null });
  });

  it('will not surface a "zero" verdict that no measurement backs', async () => {
    // Refusing a render is the one thing a stale/edited sidecar must never be
    // able to cause on its own.
    await writeLora('bogus-zero.safetensors', 512, report({ status: 'zero', measured: 0, zeroModules: 0 }));
    const [lora] = await lorasService.listLoras();
    expect(lora.effectReport.status).toBe('unmeasurable');
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
  it('keeps the model when sidecar removal fails', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    const filePath = join(tmpLoras, 'cleanup-fails.safetensors');
    const sidecar = `${filePath}.metadata.json`;
    await fs.writeFile(filePath, 'weights');
    await fs.mkdir(sidecar);
    await fs.writeFile(join(sidecar, 'locked'), 'metadata');

    await expect(lorasService.deleteLora('cleanup-fails.safetensors')).rejects.toThrow();
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(sidecar)).toBe(true);
  });
  it('invalidates cached metadata before the same filename is reused', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    const filePath = join(tmpLoras, 'reused.safetensors');
    await fs.writeFile(filePath, 'old');
    await fs.writeFile(`${filePath}.metadata.json`, JSON.stringify({
      filename: 'reused.safetensors', name: 'Old', keyLayout: 'comfyui',
    }));
    const oldStat = await fs.stat(filePath);
    expect((await lorasService.listLoras())[0].name).toBe('Old');

    await lorasService.deleteLora('reused.safetensors');
    await fs.writeFile(filePath, 'new');
    await fs.utimes(filePath, oldStat.atime, oldStat.mtime);
    await fs.writeFile(`${filePath}.metadata.json`, JSON.stringify({
      filename: 'reused.safetensors', name: 'New', keyLayout: 'comfyui',
    }));

    expect((await lorasService.listLoras())[0].name).toBe('New');
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
  it('does not recreate a sidecar when deletion wins the write queue', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    const filePath = join(tmpLoras, 'delete-race.safetensors');
    const sidecar = `${filePath}.metadata.json`;
    await fs.writeFile(filePath, 'weights');

    let releaseWrite;
    let markWriteStarted;
    const writeStarted = new Promise((resolve) => { markWriteStarted = resolve; });
    const writeReleased = new Promise((resolve) => { releaseWrite = resolve; });
    atomicWriteHook = async (atomicWrite, ...args) => {
      markWriteStarted();
      await writeReleased;
      return atomicWrite(...args);
    };

    const firstPatch = lorasService.patchLoraSidecar('delete-race.safetensors', { name: 'Before delete' });
    await writeStarted;
    const deletion = lorasService.deleteLora('delete-race.safetensors');
    const latePatch = lorasService.patchLoraSidecar('delete-race.safetensors', { name: 'After delete' });

    releaseWrite();
    await firstPatch;
    await deletion;
    const err = await latePatch.catch((error) => error);
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(sidecar)).toBe(false);
  });
});

// The sidecar is one JSON document with several writers — the manager renaming a
// LoRA, listLoras() healing keyLayout on read, and the effect probe caching its
// measurement. Each patch is a read-modify-write of the WHOLE file, so
// interleaved cycles let the last writer silently drop the other's field.
describe('patchLoraSidecar — concurrent patches', () => {
  it('merges every field when two patches race, rather than last-write-wins', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    await fs.writeFile(join(tmpLoras, 'shared.safetensors'), 'weights');
    await fs.writeFile(join(tmpLoras, 'shared.safetensors.metadata.json'), JSON.stringify({
      filename: 'shared.safetensors', name: 'Original',
    }));

    await Promise.all([
      lorasService.patchLoraSidecar('shared.safetensors', { name: 'Renamed' }),
      lorasService.patchLoraSidecar('shared.safetensors', { effectReport: { status: 'ok', measured: 4 } }),
      lorasService.patchLoraSidecar('shared.safetensors', { keyLayout: 'comfyui' }),
    ]);

    const written = JSON.parse(await fs.readFile(join(tmpLoras, 'shared.safetensors.metadata.json'), 'utf-8'));
    expect(written.name).toBe('Renamed');
    expect(written.keyLayout).toBe('comfyui');
    expect(written.effectReport).toMatchObject({ status: 'ok', measured: 4 });
  });

  it('does not serialize patches to DIFFERENT LoRAs behind each other', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    for (const name of ['a.safetensors', 'b.safetensors']) {
      await fs.writeFile(join(tmpLoras, name), 'weights');
    }
    const [a, b] = await Promise.all([
      lorasService.patchLoraSidecar('a.safetensors', { name: 'A' }),
      lorasService.patchLoraSidecar('b.safetensors', { name: 'B' }),
    ]);
    expect([a.name, b.name]).toEqual(['A', 'B']);
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

  it('shares one in-flight install between duplicate model submissions', async () => {
    const downloadedBytes = validSafetensors();
    let releaseMetadata;
    let metadataCalls = 0;
    let downloadCalls = 0;
    const fetchImpl = async (url) => {
      if (url.startsWith('https://civitai.com/api/v1/models/2600698')) {
        metadataCalls += 1;
        return new Promise((resolve) => {
          releaseMetadata = () => resolve(mockJsonResponse(FAKE_MODEL));
        });
      }
      if (url.startsWith('https://civitai.com/api/download/models/7')) {
        downloadCalls += 1;
        const stream = new ReadableStream({
          start(c) { c.enqueue(new Uint8Array(downloadedBytes)); c.close(); },
        });
        return { ok: true, status: 200, body: stream };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const first = lorasService.installFromCivitai({ url: 'https://civitai.com/models/2600698' }, { fetchImpl });
    await vi.waitFor(() => expect(releaseMetadata).toBeTypeOf('function'));
    const second = lorasService.installFromCivitai({ url: 'https://civitai.com/models/2600698' }, { fetchImpl });

    releaseMetadata();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    expect(metadataCalls).toBe(1);
    expect(downloadCalls).toBe(1);
  });

  it('keeps concurrent installs for different versions of one model independent', async () => {
    const downloadedBytes = validSafetensors();
    const model = {
      ...FAKE_MODEL,
      modelVersions: [
        ...FAKE_MODEL.modelVersions,
        {
          ...FAKE_MODEL.modelVersions[0],
          id: 8,
          files: [{
            ...FAKE_MODEL.modelVersions[0].files[0],
            downloadUrl: 'https://civitai.com/api/download/models/8',
          }],
        },
      ],
    };
    let releaseMetadata;
    const metadataGate = new Promise((resolve) => { releaseMetadata = resolve; });
    let metadataCalls = 0;
    let downloadCalls = 0;
    const fetchImpl = async (url) => {
      if (url.startsWith('https://civitai.com/api/v1/models/2600698')) {
        metadataCalls += 1;
        await metadataGate;
        return mockJsonResponse(model);
      }
      if (url.startsWith('https://civitai.com/api/download/models/')) {
        downloadCalls += 1;
        const stream = new ReadableStream({
          start(c) { c.enqueue(new Uint8Array(downloadedBytes)); c.close(); },
        });
        return { ok: true, status: 200, body: stream };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const version7 = lorasService.installFromCivitai({
      url: 'https://civitai.com/models/2600698?modelVersionId=7',
    }, { fetchImpl });
    const version8 = lorasService.installFromCivitai({
      url: 'https://civitai.com/models/2600698?modelVersionId=8',
    }, { fetchImpl });

    await vi.waitFor(() => expect(metadataCalls).toBe(2));
    releaseMetadata();
    const results = await Promise.all([version7, version8]);
    expect(results.map((result) => result.civitai.versionId)).toEqual([7, 8]);
    expect(downloadCalls).toBe(2);
  });

  it('releases the in-flight slot after a failed install so retry can proceed', async () => {
    let metadataCalls = 0;
    const fetchImpl = async () => {
      metadataCalls += 1;
      if (metadataCalls === 1) throw new Error('metadata unavailable');
      return mockJsonResponse({ ...FAKE_MODEL, type: 'Checkpoint' });
    };

    await expect(
      lorasService.installFromCivitai({ url: 'https://civitai.com/models/2600698' }, { fetchImpl }),
    ).rejects.toThrow(/metadata unavailable/);
    await expect(
      lorasService.installFromCivitai({ url: 'https://civitai.com/models/2600698' }, { fetchImpl }),
    ).rejects.toThrow(/not a LoRA/);
    expect(metadataCalls).toBe(2);
  });

  it('refuses to install non-LoRA model types', async () => {
    const fetchImpl = async () => (mockJsonResponse({ ...FAKE_MODEL, type: 'Checkpoint' }));
    await expect(
      lorasService.installFromCivitai({ url: 'https://civitai.com/models/2600698' }, { fetchImpl }),
    ).rejects.toThrow(/not a LoRA/);
  });

  // previewCivitaiInstall shares its filename/guard logic with the real
  // install (resolveCivitaiInstallPlan) — a preview that didn't share it
  // would show a normal confirm dialog (size, destination, enabled Confirm)
  // for a download that could never actually start.
  it('previewCivitaiInstall refuses a non-LoRA model type, same as the real install', async () => {
    const fetchImpl = async () => (mockJsonResponse({ ...FAKE_MODEL, type: 'Checkpoint' }));
    await expect(
      lorasService.previewCivitaiInstall({ url: 'https://civitai.com/models/2600698' }, { fetchImpl }),
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
        return { ok: true, status: 200, headers: { get: (name) => (name === 'etag' ? '"lora-etag"' : null) }, body: stream };
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
    // downloadToFile's `finalize: false` means streamResumableDownload never
    // runs its own etag-sidecar cleanup — a successful install must still
    // remove it (nothing left it there for a future resume to use).
    expect(existsSync(join(tmpLoras, `${sidecar.filename}.partial.etag`))).toBe(false);
  });

  // HF's model-metadata response never carries per-sibling sizes (the
  // `blobs=true` expand is deliberately not requested), so the preflight
  // must probe the resolved file's own Content-Length via a HEAD request —
  // otherwise expectedBytes stays 0 and disk-insufficient can never fire.
  it('previews the probed Content-Length when the metadata response has no sibling size', async () => {
    const fetchImpl = async (url, opts = {}) => {
      if (url.startsWith('https://huggingface.co/api/models/fal/ltx2.3-audio-reactive-lora')) {
        return mockJsonResponse(HF_MODEL);
      }
      if (url.includes('/resolve/main/pytorch_lora_weights.safetensors') && opts.method === 'HEAD') {
        return { ok: true, status: 200, headers: { get: (name) => (name === 'content-length' ? '123456789' : null) } };
      }
      throw new Error(`unexpected fetch: ${url} ${opts.method || 'GET'}`);
    };
    const preview = await lorasService.previewHuggingfaceInstall(
      { url: 'https://huggingface.co/fal/ltx2.3-audio-reactive-lora', token: 'hf_test' },
      { fetchImpl },
    );
    expect(preview.expectedBytes).toBe(123456789);
  });

  it('installs an exact versioned file beside the repo default', async () => {
    const versionedModel = {
      ...HF_MODEL,
      siblings: [
        ...HF_MODEL.siblings,
        { rfilename: 'ltx2.3_audio_reactive_lora_v2.safetensors' },
      ],
    };
    const fetchImpl = async (url) => {
      if (url.startsWith('https://huggingface.co/api/models/')) {
        return mockJsonResponse(versionedModel);
      }
      if (url.includes('/resolve/main/ltx2.3_audio_reactive_lora_v2.safetensors')) {
        const stream = new ReadableStream({
          start(c) { c.enqueue(new Uint8Array(validSafetensors())); c.close(); },
        });
        return { ok: true, status: 200, body: stream };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const sidecar = await lorasService.installFromHuggingface(
      {
        url: 'https://huggingface.co/fal/ltx2.3-audio-reactive-lora',
        file: 'ltx2.3_audio_reactive_lora_v2.safetensors',
        token: 'hf_test',
      },
      { fetchImpl },
    );
    expect(sidecar.filename).toBe('lora-fal-ltx2.3-audio-reactive-lora-v2-hf.safetensors');
    expect(sidecar.huggingface.file).toBe('ltx2.3_audio_reactive_lora_v2.safetensors');
    expect(sidecar.name).toBe('ltx2.3-audio-reactive-lora · ltx2.3_audio_reactive_lora_v2');
    expect(sidecar.recommendedScale).toBe(1.2);
  });

  it('refuses a repo it cannot classify as a supported family', async () => {
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

  it('installs a Flux.2 Klein 9B collection as flux2 and picks the klein9b file', async () => {
    const characterSheet = {
      id: 'Alissonerdx/CharacterSheet',
      tags: ['lora', 'flux.2', 'flux.2-klein-9b', 'krea-2'],
      siblings: [
        { rfilename: 'DynamicCharacterSheet_krea2_v1.safetensors' },
        { rfilename: 'QuadView_klein9b_v1.safetensors' },
        { rfilename: 'QuadView_krea2_v1.safetensors' },
        { rfilename: 'TripleView_klein9b_v1.safetensors' },
      ],
    };
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.startsWith('https://huggingface.co/api/models/Alissonerdx/CharacterSheet')) {
        return mockJsonResponse(characterSheet);
      }
      if (url.includes('/resolve/main/QuadView_klein9b_v1.safetensors')) {
        const stream = new ReadableStream({
          start(c) { c.enqueue(new Uint8Array(validSafetensors())); c.close(); },
        });
        return { ok: true, status: 200, body: stream };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const sidecar = await lorasService.installFromHuggingface(
      { url: 'https://huggingface.co/Alissonerdx/CharacterSheet' },
      { fetchImpl },
    );
    expect(sidecar.runnerFamily).toBe('flux2');
    expect(sidecar.fluxVariant).toBe('9b');
    expect(sidecar.huggingface.file).toBe('QuadView_klein9b_v1.safetensors');
    expect(sidecar.filename).toBe('lora-alissonerdx-charactersheet-quadview-klein9b-v1-hf.safetensors');
    expect(sidecar.name).toContain('QuadView_klein9b_v1');
    expect(calls.some((u) => u.includes('QuadView_klein9b_v1.safetensors'))).toBe(true);
    expect(calls.some((u) => u.includes('krea2'))).toBe(false);
  });

  it('installs a specific Klein 9B file when the pasted URL points at it', async () => {
    const characterSheet = {
      id: 'Alissonerdx/CharacterSheet',
      tags: ['lora', 'flux.2-klein-9b'],
      siblings: [
        { rfilename: 'QuadView_klein9b_v1.safetensors' },
        { rfilename: 'TripleView_klein9b_v1.safetensors' },
      ],
    };
    const fetchImpl = async (url) => {
      if (url.startsWith('https://huggingface.co/api/models/Alissonerdx/CharacterSheet')) {
        return mockJsonResponse(characterSheet);
      }
      if (url.includes('/resolve/main/TripleView_klein9b_v1.safetensors')) {
        const stream = new ReadableStream({
          start(c) { c.enqueue(new Uint8Array(validSafetensors())); c.close(); },
        });
        return { ok: true, status: 200, body: stream };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const sidecar = await lorasService.installFromHuggingface(
      { url: 'https://huggingface.co/Alissonerdx/CharacterSheet/blob/main/TripleView_klein9b_v1.safetensors' },
      { fetchImpl },
    );
    expect(sidecar.huggingface.file).toBe('TripleView_klein9b_v1.safetensors');
    expect(sidecar.runnerFamily).toBe('flux2');
    expect(sidecar.fluxVariant).toBe('9b');
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

describe('LoRA key layout', () => {
  const writeLora = async (name, header) => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    await fs.writeFile(join(tmpLoras, name), validSafetensors(header));
  };

  it('classifies and backfills keyLayout into the sidecar on list', async () => {
    const fs = await import('fs/promises');
    await writeLora('lora-comfy.safetensors', {
      'diffusion_model.transformer_blocks.0.attn1.to_k.lora_A.weight': { dtype: 'F16', shape: [32, 2048], data_offsets: [0, 1] },
    });
    const list = await lorasService.listLoras();
    expect(list.find((l) => l.filename === 'lora-comfy.safetensors').keyLayout).toBe('comfyui');
    // Sidecar write is fire-and-forget; wait for it to complete.
    await vi.waitFor(async () => {
      const sidecar = JSON.parse(await fs.readFile(join(tmpLoras, 'lora-comfy.safetensors.metadata.json'), 'utf-8'));
      expect(sidecar.keyLayout).toBe('comfyui');
    });
  });

  it('prefers the stored sidecar layout over re-reading the header', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    // Unreadable file — a header read would yield null, so a 'comfyui' result
    // can only have come from the sidecar.
    await fs.writeFile(join(tmpLoras, 'lora-stored.safetensors'), 'garbage');
    await fs.writeFile(join(tmpLoras, 'lora-stored.safetensors.metadata.json'), JSON.stringify({
      filename: 'lora-stored.safetensors', keyLayout: 'comfyui',
    }));
    const list = await lorasService.listLoras();
    expect(list.find((l) => l.filename === 'lora-stored.safetensors').keyLayout).toBe('comfyui');
    expect(await lorasService.getLoraKeyLayout('lora-stored.safetensors')).toBe('comfyui');
  });

  it('reports null (not not_a_lora) when the header is unreadable', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    await fs.writeFile(join(tmpLoras, 'lora-corrupt.safetensors'), 'garbage');
    const list = await lorasService.listLoras();
    expect(list.find((l) => l.filename === 'lora-corrupt.safetensors').keyLayout).toBe(null);
    expect(await lorasService.getLoraKeyLayout('lora-corrupt.safetensors')).toBe(null);
    // Nothing persisted — a later read may succeed.
    expect(existsSync(join(tmpLoras, 'lora-corrupt.safetensors.metadata.json'))).toBe(false);
  });

  it('getLoraKeyLayout classifies from the header when no sidecar exists', async () => {
    await writeLora('lora-kohya.safetensors', {
      'lora_unet_transformer_blocks_0_attn1_to_k.lora_down.weight': { dtype: 'F16', shape: [32, 2048], data_offsets: [0, 1] },
      'lora_unet_transformer_blocks_0_attn1_to_k.lora_up.weight': { dtype: 'F16', shape: [2048, 32], data_offsets: [1, 2] },
    });
    expect(await lorasService.getLoraKeyLayout('lora-kohya.safetensors')).toBe('kohya');
  });
});

describe('LoRA key layout — stored value validation', () => {
  it('re-classifies when the sidecar holds an unrecognized layout string', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    await fs.writeFile(join(tmpLoras, 'lora-bogus.safetensors'), validSafetensors({
      'diffusion_model.transformer_blocks.0.attn1.to_k.lora_A.weight': { dtype: 'F16', shape: [32, 2048], data_offsets: [0, 1] },
    }));
    await fs.writeFile(join(tmpLoras, 'lora-bogus.safetensors.metadata.json'), JSON.stringify({
      filename: 'lora-bogus.safetensors', keyLayout: 'peft-ish',
    }));
    expect(await lorasService.getLoraKeyLayout('lora-bogus.safetensors')).toBe('comfyui');
    const list = await lorasService.listLoras();
    expect(list.find((l) => l.filename === 'lora-bogus.safetensors').keyLayout).toBe('comfyui');
  });
});

describe('readTriggerWordsByFilename (#4665)', () => {
  const writeSidecar = async (filename, body) => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    await fs.writeFile(join(tmpLoras, filename), 'fake-weights');
    await fs.writeFile(join(tmpLoras, `${filename}.metadata.json`), JSON.stringify(body));
  };

  it('keys each LoRA basename to its sidecar trigger words', async () => {
    await writeSidecar('aria.safetensors', { triggerWords: ['aria_tok', 'portrait'] });
    await writeSidecar('grain.safetensors', { triggerWords: ['rstgrm'] });
    expect(await lorasService.readTriggerWordsByFilename(['aria.safetensors', 'grain.safetensors'])).toEqual({
      'aria.safetensors': ['aria_tok', 'portrait'],
      'grain.safetensors': ['rstgrm'],
    });
  });

  it('collapses an absolute path to its basename key (legacy sidecar replay)', async () => {
    await writeSidecar('aria.safetensors', { triggerWords: ['aria_tok'] });
    expect(await lorasService.readTriggerWordsByFilename([join(tmpLoras, 'aria.safetensors')]))
      .toEqual({ 'aria.safetensors': ['aria_tok'] });
  });

  it('reads each LoRA once even when a basename and its path are both listed', async () => {
    await writeSidecar('aria.safetensors', { triggerWords: ['aria_tok'] });
    const out = await lorasService.readTriggerWordsByFilename([
      'aria.safetensors',
      join(tmpLoras, 'aria.safetensors'),
    ]);
    expect(Object.keys(out)).toEqual(['aria.safetensors']);
  });

  it('omits a LoRA with no sidecar, and one whose sidecar predates triggerWords', async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(tmpLoras, { recursive: true });
    await fs.writeFile(join(tmpLoras, 'orphan.safetensors'), 'fake-weights');
    await writeSidecar('legacy.safetensors', { name: 'Legacy' });
    // Absent, not `[]` — the weave then skips it entirely rather than treating
    // it as "read and found none".
    expect(await lorasService.readTriggerWordsByFilename(['orphan.safetensors', 'legacy.safetensors'])).toEqual({});
  });

  it('keeps an explicitly-empty triggerWords array (Civitai reported none)', async () => {
    await writeSidecar('none.safetensors', { triggerWords: [] });
    expect(await lorasService.readTriggerWordsByFilename(['none.safetensors'])).toEqual({ 'none.safetensors': [] });
  });

  it('returns {} for an empty / non-array / junk-entry input without touching disk', async () => {
    expect(await lorasService.readTriggerWordsByFilename([])).toEqual({});
    expect(await lorasService.readTriggerWordsByFilename(null)).toEqual({});
    expect(await lorasService.readTriggerWordsByFilename([null, '', 42])).toEqual({});
  });
});
