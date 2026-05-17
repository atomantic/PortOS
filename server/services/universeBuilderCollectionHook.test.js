import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const collections = await import('./mediaCollections.js');
const recordEvents = await import('./sharing/recordEvents.js');
const hook = await import('./universeBuilderCollectionHook.js');

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
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
});
