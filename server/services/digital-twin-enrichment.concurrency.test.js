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
vi.mock('./providers.js', () => ({ getActiveProvider: async () => null, getProviderById: async () => null }));
vi.mock('./promptService.js', () => ({ buildPrompt: async () => 'example prompt' }));
vi.mock('./digital-twin-context.js', () => ({ getDigitalTwinForPrompt: async () => '' }));
vi.mock('./digital-twin-analysis.js', () => ({ generateGapRecommendations: () => [] }));
vi.mock('../lib/databaseMaintenanceJournal.js', () => ({ assertDatabaseAdmission() {} }));

const { processEnrichmentAnswer, saveEnrichmentListDocument } = await import('./digital-twin-enrichment.js');
const { DEFAULT_META, cache } = await import('./digital-twin-meta.js');
const { ENRICHMENT_CATEGORIES } = await import('./digital-twin-constants.js');

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
