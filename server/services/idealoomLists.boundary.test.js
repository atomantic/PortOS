/**
 * Federation boundary for machine-local IdeaLoom lists (#5361).
 *
 * #5336 required that no IdeaLoom list payload or vault metadata participates
 * in Brain federation, reconcile, or the memory bridge — the machine-local rule
 * from docs/decisions/2026-08-08-privacy-records-machine-local.md. Today that
 * holds only STRUCTURALLY: idealoomLists.js builds its own collectionStore
 * outside BRAIN_ENTITY_TYPES, and every federation path derives from that list
 * (or the bridge's own TYPE_MAP). Nothing fails if a later slice registers an
 * IdeaLoom type in either one, which is exactly the regression the ADR forbids
 * — and #5338/#5339 are about to hang vault paths and note content hashes off
 * these records, so the blast radius becomes real PII-adjacent local state.
 *
 * These drive the REAL modules over a temp data root rather than asserting on
 * mock calls, so the guarantee is proven end to end rather than restated.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Allocated lazily on the first PATHS read: brainStorage's module graph reads
// PATHS.brain at import time, before any top-level assignment would run.
var tempRoot; // eslint-disable-line no-var
function getTempRoot() {
  if (!tempRoot) tempRoot = mkdtempSync(join(tmpdir(), 'idealoom-boundary-test-'));
  return tempRoot;
}

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => getTempRoot() });
});

vi.mock('./instances.js', () => ({
  getInstanceId: () => Promise.resolve('local-instance'),
}));

import * as lists from './idealoomLists.js';
import * as brainStorage from './brainStorage.js';
import { brainEvents } from './brainStorage.js';
import * as brainReconcile from './brainReconcile.js';
import * as brainSync from './brainSync.js';
import { CONTENT_COMPOSERS, brainRecordToMemory } from './brainMemoryBridge.js';

afterAll(() => { if (tempRoot) rmSync(tempRoot, { recursive: true, force: true }); });

const listStoreDir = () => lists.ideaLoomListStore().dir;
const listStoreIds = () => (existsSync(listStoreDir())
  ? readdirSync(listStoreDir()).filter((name) => name !== 'index.json')
  : []);

// A list carrying the vault-ish sync metadata #5338/#5339 will attach, so the
// assertions below fail the moment ANY of it reaches a federation payload.
const vaultList = {
  prompt: 'Vault-conditioned prompt 8f2c1a',
  title: 'Machine-local list 8f2c1a',
  category: 'product',
  status: 'draft',
  ideas: ['Local idea 8f2c1a'],
  sync: {
    notePath: 'Idea Loom/machine-local-8f2c1a.md',
    noteHash: 'e3b0c44298fc1c149afbf4c8996fb924',
    vaultId: '2f7f2b1e-6a4a-4f3d-9c11-0d1f8b6a4c22',
  },
};

// Every distinctive string that must never appear in a federated payload.
const secrets = (list) => [
  list.id, list.prompt, list.title, list.ideas[0],
  vaultList.sync.notePath, vaultList.sync.noteHash, vaultList.sync.vaultId,
];

describe('IdeaLoom lists stay outside Brain federation', () => {
  it('never appears in the reconcile snapshot that carries native Brain ideas', async () => {
    const list = await lists.createList(vaultList);
    const idea = await brainStorage.create('ideas', { title: 'Native federated idea' });

    const snapshot = await brainReconcile.getBrainSnapshot();
    expect(Object.keys(snapshot.records)).not.toContain('idealoom-lists');
    // The native idea IS present, so an empty/failed snapshot can't pass this.
    expect(snapshot.records.ideas[idea.id]).toMatchObject({ title: 'Native federated idea' });

    const serialized = JSON.stringify(snapshot);
    for (const secret of secrets(list)) expect(serialized).not.toContain(secret);
  });

  it('leaves the reconcile checksum byte-identical across list writes', async () => {
    const before = await brainReconcile.getBrainChecksum();

    const list = await lists.createList(vaultList);
    await lists.updateList(list.id, { title: 'Renamed machine-local list' });
    await lists.updateSettings({ autoSync: true });
    // The checksum is cached until a brain mutation event fires, and IdeaLoom
    // writes deliberately emit none — so force a rebuild. Without this the
    // assertion would pass on a stale cache no matter what the list store did.
    brainEvents.emit('record:changed');

    expect(await brainReconcile.getBrainChecksum()).toBe(before);

    // Bypass probe: a native Brain write MUST move the checksum, otherwise the
    // equality above proves nothing about what the checksum covers.
    await brainStorage.create('people', { name: 'Checksum probe' });
    expect(await brainReconcile.getBrainChecksum()).not.toBe(before);
  });

  it('refuses a peer change addressed to the idealoom-lists type', async () => {
    // Seed a local list first: comparing two empty directory listings would
    // pass even if the store were never consulted.
    await lists.createList(vaultList);
    const idsBefore = listStoreIds();
    expect(idsBefore.length).toBeGreaterThan(0);

    const result = await brainSync.applyRemoteChanges([{
      op: 'create',
      type: 'idealoom-lists',
      id: 'b9d3c0a1-4f52-4a6e-8d70-2c19f5b7ae31',
      record: { ...vaultList, updatedAt: new Date().toISOString() },
      originInstanceId: 'remote-instance',
    }]);

    expect(result).toMatchObject({ inserted: 0, updated: 0, deleted: 0, skipped: 1 });
    expect(listStoreIds()).toEqual(idsBefore);
  });

  it('ignores an idealoom-lists key in a peer reconcile snapshot', async () => {
    await lists.createList(vaultList);
    const idsBefore = listStoreIds();
    expect(idsBefore.length).toBeGreaterThan(0);

    const applied = await brainReconcile.applyBrainSnapshot({
      records: {
        'idealoom-lists': {
          'b9d3c0a1-4f52-4a6e-8d70-2c19f5b7ae31': { ...vaultList, updatedAt: new Date().toISOString() },
        },
      },
    });

    expect(applied).toMatchObject({ inserted: 0, updated: 0, deleted: 0, skipped: 0 });
    expect(listStoreIds()).toEqual(idsBefore);
  });

  it('cannot be bridged into the CoS memory system', async () => {
    const list = await lists.createList(vaultList);

    expect(CONTENT_COMPOSERS).not.toHaveProperty('idealoom-lists');
    expect(brainRecordToMemory('idealoom-lists', list)).toBeNull();
  });
});
