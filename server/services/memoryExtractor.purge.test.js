import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { PATHS } from '../lib/fileUtils.js';
import * as memory from './memoryBackend.js';
import * as notifications from './notifications.js';
import { cosEvents } from './cos/cosEvents.js';
import { extractAndStoreMemories } from './memoryExtractor.js';

vi.mock('../lib/fileUtils.js', async importOriginal =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('memory-approval-') }));
vi.mock('./cos/cosState.js', () => ({ getDomainAutonomyMode: async () => 'execute' }));
vi.mock('./domainUsage.js', () => ({
  getDomainBudgetStatus: async () => ({ withinBudget: true }), recordDomainUsage: async () => {}
}));
vi.mock('./memoryClassifier.js', () => ({
  getConfig: async () => ({ fallbackToPatterns: true })
}));
vi.mock('./memoryEmbeddings.js', () => ({ generateMemoryEmbedding: async () => null }));

afterEach(() => vi.restoreAllMocks());
afterAll(cleanupTempDataRoots);

const extract = content => extractAndStoreMemories(null, 'test-task',
  `<MEMORY type="fact" confidence="0.8">${content}</MEMORY>`);

async function persistedPreviews() {
  const files = ['review/items.json', 'review/archive.json', 'notifications.json'];
  return Promise.all(files.map(file => readFile(join(PATHS.data, file), 'utf8').catch(err => {
    if (err.code === 'ENOENT') return '';
    throw err;
  })));
}

it('skips a purged memory when extraction resumes after creating the pending record', async () => {
  const content = 'Synthetic erased approval preview';
  const stored = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const create = memory.createMemory;
  vi.spyOn(memory, 'createMemory').mockImplementationOnce(async (...args) => {
    const record = await create(...args);
    stored.resolve(record.id);
    await resume.promise;
    return record;
  });
  const approval = vi.fn();
  cosEvents.on('memory:approval-needed', approval);
  const extraction = extract(content);
  try {
    const id = await stored.promise;
    await memory.purgeMemory(id);
    resume.resolve();
    expect(await extraction).toMatchObject({ pendingApproval: 0, pendingMemories: [] });
    expect(approval).not.toHaveBeenCalled();
    for (const store of await persistedPreviews()) {
      expect(store).not.toContain(content);
      expect(store).not.toContain(id);
    }
  } finally {
    resume.resolve();
    cosEvents.off('memory:approval-needed', approval);
    await extraction;
  }
});

it('purges both previews when deletion starts between the alert and notification writes', async () => {
  const content = 'Synthetic published approval preview';
  const lookup = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const exists = notifications.exists;
  vi.spyOn(notifications, 'exists').mockImplementationOnce(async (...args) => {
    const found = await exists(...args);
    lookup.resolve(args[2]);
    await resume.promise;
    return found;
  });
  const extraction = extract(content);
  let purge;
  try {
    const id = await lookup.promise;
    const [alerts] = await persistedPreviews();
    expect(JSON.parse(alerts)).toContainEqual(expect.objectContaining({
      title: `Memory approval: ${content}`, metadata: expect.objectContaining({ referenceId: id })
    }));
    const added = vi.fn();
    notifications.notificationEvents.once('added', added);
    purge = memory.purgeMemory(id);
    resume.resolve();
    expect(await extraction).toMatchObject({ pendingMemories: [{ id, content }] });
    expect(added).toHaveBeenCalledWith(expect.objectContaining({ description: content }));
    await purge;
    for (const store of await persistedPreviews()) {
      expect(store).not.toContain(content);
      expect(store).not.toContain(id);
    }
  } finally {
    resume.resolve();
    await Promise.all([extraction, purge]);
  }
});
