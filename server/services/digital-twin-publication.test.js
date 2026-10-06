import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ beforeWrite: null, beforeUnlink: null, provider: null, runProvider: null }));
const root = await mkdtemp(join(tmpdir(), 'digital-twin-publication-'));
vi.mock('../lib/fileUtils.js', async original => {
  const actual = await original();
  return { ...actual, PATHS: { ...actual.PATHS, digitalTwin: root },
    atomicWrite: async (path, data) => { await state.beforeWrite?.(path); return actual.atomicWrite(path, data); } };
});
vi.mock('fs/promises', async original => {
  const actual = await original();
  return { ...actual, unlink: async path => { await state.beforeUnlink?.(path); return actual.unlink(path); } };
});
vi.mock('./providers.js', () => ({ getActiveProvider: async () => state.provider, getProviderById: async () => state.provider }));
vi.mock('./promptService.js', () => ({ buildPrompt: async () => 'example prompt' }));
vi.mock('./promptRunner.js', () => ({ runPromptThroughProvider: (...args) => state.runProvider(...args) }));
vi.mock('./digital-twin-context.js', () => ({ getDigitalTwinForPrompt: async () => '' }));
vi.mock('./digital-twin-analysis.js', () => ({ generateGapRecommendations: () => [] }));
vi.mock('../lib/databaseMaintenanceJournal.js', () => ({ assertDatabaseAdmission() {} }));

const { processEnrichmentAnswer, saveEnrichmentListDocument } = await import('./digital-twin-enrichment.js');
const { applyDigitalTwinRemote } = await import('./digital-twin-sync.js');
const { DEFAULT_META, cache } = await import('./digital-twin-meta.js');
const { ENRICHMENT_CATEGORIES } = await import('./digital-twin-constants.js');
const { acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const document = filename => ({ id: 'example-document', filename, title: 'Example', category: 'core', enabled: true,
  priority: 50, weight: 5, createdAt: '2026-01-01T00:00:00.000Z' });
async function seed(meta = {}) { await writeFile(join(root, 'meta.json'), JSON.stringify({ ...structuredClone(DEFAULT_META), ...meta })); }
async function snapshot() {
  const entries = await Promise.all((await readdir(root)).map(async name => [name, await readFile(join(root, name), 'utf8')]));
  const files = Object.fromEntries(entries);
  return { files, meta: JSON.parse(files['meta.json']) };
}
async function verifyDrains(work, reached, finish, verify) {
  await reached;
  let acquired = false;
  const cut = acquireBackupSnapshotCut().then(release => { acquired = true; return release; });
  try { await turn(); expect(acquired, 'snapshot must wait for the complete document/meta pair').toBe(false); }
  finally { finish(); }
  await work;
  const release = await cut;
  try { await verify(await snapshot()); } finally { release(); }
}

beforeEach(async () => {
  state.beforeWrite = null; state.beforeUnlink = null; state.provider = null; state.runProvider = null;
  cache.meta.data = null; cache.meta.timestamp = 0;
  await rm(root, { recursive: true, force: true }); await mkdir(root);
  await seed();
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('enrichment document publication', () => {
  it.each(['answer', 'scale', 'list'])('drains the %s document rewrite through the saved metadata', async kind => {
    const reached = deferred(); const finish = deferred();
    state.beforeWrite = async path => { if (path.endsWith('meta.json')) { reached.resolve(); await finish.promise; } };
    const category = kind === 'list' ? 'favorite_books' : kind === 'scale' ? 'personality_assessments' : 'core_memories';
    const filename = ENRICHMENT_CATEGORIES[category].targetDoc;
    const work = kind === 'list'
      ? saveEnrichmentListDocument(category, '# Example books\n', [{ title: 'Example book' }])
      : processEnrichmentAnswer({ category, question: 'Example question?', answer: 'Example answer',
        ...(kind === 'scale' ? { questionType: 'scale', scaleValue: 4, scaleQuestionId: 'bf-o-1' } : {}) });
    await verifyDrains(work, reached.promise, finish.resolve, ({ files, meta }) => {
      expect(files[filename]).toContain('Example');
      expect(meta.documents).toEqual(expect.arrayContaining([expect.objectContaining({ filename })]));
      expect(meta.enrichment.questionsAnswered[category]).toBe(1);
    });
  });

  it('allows a snapshot while the provider is pending, then holds its publication outside that cut', async () => {
    const reached = deferred(); const finish = deferred();
    state.provider = { id: 'example', defaultModel: 'example-model' };
    state.runProvider = async () => { reached.resolve(); await finish.promise; return { text: '# Example provider answer' }; };
    const work = processEnrichmentAnswer({ category: 'core_memories', question: 'Example?', answer: 'Example' });
    await reached.promise;
    const release = await acquireBackupSnapshotCut();
    try {
      finish.resolve(); await turn();
      expect((await snapshot()).meta.documents).toEqual([]);
      expect(await readdir(root)).toEqual(['meta.json']);
    } finally { release(); }
    await work;
    expect((await snapshot()).files['MEMORIES.md']).toContain('Example provider answer');
  });
});

describe('peer document sync publication', () => {
  it('drains the meta-first merge through the missing markdown copy', async () => {
    const reached = deferred(); const finish = deferred();
    state.beforeWrite = async path => { if (path.endsWith('EXAMPLE.md')) { reached.resolve(); await finish.promise; } };
    const work = applyDigitalTwinRemote({ meta: { documents: [document('EXAMPLE.md')] }, documents: { 'EXAMPLE.md': '# Example body' } });
    await verifyDrains(work, reached.promise, finish.resolve, ({ files, meta }) => {
      expect(meta.documents).toEqual(expect.arrayContaining([expect.objectContaining({ filename: 'EXAMPLE.md' })]));
      expect(files['EXAMPLE.md']).toBe('# Example body');
    });
  });

  it('keeps the merged tombstone and reaping in the same drained cut', async () => {
    await seed({ documents: [document('EXAMPLE.md')] });
    await writeFile(join(root, 'EXAMPLE.md'), '# Old example');
    const reached = deferred(); const finish = deferred();
    state.beforeUnlink = async path => { if (path.endsWith('EXAMPLE.md')) { reached.resolve(); await finish.promise; } };
    const deletedAt = new Date().toISOString();
    const work = applyDigitalTwinRemote({ meta: { documents: [], deletedDocuments: [{ filename: 'EXAMPLE.md', deletedAt }] },
      documents: { 'EXAMPLE.md': '# Stale peer copy' } });
    await verifyDrains(work, reached.promise, finish.resolve, ({ files, meta }) => {
      expect(meta.documents).toEqual([]);
      expect(meta.deletedDocuments).toEqual([{ filename: 'EXAMPLE.md', deletedAt }]);
      expect(files['EXAMPLE.md']).toBeUndefined();
    });
  });
});
