/**
 * Shared mocks and state for the pipeline issues leaf suites (issueCrud,
 * issueStages, issueSync, issuesShared). Split from issues.test.js (#16214).
 *
 * `vi.mock` calls are hoisted per test file, so each suite declares them and
 * delegates the factories here. Values the tests reassign (`uuidCounter`,
 * `pendingWriteDelay`) live on the exported `state` object because an ES module
 * binding cannot be reassigned from the importing file.
 */
import { vi } from 'vitest';

export const fileStore = new Map();
export const writeCounter = { baseHash: 0 };
export const baseHashEvictionSequence = { enabled: false, tail: Promise.resolve() };
export const coverRefresh = { refreshSeriesCoverImage: vi.fn(async () => {}) };
// `pendingWriteDelay` is a one-shot write delay hook for the concurrency
// regression test: when set, the first atomicWrite whose (path, data) matches
// is held for `ms` before landing, letting a test force a specific
// read→write interleaving deterministically.
export const state = { uuidCounter: 0, pendingWriteDelay: null };

export const fileUtilsFactory = () => ({
  tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => {
    if (typeof path === 'string' && path.endsWith('sync_base_hashes.json')) writeCounter.baseHash += 1;
    if (state.pendingWriteDelay && state.pendingWriteDelay.match(path, data)) {
      const { ms } = state.pendingWriteDelay;
      state.pendingWriteDelay = null; // one-shot
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    fileStore.set(path, data);
  }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
  // Strict-read counterpart (#7260): a held entry is a trustworthy read; a
  // missing one is the ENOENT "genuine empty". This in-memory model has no
  // present-but-unreadable state — conflictJournal.test.js covers the latch.
  readJSONFileStrict: vi.fn(async (path, fallback) => (fileStore.has(path)
    ? { ok: true, value: fileStore.get(path) }
    : { ok: true, value: fallback })),
});

export const conflictJournalFactory = async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    deleteSyncBaseHash: async (...args) => {
      if (!baseHashEvictionSequence.enabled) return actual.deleteSyncBaseHash(...args);
      const previous = baseHashEvictionSequence.tail;
      let release;
      baseHashEvictionSequence.tail = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        return await actual.deleteSyncBaseHash(...args);
      } finally {
        release();
      }
    },
  };
};

export const cryptoFactory = async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++state.uuidCounter}` };
};

export const resetFixtures = (cj) => {
  fileStore.clear();
  cj.__resetBaseHashCacheForTests();
  writeCounter.baseHash = 0;
  baseHashEvictionSequence.enabled = false;
  baseHashEvictionSequence.tail = Promise.resolve();
  state.uuidCounter = 0;
  state.pendingWriteDelay = null;
  coverRefresh.refreshSeriesCoverImage.mockClear();
};
