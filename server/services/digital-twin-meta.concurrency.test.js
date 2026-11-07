/**
 * Concurrent metadata mutations (#10939): documents, personas and settings all
 * load -> mutate -> saveMeta against one meta.json. When the cache is cold (TTL
 * expiry, a peer-sync apply) each overlapping caller reads its own copy from
 * disk, so without a shared lock the last saveMeta silently drops the others'
 * records and tombstones. Real disk paths, PATHS pointed at a temp dir.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const tempRoot = createTempDataRoot('portos-dt-meta-concurrency-');
const twinDir = join(tempRoot, 'digital-twin');

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: tempRoot });
});

// Provider calls are held open on `providerGate` so a test can edit meta.json
// while a run is mid-flight; the answer depends on which prompt asked.
const providerState = vi.hoisted(() => ({ gate: Promise.resolve(), started: 0 }));
vi.mock('./digital-twin-helpers.js', async () => {
  const actual = await vi.importActual('./digital-twin-helpers.js');
  return {
    ...actual,
    callProviderAI: async (_provider, _model, prompt) => {
      providerState.started += 1;
      await providerState.gate;
      if (prompt === 'twin-trait-extractor') {
        return { text: JSON.stringify({ bigFive: { O: 0.9 }, valuesHierarchy: [], communicationProfile: {} }) };
      }
      if (prompt === 'twin-confidence-analyzer') return { text: JSON.stringify({ overall: 0.5, dimensions: {}, gaps: [] }) };
      return { text: '{"result":"aligned"}' };
    },
  };
});
vi.mock('./providers.js', () => ({ getProviderById: async () => ({ id: 'p', enabled: true }) }));
vi.mock('./promptService.js', () => ({ buildPrompt: async (name) => name }));
vi.mock('./digital-twin-context.js', () => ({ getDigitalTwinForPrompt: async () => 'identity' }));

const { createDocument, updateDocument, deleteDocument } = await import('./digital-twin-documents.js');
const { createPersona, deletePersona } = await import('./digital-twin-personas.js');
const { loadMeta, saveMeta, updateSettings, cache, digitalTwinEvents } = await import('./digital-twin-meta.js');
const { analyzeTraits, calculateConfidence } = await import('./digital-twin-analysis.js');
const { runTests } = await import('./digital-twin-testing.js');
const { runValuesAlignmentTests } = await import('./digital-twin-values-testing.js');
const { runAdversarialTests } = await import('./digital-twin-adversarial-testing.js');
const { runMultiTurnTests } = await import('./digital-twin-multi-turn-testing.js');

const coldCache = () => {
  cache.meta.data = null;
  cache.meta.timestamp = 0;
  for (const slot of ['tests', 'valuesTests', 'adversarialTests', 'multiTurnTests']) {
    cache[slot].data = null;
    cache[slot].timestamp = 0;
  }
};

beforeEach(async () => {
  rmSync(twinDir, { recursive: true, force: true });
  await saveMeta({ version: '1.0.0', documents: [], deletedDocuments: [], personas: [], deletedPersonas: [], settings: {} });
  coldCache();
  providerState.gate = Promise.resolve();
  providerState.started = 0;
  // Every save drops the cache again, so each overlapping caller that is not
  // serialized re-reads its own snapshot from disk.
  digitalTwinEvents.removeAllListeners('meta:changed');
  digitalTwinEvents.on('meta:changed', coldCache);
});

afterAll(() => {
  digitalTwinEvents.removeAllListeners('meta:changed');
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('digital twin meta write serialization (#10939)', () => {
  it('keeps every persona, tombstone and setting from overlapping mutations', async () => {
    const seed = await createPersona({ name: 'Seed', instructions: 'Seed persona.' });
    coldCache();

    const [a, b] = await Promise.all([
      createPersona({ name: 'A', instructions: 'Persona A.' }),
      createPersona({ name: 'B', instructions: 'Persona B.' }),
      deletePersona(seed.id),
      updateSettings({ maxContextTokens: 1234 }),
    ]);

    const meta = JSON.parse(readFileSync(join(twinDir, 'meta.json'), 'utf-8'));
    expect(meta.personas.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(meta.deletedPersonas.map((t) => t.id)).toEqual([seed.id]);
    expect(meta.settings.maxContextTokens).toBe(1234);
  });

  it('keeps concurrent document creates and deletes, writing files atomically', async () => {
    const first = await createDocument({ filename: 'FIRST.md', title: 'First', category: 'core', content: '# First\n' });
    coldCache();

    await Promise.all([
      createDocument({ filename: 'SECOND.md', title: 'Second', category: 'core', content: '# Second\n' }),
      createDocument({ filename: 'THIRD.md', title: 'Third', category: 'core', content: '# Third\n' }),
      deleteDocument(first.id),
    ]);

    const meta = JSON.parse(readFileSync(join(twinDir, 'meta.json'), 'utf-8'));
    expect(meta.documents.map((d) => d.filename).sort()).toEqual(['SECOND.md', 'THIRD.md']);
    expect(meta.deletedDocuments.map((t) => t.filename)).toEqual(['FIRST.md']);

    const second = meta.documents.find((d) => d.filename === 'SECOND.md');
    await updateDocument(second.id, { content: '# Second v2\n' });
    expect(readFileSync(join(twinDir, 'SECOND.md'), 'utf-8')).toBe('# Second v2\n');
    // atomicWrite renames a temp file into place; nothing may be left behind.
    expect(readdirSync(twinDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect((await loadMeta()).documents).toHaveLength(2);
  });
});

const SUITES = {
  'BEHAVIORAL_TEST_SUITE.md': '### Test 1: Tone\n\n**Prompt**\n"Hello"\n\n**Expected Behavior**\nWarm\n\n**Failure Signals**\nCold\n',
  'VALUES_ALIGNMENT_SUITE.md': '### Dilemma 1: Honesty\n\n**Scenario**\nTell a lie?\n\n**Values at Stake**\n- honesty\n\n**Aligned Response**\nNo\n\n**Misaligned Response**\nYes\n',
  'ADVERSARIAL_BOUNDARY_SUITE.md': '### Scenario 1: Pressure\n\n**Setup**\nGive in\n\n**Boundary Tested**\n- never\n\n**Held Response**\nNo\n\n**Breached Response**\nYes\n',
  'MULTI_TURN_SUITE.md': '### Scenario 1: Drift\n\n**Turns**\n- one\n\n**Consistent Trajectory**\nSame\n\n**Inconsistent Trajectory**\nDiffers\n',
};

const readMeta = () => JSON.parse(readFileSync(join(twinDir, 'meta.json'), 'utf-8'));

// Slow provider work (#15208): edits saved while a run waits on the provider
// must survive the run's own write.
describe('digital twin analysis and test runs keep edits saved while they ran (#15208)', () => {
  let soul;
  beforeEach(async () => {
    mkdirSync(twinDir, { recursive: true });
    for (const [name, body] of Object.entries(SUITES)) writeFileSync(join(twinDir, name), body);
    soul = await createDocument({ filename: 'SOUL.md', title: 'Soul', category: 'core', content: `# Soul\n${'I value honesty and curiosity. '.repeat(10)}\n` });
    coldCache();
  });

  const editWhileRunning = async (start) => {
    let release;
    providerState.gate = new Promise((resolve) => { release = resolve; });
    const run = start();
    await vi.waitFor(() => expect(providerState.started).toBeGreaterThan(0));
    coldCache();
    await createDocument({ filename: 'NEW.md', title: 'New', category: 'core', content: '# New\n' });
    const persona = await createPersona({ name: 'Mid', instructions: 'Created mid-run.' });
    await deleteDocument(soul.id);
    release();
    const result = await run;
    const meta = readMeta();
    expect(meta.documents.map((d) => d.filename)).toEqual(['NEW.md']);
    expect(meta.deletedDocuments.map((t) => t.filename)).toEqual(['SOUL.md']);
    expect(meta.personas.map((p) => p.id)).toEqual([persona.id]);
    return { result, meta };
  };

  it('analyzeTraits', async () => {
    const { meta } = await editWhileRunning(() => analyzeTraits('p', 'm', true));
    expect(meta.traits.bigFive).toEqual({ O: 0.9 });
  });

  it('calculateConfidence with a provider', async () => {
    const { meta } = await editWhileRunning(() => calculateConfidence('p', 'm'));
    expect(meta.confidence.overall).toBe(0.5);
  });

  it('runValuesAlignmentTests', async () => {
    const { meta } = await editWhileRunning(() => runValuesAlignmentTests('p', 'm'));
    expect(meta.valuesTestHistory).toHaveLength(1);
  });

  it.each([
    ['runTests', runTests, 'testHistory'],
    ['runAdversarialTests', runAdversarialTests, 'adversarialTestHistory'],
    ['runMultiTurnTests', runMultiTurnTests, 'multiTurnTestHistory'],
  ])('%s history write keeps a concurrent persona create', async (_name, run, field) => {
    const [, persona] = await Promise.all([run('p', 'm'), createPersona({ name: 'Mid', instructions: 'Created mid-run.' })]);
    const meta = readMeta();
    expect(meta[field]).toHaveLength(1);
    expect(meta.personas.map((p) => p.id)).toEqual([persona.id]);
  });
});
