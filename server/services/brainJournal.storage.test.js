import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('journal-storage-'),
}));
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: async () => 'local-instance' }));
vi.mock('./obsidian.js', () => ({ upsertNote: vi.fn(), deleteNote: vi.fn() }));
vi.mock('./brainSyncLog.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, appendLocalChanges: vi.fn(actual.appendLocalChanges) };
});

import * as journal from './brainJournal.js';
import * as storage from './brainStorage.js';
import { appendLocalChanges } from './brainSyncLog.js';
import { PATHS } from '../lib/fileUtils.js';

const store = storage.brainCollectionStores().find(item => item.type === 'journals');
const markers = { start: '<!-- test:start -->', end: '<!-- test:end -->' };
const peerTimestamp = '2026-04-17T12:00:01.000Z';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-04-17T12:00:00.000Z'));
  vi.clearAllMocks();
  journal._clearObsidianLocationsCacheForTest();
  await journal.updateSettings({ autoSync: false });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(cleanupTempDataRoots);

// Place a real peer write immediately before the local operation enters the
// storage queue. The old journal code had already read its stale snapshot here;
// the callback form must instead read the peer's accepted state under the lock.
function applyPeerBeforeAdmission(date, base) {
  const queue = store.queueRecordWrite;
  const peer = {
    ...base,
    content: 'Initial text\n\nPeer contribution',
    segments: [{ text: 'Peer contribution', at: peerTimestamp, source: 'text' }],
    updatedAt: peerTimestamp,
  };
  delete peer.id;
  delete peer.obsidianPath;
  delete peer.obsidianVaultId;
  vi.spyOn(store, 'queueRecordWrite').mockImplementationOnce(async (id, work) => {
    expect(await storage.applyRemoteRecord('journals', date, peer, 'update')).toEqual({ applied: true });
    return queue(id, work);
  });
  vi.setSystemTime(new Date('2026-04-17T12:00:02.000Z'));
  return peer;
}

describe('journal writes sharing the Brain record queue', () => {
  it('appends to accepted peer content and persists both contributions', async () => {
    const date = '2026-04-17';
    const base = await journal.setJournalContent(date, 'Initial text');
    applyPeerBeforeAdmission(date, base);

    const entry = await journal.appendJournal(date, 'Local contribution', { source: 'voice' });

    expect(entry.content).toBe('Initial text\n\nPeer contribution\n\nLocal contribution');
    expect(entry.segments.map(segment => segment.text)).toEqual(['Peer contribution', 'Local contribution']);
    expect(JSON.parse(readFileSync(store.recordPath(date), 'utf8')).content).toBe(entry.content);
  });

  it('rejects a stale full replacement after peer admission and returns the fresh local mirror context', async () => {
    const date = '2026-04-18';
    const base = await journal.setJournalContent(date, 'Initial text');
    writeFileSync(join(PATHS.brain, 'journal-obsidian-locations.json'), JSON.stringify({
      [date]: { obsidianPath: 'Daily Log/2026-04-18.md', obsidianVaultId: 'local-vault' },
    }));
    journal._clearObsidianLocationsCacheForTest();
    const peer = applyPeerBeforeAdmission(date, base);
    appendLocalChanges.mockClear();

    await expect(journal.setJournalContent(date, 'Stale rewrite', { ifMatchUpdatedAt: base.updatedAt }))
      .rejects.toMatchObject({
        status: 409,
        code: 'STALE_JOURNAL',
        context: { entry: { content: peer.content, updatedAt: peerTimestamp,
          obsidianPath: 'Daily Log/2026-04-18.md', obsidianVaultId: 'local-vault' } },
      });

    expect(await storage.getById('journals', date)).toMatchObject(peer);
    expect(appendLocalChanges).not.toHaveBeenCalled();
  });

  it('splices an automatic section into fresh peer text without changing its segments', async () => {
    const date = '2026-04-19';
    const base = await journal.setJournalContent(date, 'Initial text');
    const peer = applyPeerBeforeAdmission(date, base);

    const entry = await journal.upsertAutoSection(date, 'Activity summary', markers);

    expect(entry.content).toBe(`${peer.content}\n\n${markers.start}\nActivity summary\n${markers.end}`);
    expect(entry.segments).toEqual(peer.segments);
    expect(JSON.parse(readFileSync(store.recordPath(date), 'utf8')).content).toBe(entry.content);
  });

  it('leaves storage, federation and events untouched for unchanged or empty auto sections', async () => {
    const date = '2026-04-20';
    const entry = await journal.upsertAutoSection(date, 'Activity summary', markers);
    const bytes = readFileSync(store.recordPath(date), 'utf8');
    const emitted = vi.fn();
    storage.brainEvents.on('journals:upserted', emitted);
    appendLocalChanges.mockClear();
    try {
      vi.setSystemTime(new Date('2026-04-17T12:00:03.000Z'));
      expect(await journal.upsertAutoSection(date, 'Activity summary', markers)).toEqual(entry);
      expect(await journal.upsertAutoSection('2026-04-21', '', markers)).toBeNull();
      expect(readFileSync(store.recordPath(date), 'utf8')).toBe(bytes);
      expect(await storage.getById('journals', '2026-04-21')).toBeNull();
      expect(appendLocalChanges).not.toHaveBeenCalled();
      expect(emitted).not.toHaveBeenCalled();
    } finally {
      storage.brainEvents.off('journals:upserted', emitted);
    }
  });
});
