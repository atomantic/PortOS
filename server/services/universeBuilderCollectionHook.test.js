import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mockNoPeerSync, mockNoPeers } from '../lib/mockPathsDataRoot.js';

const tempData = mkdtempSync(join(tmpdir(), 'portos-ubhook-test-data-'));

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'PATHS') return {
        ...actual.PATHS,
        data: tempData,
        images: join(tempData, 'images'),
        videos: join(tempData, 'videos'),
      };
      return target[prop];
    },
  });
});

// Stub instances.js so non-ephemeral createUniverse paths don't fan out
// to real peers via peerSync's autoSubscribeRecordToAllPeers (instances.js
// uses dataPath whose closure points at REAL PATHS, bypassing the mock
// above).
vi.mock('./instances.js', () => mockNoPeers());
vi.mock('./sharing/peerSync.js', () => mockNoPeerSync());

const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const collections = await import('./mediaCollections.js');
const recordEvents = await import('./sharing/recordEvents.js');
const hook = await import('./universeBuilderCollectionHook.js');
const universeBuilder = await import('./universeBuilder.js');

const sidecarPath = (filename) => join(tempData, 'images', filename.replace('.png', '.metadata.json'));
const writeSidecar = (filename, data) => {
  mkdirSync(join(tempData, 'images'), { recursive: true });
  writeFileSync(sidecarPath(filename), JSON.stringify(data, null, 2));
};
const readSidecar = (filename) => JSON.parse(readFileSync(sidecarPath(filename), 'utf-8'));

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // `await` so async predicates (e.g. getUniverse reads) resolve to a real
    // boolean — a bare Promise is always truthy and would short-circuit. Sync
    // boolean predicates pass through `await` unchanged.
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: predicate never became true');
}

describe('universeBuilderCollectionHook', () => {
  let updates;
  let recordListener;

  beforeEach(() => {
    rmSync(tempData, { recursive: true, force: true });
    mkdirSync(tempData, { recursive: true });
    hook.__testing.reset();
    hook.initUniverseBuilderCollectionHook();
    updates = [];
    // Capture suppression state at emit time — that's the layer the coalesce
    // actually changes. The recordEvents bus fires for every emit; what we
    // care about is how many of those would *actually* trigger a re-export
    // (i.e. how many fired without isReexportSuppressed gating them).
    recordListener = (evt) => updates.push({
      ...evt,
      suppressed: recordEvents.isReexportSuppressed(evt.recordKind, evt.recordId),
    });
    recordEvents.recordEvents.on('updated', recordListener);
  });

  afterEach(() => {
    recordEvents.recordEvents.off('updated', recordListener);
    hook.__testing.reset();
  });

  async function makeCollection(universeId) {
    return collections.findOrCreateCollectionByName({
      name: `c-${Math.random().toString(36).slice(2, 8)}`,
      universeId,
    });
  }

  function emitCompletion({ runId, universeId, collectionId, filename, category = 'landscapes' }) {
    mediaJobEvents.emit('completed', {
      kind: 'image',
      result: { filename },
      params: {
        universeRun: { runId, universeId, collectionId, category, label: 'l' },
      },
    });
  }

  function emitTerminal(eventName, { runId, universeId, collectionId, category = 'landscapes' }) {
    mediaJobEvents.emit(eventName, {
      kind: 'image',
      params: {
        universeRun: { runId, universeId, collectionId, category, label: 'l' },
      },
    });
  }

  it('coalesces per-image emits into a single update at run end', async () => {
    const universeId = 'uni-1';
    const c = await makeCollection(universeId);
    hook.registerUniverseBuilderRun({ runId: 'r1', universeId, jobCount: 3 });

    emitCompletion({ runId: 'r1', universeId, collectionId: c.id, filename: 'a.png' });
    emitCompletion({ runId: 'r1', universeId, collectionId: c.id, filename: 'b.png' });
    emitCompletion({ runId: 'r1', universeId, collectionId: c.id, filename: 'c.png' });

    const forUniverse = () => updates.filter((u) => u.recordKind === 'universe' && u.recordId === universeId);
    const unsuppressed = () => forUniverse().filter((u) => !u.suppressed);
    await waitFor(() => hook.__testing.getActiveRuns().size === 0 && unsuppressed().length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(unsuppressed()).toHaveLength(1);
    expect(hook.__testing.getActiveRuns().size).toBe(0);
  });

  it('counts failed/canceled jobs toward run completion', async () => {
    const universeId = 'uni-2';
    const c = await makeCollection(universeId);
    hook.registerUniverseBuilderRun({ runId: 'r2', universeId, jobCount: 3 });

    emitCompletion({ runId: 'r2', universeId, collectionId: c.id, filename: 'd.png' });
    emitTerminal('failed', { runId: 'r2', universeId, collectionId: c.id });
    emitTerminal('canceled', { runId: 'r2', universeId, collectionId: c.id });

    const forUniverse = () => updates.filter((u) => u.recordKind === 'universe' && u.recordId === universeId);
    const unsuppressed = () => forUniverse().filter((u) => !u.suppressed);
    await waitFor(() => hook.__testing.getActiveRuns().size === 0 && unsuppressed().length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(unsuppressed()).toHaveLength(1);
    expect(hook.__testing.getActiveRuns().size).toBe(0);
  });

  it('falls back to per-image emits when run is not registered', async () => {
    const universeId = 'uni-3';
    const c = await makeCollection(universeId);
    // No registerUniverseBuilderRun — simulates a server restart mid-run.

    emitCompletion({ runId: 'r3', universeId, collectionId: c.id, filename: 'e.png' });
    emitCompletion({ runId: 'r3', universeId, collectionId: c.id, filename: 'f.png' });

    const forUniverse = () => updates.filter((u) => u.recordKind === 'universe' && u.recordId === universeId);
    const unsuppressed = () => forUniverse().filter((u) => !u.suppressed);
    await waitFor(() => unsuppressed().length >= 2);
    expect(unsuppressed()).toHaveLength(2);
  });

  // Seed a fully-formed universe doc on disk so getUniverse() inside the hook
  // can resolve canon names. Returns the seeded universe — callers use its
  // `id` field as the universeId in `universeRun` tags.
  async function seedUniverse({ name, characters = [], categoryKey = 'characters', variations = [] }) {
    const created = await universeBuilder.createUniverse({
      name,
      characters,
      categories: { [categoryKey]: { variations } },
      // Defense-in-depth: the file-top vi.mock of ./instances.js
      // already stubs getPeers to []. Without that mock, a non-ephemeral
      // create would fire autoSubscribeRecordToAllPeers and initial-push
      // the fixture to every real peer in data/instances.json. ephemeral
      // protects the wire even if the mock ever regresses or a future
      // production code path bypasses getPeers.
      ephemeral: true,
    });
    return created;
  }

  it('enriches the image sidecar with canon entry name + universe context', async () => {
    const universeName = 'TestVerse';
    const characterId = 'char-ash';
    const character = { id: characterId, name: 'Ash', physicalDescription: 'red hair' };
    const seeded = await seedUniverse({ name: universeName, characters: [character] });
    const c = await makeCollection(seeded.id);
    const filename = 'canon-render.png';
    writeSidecar(filename, { id: 'canon-render', prompt: 'a confident pyromancer', seed: 42 });
    hook.registerUniverseBuilderRun({ runId: 'r-canon', universeId: seeded.id, jobCount: 1 });

    mediaJobEvents.emit('completed', {
      kind: 'image',
      result: { filename },
      params: {
        universeRun: {
          runId: 'r-canon',
          universeId: seeded.id,
          collectionId: c.id,
          category: 'characters',
          label: 'Ash — pyromancer cut',
          entryRef: { kind: 'canon', kindKey: 'characters', id: characterId },
        },
      },
    });

    await waitFor(() => {
      const sc = readSidecar(filename);
      return sc.entryName === 'Ash';
    });
    const sc = readSidecar(filename);
    expect(sc.universeId).toBe(seeded.id);
    expect(sc.universeName).toBe(universeName);
    expect(sc.universeRunId).toBe('r-canon');
    expect(sc.entryKind).toBe('canon');
    expect(sc.entryCategory).toBe('characters');
    expect(sc.entryId).toBe(characterId);
    expect(sc.entryName).toBe('Ash');           // canonical name wins
    expect(sc.entryLabel).toBe('Ash — pyromancer cut'); // compiled label preserved
    // Original sidecar fields untouched.
    expect(sc.prompt).toBe('a confident pyromancer');
    expect(sc.seed).toBe(42);
  });

  it('uses the compiled label as entryName for variation entries (no canon name)', async () => {
    const variationId = 'var-charm-slinger';
    const seeded = await seedUniverse({
      name: 'CategoryVerse',
      categoryKey: 'characters',
      variations: [{ id: variationId, label: 'Field Lead: Charm-Slinger Detective', prompt: 'detective in a charm bandolier' }],
    });
    const c = await makeCollection(seeded.id);
    const filename = 'variation-render.png';
    writeSidecar(filename, { id: 'variation-render', prompt: 'detective in a charm bandolier' });
    hook.registerUniverseBuilderRun({ runId: 'r-var', universeId: seeded.id, jobCount: 1 });

    mediaJobEvents.emit('completed', {
      kind: 'image',
      result: { filename },
      params: {
        universeRun: {
          runId: 'r-var',
          universeId: seeded.id,
          collectionId: c.id,
          category: 'characters',
          label: 'Field Lead: Charm-Slinger Detective',
          entryRef: { kind: 'variation', categoryKey: 'characters', id: variationId },
        },
      },
    });

    await waitFor(() => readSidecar(filename).entryKind === 'variation');
    const sc = readSidecar(filename);
    expect(sc.entryKind).toBe('variation');
    expect(sc.entryCategory).toBe('characters');
    expect(sc.entryId).toBe(variationId);
    expect(sc.entryName).toBe('Field Lead: Charm-Slinger Detective');
    expect(sc.entryLabel).toBe('Field Lead: Charm-Slinger Detective');
  });

  it('does not touch the sidecar of a non-Universe render (no universeRun tag)', async () => {
    const filename = 'plain-render.png';
    writeSidecar(filename, { id: 'plain-render', prompt: 'just a sunset' });
    mediaJobEvents.emit('completed', {
      kind: 'image',
      result: { filename },
      params: {}, // no universeRun
    });
    // Give the hook a beat to (not) write anything.
    await new Promise((r) => setTimeout(r, 50));
    const sc = readSidecar(filename);
    expect(sc).toEqual({ id: 'plain-render', prompt: 'just a sunset' });
    expect(sc.universeId).toBeUndefined();
  });

  it('preserves an existing universe tag — re-render of the same filename does not clobber', async () => {
    const seeded = await seedUniverse({
      name: 'PreservedVerse',
      characters: [{ id: 'char-original', name: 'Original' }],
    });
    const c = await makeCollection(seeded.id);
    const filename = 'preserved.png';
    // Sidecar already carries a different universe's tag (e.g. a moved/renamed
    // file from a prior render).
    writeSidecar(filename, {
      id: 'preserved',
      universeId: 'uni-existing',
      universeName: 'OldVerse',
      entryName: 'Original',
    });

    // Pre-register the run so the drain-gate below can observe completion —
    // a fixed 50ms sleep raced the IIFE finally under CI load (gh actions
    // shared runners) even though the local run was always fast enough.
    hook.registerUniverseBuilderRun({ runId: 'r-preserve', universeId: seeded.id, jobCount: 1 });
    mediaJobEvents.emit('completed', {
      kind: 'image',
      result: { filename },
      params: {
        universeRun: {
          runId: 'r-preserve',
          universeId: seeded.id,
          collectionId: c.id,
          category: 'characters',
          label: 'New label',
          entryRef: { kind: 'canon', kindKey: 'characters', id: 'char-original' },
        },
      },
    });
    await waitFor(() => hook.__testing.getActiveRuns().size === 0);
    const sc = readSidecar(filename);
    // Existing values preserved.
    expect(sc.universeId).toBe('uni-existing');
    expect(sc.universeName).toBe('OldVerse');
    expect(sc.entryName).toBe('Original');
    // But absent fields get filled in.
    expect(sc.universeRunId).toBe('r-preserve');
    expect(sc.entryKind).toBe('canon');
  });

  it('enriches every sidecar in a batch — all N images get tagged', async () => {
    const seeded = await seedUniverse({
      name: 'BatchVerse',
      characters: [{ id: 'char-batch', name: 'Batchy' }],
    });
    const c = await makeCollection(seeded.id);
    for (let i = 0; i < 5; i += 1) {
      writeSidecar(`batch-${i}.png`, { id: `batch-${i}`, prompt: 'p' });
    }
    hook.registerUniverseBuilderRun({ runId: 'r-batch', universeId: seeded.id, jobCount: 5 });
    for (let i = 0; i < 5; i += 1) {
      mediaJobEvents.emit('completed', {
        kind: 'image',
        result: { filename: `batch-${i}.png` },
        params: {
          universeRun: {
            runId: 'r-batch',
            universeId: seeded.id,
            collectionId: c.id,
            category: 'characters',
            label: 'l',
            entryRef: { kind: 'canon', kindKey: 'characters', id: 'char-batch' },
          },
        },
      });
    }
    // Gate on the run draining (every IIFE reached its `finally` and
    // decremented pending → 0), not on batch-4 alone — the 5 IIFEs run in
    // parallel via `Promise.all` and can complete out of order under CPU or
    // disk-I/O pressure, so the highest-index file landing first leaves the
    // assertion racing a still-pending mid-index write. Mirrors the
    // drain-gate used by the earlier tests in this file.
    await waitFor(() => hook.__testing.getActiveRuns().size === 0);
    for (let i = 0; i < 5; i += 1) {
      const sc = readSidecar(`batch-${i}.png`);
      expect(sc.entryName).toBe('Batchy');
      expect(sc.universeName).toBe('BatchVerse');
    }
  });

  it('files a base-style probe render (universeRun tag, no entryRef) into the collection', async () => {
    const seeded = await seedUniverse({ name: 'StyleVerse' });
    const c = await makeCollection(seeded.id);
    const filename = 'base-style.png';
    writeSidecar(filename, { id: 'base-style', prompt: 'a moody noir skyline', seed: 7 });

    // Mirrors the job the generic /image-gen/generate route enqueues for the
    // base-style probe: a universeRun tag carrying the resolved collectionId +
    // a 'style' label/category, but NO entryRef (the probe isn't a canon entry).
    // The route mints a fresh runId and never calls registerUniverseBuilderRun,
    // so leave the run UNregistered here — filing must work via the hook's
    // per-completion fallback path (getActiveRuns stays empty throughout).
    mediaJobEvents.emit('completed', {
      kind: 'image',
      result: { filename },
      params: {
        universeRun: {
          runId: 'r-style',
          universeId: seeded.id,
          collectionId: c.id,
          category: 'style',
          label: 'Base style',
        },
      },
    });

    // Untracked run, so synchronize on the observable side effect (the sidecar
    // enrich) rather than activeRuns draining — which is already empty here.
    await waitFor(() => readSidecar(filename).universeName === 'StyleVerse');
    expect(hook.__testing.getActiveRuns().size).toBe(0);
    const col = await collections.getCollection(c.id);
    expect(col.items.some((it) => it.kind === 'image' && it.ref === filename)).toBe(true);
    // Sidecar gains universe context (so the collection lightbox shows the world)
    // without clobbering the original generation metadata.
    const sc = readSidecar(filename);
    expect(sc.universeId).toBe(seeded.id);
    expect(sc.universeName).toBe('StyleVerse');
    expect(sc.entryLabel).toBe('Base style');
    expect(sc.entryCategory).toBe('style');
    expect(sc.prompt).toBe('a moody noir skyline');
    expect(sc.seed).toBe(7);
  });

  // #1395 — section-local canon renders carry an entryRef + universeId but NO
  // collectionId. The hook must still durably append the render to the entry's
  // imageRefs[] (and enrich the sidecar) without filing into any collection.
  it('appends a section-local render (entryRef, no collectionId) to the canon entry imageRefs[]', async () => {
    const characterId = 'char-solo';
    const seeded = await seedUniverse({
      name: 'SoloVerse',
      characters: [{ id: characterId, name: 'Solo', physicalDescription: 'lone wanderer' }],
    });
    const filename = 'section-local.png';
    writeSidecar(filename, { id: 'section-local', prompt: 'a lone wanderer', seed: 11 });

    // Route shape for a section-local render: universeId + entryRef, but the
    // route resolves no collection (or provisioning failed), so collectionId is
    // absent. No registerUniverseBuilderRun — these are one-off renders.
    mediaJobEvents.emit('completed', {
      kind: 'image',
      result: { filename },
      params: {
        universeRun: {
          universeId: seeded.id,
          category: 'characters',
          label: 'Solo',
          entryRef: { kind: 'canon', kindKey: 'characters', id: characterId },
        },
      },
    });

    await waitFor(async () => {
      const u = await universeBuilder.getUniverse(seeded.id);
      return u?.characters?.[0]?.imageRefs?.includes(filename);
    });
    const u = await universeBuilder.getUniverse(seeded.id);
    expect(u.characters[0].imageRefs).toEqual([filename]);
    // No collection was created or filed (the hook skipped addItem).
    expect(hook.__testing.getActiveRuns().size).toBe(0);
    // Sidecar still gets universe/entity context.
    const sc = readSidecar(filename);
    expect(sc.entryId).toBe(characterId);
    expect(sc.entryName).toBe('Solo');
    expect(sc.prompt).toBe('a lone wanderer'); // original metadata preserved
  });

  it('is idempotent — the same section-local filename is appended only once', async () => {
    const characterId = 'char-dupe';
    const seeded = await seedUniverse({
      name: 'DupeVerse',
      characters: [{ id: characterId, name: 'Dupe' }],
    });
    const filename = 'dupe.png';
    writeSidecar(filename, { id: 'dupe', prompt: 'p' });

    const emit = () => mediaJobEvents.emit('completed', {
      kind: 'image',
      result: { filename },
      params: {
        universeRun: {
          universeId: seeded.id,
          entryRef: { kind: 'canon', kindKey: 'characters', id: characterId },
        },
      },
    });
    emit();
    await waitFor(async () => {
      const u = await universeBuilder.getUniverse(seeded.id);
      return u?.characters?.[0]?.imageRefs?.includes(filename);
    });
    emit(); // duplicate completion (e.g. a re-emit) must not double-stamp
    await new Promise((r) => setTimeout(r, 50));
    const u = await universeBuilder.getUniverse(seeded.id);
    expect(u.characters[0].imageRefs).toEqual([filename]);
  });

  it('ignores a universeRun tag with neither collectionId nor an entryRef append', async () => {
    const filename = 'noop.png';
    writeSidecar(filename, { id: 'noop', prompt: 'just pixels' });
    mediaJobEvents.emit('completed', {
      kind: 'image',
      result: { filename },
      // universeId present but no collectionId AND no entryRef → nothing to do.
      params: { universeRun: { universeId: 'uni-noop', category: 'style' } },
    });
    await new Promise((r) => setTimeout(r, 50));
    // Sidecar untouched — the hook bailed before enrich.
    expect(readSidecar(filename)).toEqual({ id: 'noop', prompt: 'just pixels' });
  });
});
