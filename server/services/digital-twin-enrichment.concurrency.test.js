/**
 * Enrichment writes share withMetaLock (#14159): overlapping answers for one
 * category must both land in the markdown, a repeated answer must not
 * duplicate or recount, and a list save must not interleave with an append.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ beforeWrite: null }));
const root = await mkdtemp(join(tmpdir(), 'digital-twin-enrichment-lock-'));
vi.mock('../lib/fileUtils.js', async original => {
  const actual = await original();
  return { ...actual, PATHS: { ...actual.PATHS, digitalTwin: root },
    atomicWrite: async (path, data) => { await state.beforeWrite?.(path); return actual.atomicWrite(path, data); } };
});
vi.mock('./provider/providers.js', () => ({ getActiveProvider: async () => null, getProviderById: async () => null }));
vi.mock('./promptService.js', () => ({ buildPrompt: async () => 'example prompt' }));
vi.mock('./digital-twin-context.js', () => ({ getDigitalTwinForPrompt: async () => '' }));
vi.mock('./digital-twin-analysis.js', () => ({ generateGapRecommendations: () => [] }));
vi.mock('../lib/databaseMaintenanceJournal.js', () => ({ assertDatabaseAdmission() {} }));

const { processEnrichmentAnswer, saveEnrichmentListDocument } = await import('./digital-twin-enrichment.js');
const { DEFAULT_META, cache, loadMeta, saveMeta, updateSettings } = await import('./digital-twin-meta.js');
const { ENRICHMENT_CATEGORIES } = await import('./digital-twin-constants.js');
const { createPersona, updatePersona, deletePersona, setActivePersona } = await import('./digital-twin-personas.js');

const category = 'values';
const targetDoc = ENRICHMENT_CATEGORIES[category].targetDoc;
const readDoc = () => readFile(join(root, targetDoc), 'utf8');
const readMeta = async () => JSON.parse(await readFile(join(root, 'meta.json'), 'utf8'));
const answer = (question, text) => processEnrichmentAnswer({ category, question, answer: text });
const turn = () => new Promise(resolve => setImmediate(resolve));

beforeEach(async () => {
  state.beforeWrite = null;
  cache.meta.data = null; cache.meta.timestamp = 0;
  await rm(root, { recursive: true, force: true }); await mkdir(root);
  await writeFile(join(root, 'meta.json'), JSON.stringify(structuredClone(DEFAULT_META)));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('enrichment write serialization (#14159)', () => {
  it('keeps both overlapping answers and counts each once', async () => {
    // Stall the first markdown write so the second answer would read stale content without the lock.
    let stalled = false;
    state.beforeWrite = async path => {
      if (!stalled && path.endsWith(targetDoc)) { stalled = true; await turn(); await turn(); }
    };
    await Promise.all([answer('Q1', 'Answer one'), answer('Q2', 'Answer two')]);

    const doc = await readDoc();
    expect(doc).toContain('### Q1\n\nAnswer one');
    expect(doc).toContain('### Q2\n\nAnswer two');
    expect((await readMeta()).enrichment.questionsAnswered[category]).toBe(2);
  });

  it('does not duplicate or recount a repeated answer', async () => {
    await Promise.all([answer('Q1', 'Same'), answer('Q1', 'Same')]);
    await answer('Q1', 'Same');

    expect((await readDoc()).match(/### Q1/g)).toHaveLength(1);
    expect((await readMeta()).enrichment.questionsAnswered[category]).toBe(1);
  });

  it('applies a list save after an in-flight answer instead of interleaving', async () => {
    let stalled = false;
    state.beforeWrite = async path => {
      if (!stalled && path.endsWith(targetDoc)) { stalled = true; await turn(); await turn(); }
    };
    const first = answer('Q1', 'Answer one');
    await turn();
    await saveEnrichmentListDocument(category, '# Saved list\n', ['a', 'b']);
    await first;

    expect(await readDoc()).toBe('# Saved list\n');
    expect((await readMeta()).enrichment.questionsAnswered[category]).toBe(2);
  });
});

async function expectMetaWriteFailure(write) {
  const cached = await loadMeta();
  const persisted = await readFile(join(root, 'meta.json'));
  state.beforeWrite = path => {
    if (path === join(root, 'meta.json')) throw new Error('injected meta failure');
  };
  try {
    await expect(write()).rejects.toThrow('injected meta failure');
  } finally {
    state.beforeWrite = null;
  }
  expect(cache.meta.data).toBe(cached);
  expect(await loadMeta()).toEqual(JSON.parse(persisted));
  expect(await readFile(join(root, 'meta.json'))).toEqual(persisted);
}

describe('enrichment metadata write failures (#17597)', () => {
  const cases = [
    {
      name: 'free-text answer',
      category,
      write: () => answer('Example question', 'Example answer'),
      content: '### Example question\n\nExample answer\n\n',
      metadata: { enrichment: { questionsAnswered: { values: 1 } }, confidence: { dimensions: { values: 0.15 } } },
    },
    {
      name: 'scale answer',
      category: 'communication',
      write: () => processEnrichmentAnswer({
        category: 'communication', questionType: 'scale', question: 'Example scale', scaleQuestionId: 'comm-f', scaleValue: 5,
      }),
      content: '### Example scale\n\nResponse: Very Formal (5/5)\n\n',
      metadata: {
        enrichment: { questionsAnswered: { communication: 1 }, scaleQuestionsAnswered: { 'comm-f': 5 } },
        confidence: { dimensions: { communication: 0.15 } },
        traits: { communicationProfile: { formality: 10 } },
      },
    },
    {
      name: 'list document',
      category,
      write: () => saveEnrichmentListDocument(category, '# Saved list\n', ['Example item']),
      content: '# Saved list\n',
      metadata: {
        enrichment: { questionsAnswered: { values: 1 }, completedCategories: ['values'], listItems: { values: ['Example item'] } },
      },
    },
  ];

  describe.each(cases)('$name', ({ category, write, content, metadata }) => {
    // An invalid UTF-8 byte makes accidental text decoding during rollback observable.
    it.each([null, Buffer.from('# Previous\r\n\xff', 'latin1')])('restores the prior file (%s) and persists a retry', async previous => {
      const filename = ENRICHMENT_CATEGORIES[category].targetDoc;
      const path = join(root, filename);
      const updatedAt = '2000-01-01T00:00:00.000Z';
      if (previous !== null) {
        await writeFile(path, previous);
        const existingDoc = { id: 'example-doc', filename, title: 'Example', category: 'enrichment', enabled: true, priority: 30, weight: 5, updatedAt };
        await saveMeta({ ...await loadMeta(), documents: [existingDoc] });
      }
      await expectMetaWriteFailure(write);

      if (previous === null) await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(path)).toEqual(previous);

      await write();
      const markdown = await readFile(path, 'utf8');
      expect(markdown.split(content)).toHaveLength(2);
      const persisted = await readMeta();
      expect(persisted).toMatchObject(metadata);
      expect(persisted.documents).toEqual([expect.objectContaining({ filename })]);
      if (previous !== null) {
        expect(persisted.documents[0]).toMatchObject({ id: 'example-doc', updatedAt: expect.any(String) });
        expect(persisted.documents[0].updatedAt > updatedAt).toBe(true);
      }
      expect(await loadMeta()).toEqual(persisted);
    });
  });
});

describe('persona and settings metadata write failures (#17597)', () => {
  it.each([
    ['create persona', () => createPersona({ name: 'New persona', instructions: 'Example instructions' })],
    ['update persona', id => updatePersona(id, { name: 'Updated persona' })],
    ['delete persona', id => deletePersona(id)],
    ['clear active persona', () => setActivePersona(null)],
    ['update settings', () => updateSettings({ autoInjectToCoS: false })],
  ])('preserves the cached and persisted metadata on %s', async (_name, write) => {
    const { id } = await createPersona({ name: 'Example persona', instructions: 'Example instructions' });
    await setActivePersona(id);
    await expectMetaWriteFailure(() => write(id));
  });
});
