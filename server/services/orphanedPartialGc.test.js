import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { staticImportClosure } from '../lib/staticImportGraph.js';
import { SERVER_DIR, collectServerSources, readServerSource } from '../lib/testHelper.js';

vi.mock('./hfToken.js', () => ({ getHfToken: async () => null }));

const { sweepOrphanedDownloadPartials } = await import('./orphanedPartialGc.js');
const { downloadSlotstreamModel, _resetSlotstreamDownloadsForTests } = await import('./slotstreamModelManager.js');

const GC_ENTRY = join(SERVER_DIR, 'services', 'orphanedPartialGc.js');

const REPO = 'mlx-community/Qwen3-30B-A3B-4bit';
const DIR_NAME = 'mlx-community__Qwen3-30B-A3B-4bit';
const SHARD = 'S'.repeat(4096);

const ANCIENT = Date.now() - 30 * 24 * 60 * 60 * 1000;

let sweepDir;

beforeEach(async () => {
  sweepDir = await mkdtemp(join(tmpdir(), 'partial-gc-'));
  _resetSlotstreamDownloadsForTests();
});

afterEach(async () => {
  await rm(sweepDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const writeAgedPartial = async (path) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'leftover');
  await utimes(path, new Date(ANCIENT), new Date(ANCIENT));
};

describe('sweepOrphanedDownloadPartials', () => {
  it('unlinks an abandoned partial nobody is downloading', async () => {
    await writeAgedPartial(join(sweepDir, 'weights.gguf.partial'));
    expect(await sweepOrphanedDownloadPartials({ dirs: [sweepDir] })).toMatchObject({ deleted: 1 });
    expect(await readdir(sweepDir)).toEqual([]);
  });

  // The regression this uniquely catches: the sweep used to consult one
  // `isXDownloadInFlight` clause per runtime, so a runtime whose clause nobody
  // added had its live transfer unlinked mid-write. This proves the shared
  // predicate covers a slot the GC never names.
  it('protects a shard a live Slotstream download is writing, without naming Slotstream', async () => {
    const shardPartial = join(sweepDir, DIR_NAME, 'model.safetensors.partial');
    let release;
    const gate = new Promise((r) => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const href = String(url);
      if (href.startsWith('https://huggingface.co/api/models/')) {
        return new Response(JSON.stringify({
          id: REPO,
          siblings: [{ rfilename: 'model.safetensors', lfs: { size: SHARD.length } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(SHARD.slice(0, 512)));
          gate.then(() => controller.error(new Error('aborted')));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-length': String(SHARD.length) } });
    }));

    const download = downloadSlotstreamModel({ model: REPO, cacheDir: sweepDir });
    await vi.waitFor(async () => expect(await readdir(join(sweepDir, DIR_NAME))).toContain('model.safetensors.partial'));
    // Age it past the gate so ONLY the in-flight protection can save it.
    await utimes(shardPartial, new Date(ANCIENT), new Date(ANCIENT));

    expect(await sweepOrphanedDownloadPartials({ dirs: [sweepDir] }))
      .toMatchObject({ deleted: 0, keptProtected: 1 });
    expect(await readdir(join(sweepDir, DIR_NAME))).toContain('model.safetensors.partial');

    release();
    await download;
  });
});

describe('download-slot registration', () => {
  // `isAnyDownloadInFlight` can only answer for slots that have been
  // CONSTRUCTED, and a module's slot is constructed when the module is loaded.
  // So what a slot-claiming download path must still do is be reachable from
  // the GC — the one piece of wiring the shared predicate does not remove.
  // Assert it structurally rather than by convention.
  //
  // Timed out generously: this reads every non-test source under `server/`, the
  // same full-tree scan `importScoping.test.js` documents as slow on CI.
  it('reaches every module that creates a download slot', () => {
    const owners = collectServerSources()
      .filter((rel) => readServerSource(rel).includes('createDownloadSlot('))
      .map((rel) => join(SERVER_DIR, rel));
    // Positive control: a resolver gap must not make this guard look clean.
    expect(owners.length).toBeGreaterThanOrEqual(2);

    const reached = staticImportClosure(GC_ENTRY).files;
    for (const owner of owners) {
      // `downloadPreflight.js` declares the factory; the rest call it.
      if (owner.endsWith(join('lib', 'downloadPreflight.js'))) continue;
      expect(reached.has(owner), `${owner} creates a download slot but orphanedPartialGc.js never loads it, so its live transfers are unprotected`).toBe(true);
    }
  }, 60000);
});
