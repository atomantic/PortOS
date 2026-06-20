import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory ledger store mirroring atomicWrite(object) + readJSONFile(object|fallback).
const fileStore = new Map();

vi.mock('../../lib/fileUtils.js', () => ({
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, JSON.parse(JSON.stringify(data))); }),
  readJSONFile: vi.fn(async (path, fallback = null) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

// runStagedLLM returns the next queued canned ledger.
const llmQueue = [];
const llmCalls = [];
vi.mock('../../lib/stageRunner.js', () => ({
  runStagedLLM: vi.fn(async (stage, vars) => {
    llmCalls.push({ stage, vars });
    const content = llmQueue.shift();
    return { content, model: 'mock-model', providerId: 'mock-provider', runId: 'run-1' };
  }),
  resolveStageContext: vi.fn(async () => ({ provider: { id: 'mock-provider' }, model: 'mock-model', contextWindow: 1_000_000 })),
}));

vi.mock('../../lib/contextBudget.js', () => ({
  usableInputTokens: vi.fn(() => 100_000),
  estimateTokens: vi.fn(() => 100),
  CHARS_PER_TOKEN: 4,
}));

const seriesFixture = new Map();
vi.mock('./series.js', () => ({
  seriesStore: () => ({ recordDir: (id) => `/mock/series/${id}` }),
  getSeries: vi.fn(async (id) => seriesFixture.get(id) || null),
}));

// Canon fixture — driven per-test.
let canonFixture = { characters: [], places: [], objects: [] };
vi.mock('./seriesCanon.js', () => ({
  getSeriesCanon: vi.fn(async () => canonFixture),
}));

// Manuscript corpus — driven per-test.
let sectionsFixture = [];
vi.mock('./arcPlanner.js', () => ({
  collectManuscriptSections: vi.fn(async () => sectionsFixture),
  sectionsCorpus: (sections) => sections.map((s) => `# Issue ${s.number}\n\n${s.content}`).join('\n\n---\n\n'),
}));

const svc = await import('./continuityBible.js');

const SERIES_ID = 'ser-abc';

function cannedLedger() {
  return {
    facts: [
      { category: 'physical', subject: 'Mara', statement: 'Has green eyes', issueNumber: 1, anchorQuote: 'her green eyes' },
      { category: 'knowledge', subject: 'Dov', statement: 'Knows the safehouse address', issueNumber: 2, anchorQuote: 'Dov memorized it' },
      { category: 'bogus-cat', subject: 'X', statement: 'dropped — bad category' }, // dropped
      { category: 'age', subject: '', statement: 'no subject' }, // dropped (no subject)
      { nonsense: true }, // dropped
    ],
  };
}

beforeEach(() => {
  fileStore.clear();
  llmQueue.length = 0;
  llmCalls.length = 0;
  sectionsFixture = [{ issueId: 'iss-1', number: 1, title: 'One', stageId: 'prose', content: 'It was dusk on the pier.' }];
  canonFixture = {
    characters: [{ id: 'char-1', name: 'Mara', physicalDescription: 'Tall, green eyes', locked: true }],
    places: [{ id: 'place-1', name: 'The Pier', description: 'A rotting harbor pier' }],
    objects: [],
  };
  seriesFixture.clear();
  seriesFixture.set(SERIES_ID, { id: SERIES_ID, name: 'Test Series', styleNotes: 'noir', universeId: 'uni-1' });
});

describe('generateContinuityBible', () => {
  it('seeds facts from canon, learns from prose, drops bad facts, assigns stable ids', async () => {
    llmQueue.push(cannedLedger());
    const out = await svc.generateContinuityBible(SERIES_ID, {});

    expect(out.status).toBe('complete');
    expect(out.sourceContentHash).toBeTruthy();
    expect(out.sourceCanonHash).toBeTruthy();

    // Canon seeds: locked character → physical (canonical), place → location.
    const mara = out.facts.find((f) => f.subject === 'Mara' && f.source === 'canon');
    expect(mara.category).toBe('physical');
    expect(mara.canonical).toBe(true);
    expect(mara.canonEntryId).toBe('char-1');
    const pier = out.facts.find((f) => f.subject === 'The Pier' && f.source === 'canon');
    expect(pier.category).toBe('location');
    expect(pier.canonical).toBe(false); // place not locked

    // Prose facts merged; bad-category / no-subject / nonsense dropped.
    const dov = out.facts.find((f) => f.subject === 'Dov');
    expect(dov.source).toBe('prose');
    expect(dov.category).toBe('knowledge');
    expect(dov.issueNumber).toBeNull(); // canned issueNumber 2 has no matching section → dropped
    expect(out.facts.some((f) => f.subject === 'X')).toBe(false);

    // Stable ids.
    expect(out.facts[0].id).toBe('fact-001');
  });

  it('builds a canon-only ledger without an LLM call when nothing is drafted', async () => {
    sectionsFixture = [];
    const out = await svc.generateContinuityBible(SERIES_ID, {});
    expect(out.status).toBe('complete');
    expect(llmCalls).toHaveLength(0); // no prose → no extraction call
    expect(out.facts.length).toBe(2); // Mara + The Pier from canon
    expect(out.facts.every((f) => f.source === 'canon')).toBe(true);
  });

  it('returns no-content when there is neither canon nor prose', async () => {
    sectionsFixture = [];
    canonFixture = { characters: [], places: [], objects: [] };
    const out = await svc.generateContinuityBible(SERIES_ID, {});
    expect(out.status).toBe('no-content');
    expect(llmCalls).toHaveLength(0);
  });

  it('returns the cached ledger when inputs are unchanged and not forced', async () => {
    llmQueue.push(cannedLedger());
    await svc.generateContinuityBible(SERIES_ID, {});
    const again = await svc.generateContinuityBible(SERIES_ID, {});
    expect(again.cached).toBe(true);
    expect(llmCalls).toHaveLength(1);
  });

  it('re-extracts when forced even if inputs are unchanged', async () => {
    llmQueue.push(cannedLedger(), cannedLedger());
    await svc.generateContinuityBible(SERIES_ID, {});
    await svc.generateContinuityBible(SERIES_ID, { force: true });
    expect(llmCalls).toHaveLength(2);
  });
});

describe('getContinuityBible + staleness', () => {
  it('returns a none shell (with category labels) when never generated but canon exists', async () => {
    const out = await svc.getContinuityBible(SERIES_ID);
    expect(out.status).toBe('none');
    expect(out.facts).toEqual([]);
    // Categories ship with every response so the client never hand-syncs them.
    expect(out.categories.map((c) => c.id)).toContain('knowledge');
  });

  it('returns no-content (not none) when there is nothing to ledger', async () => {
    sectionsFixture = [];
    canonFixture = { characters: [], places: [], objects: [] };
    const out = await svc.getContinuityBible(SERIES_ID);
    expect(out.status).toBe('no-content');
  });

  it('flags stale when the manuscript changes after generation', async () => {
    llmQueue.push(cannedLedger());
    await svc.generateContinuityBible(SERIES_ID, {});
    expect((await svc.getContinuityBible(SERIES_ID)).stale).toBe(false);

    sectionsFixture = [{ issueId: 'iss-1', number: 1, title: 'One', stageId: 'prose', content: 'A completely rewritten draft.' }];
    expect((await svc.getContinuityBible(SERIES_ID)).stale).toBe(true);
  });

  it('flags stale when canon changes after generation', async () => {
    llmQueue.push(cannedLedger());
    await svc.generateContinuityBible(SERIES_ID, {});
    expect((await svc.getContinuityBible(SERIES_ID)).stale).toBe(false);

    canonFixture = {
      characters: [{ id: 'char-1', name: 'Mara', physicalDescription: 'Tall, BLUE eyes', locked: true }],
      places: [{ id: 'place-1', name: 'The Pier', description: 'A rotting harbor pier' }],
      objects: [],
    };
    expect((await svc.getContinuityBible(SERIES_ID)).stale).toBe(true);
  });
});

describe('getFactsLedger', () => {
  it('exposes the stored facts for downstream checks', async () => {
    llmQueue.push(cannedLedger());
    await svc.generateContinuityBible(SERIES_ID, {});
    const led = await svc.getFactsLedger(SERIES_ID);
    expect(led.status).toBe('complete');
    expect(led.facts.length).toBeGreaterThan(0);
  });

  it('returns empty when never generated', async () => {
    const led = await svc.getFactsLedger(SERIES_ID);
    expect(led.status).toBe('none');
    expect(led.facts).toEqual([]);
  });
});

describe('pure helpers (__testing)', () => {
  const { seedFactsFromCanon, buildFacts, sanitizeProseFact } = svc.__testing;

  it('seedFactsFromCanon falls back to the legacy character `description` field', () => {
    const facts = seedFactsFromCanon({
      characters: [{ id: 'c1', name: 'Legacy', description: 'Old-style canon text' }],
    });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ category: 'physical', subject: 'Legacy', statement: 'Old-style canon text' });
  });

  it('seedFactsFromCanon maps kinds to categories and respects locked', () => {
    const facts = seedFactsFromCanon({
      characters: [{ id: 'c1', name: 'A', physicalDescription: 'tall', locked: true }, { name: 'NoDesc' }],
      places: [{ id: 'p1', name: 'Town', description: 'small' }],
      objects: [{ id: 'o1', name: 'Sword', description: 'sharp', locked: false }],
    });
    expect(facts).toHaveLength(3); // NoDesc dropped (no description)
    expect(facts.find((f) => f.subject === 'A')).toMatchObject({ category: 'physical', canonical: true });
    expect(facts.find((f) => f.subject === 'Town')).toMatchObject({ category: 'location' });
    expect(facts.find((f) => f.subject === 'Sword')).toMatchObject({ category: 'possession', canonical: false });
  });

  it('buildFacts dedups a prose fact that merely restates a canon fact', () => {
    const canonFacts = seedFactsFromCanon({ characters: [{ id: 'c1', name: 'Mara', physicalDescription: 'green eyes' }] });
    const merged = buildFacts(canonFacts, {
      facts: [{ category: 'physical', subject: 'mara', statement: 'GREEN EYES' }], // case/space dup
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('canon');
  });

  it('sanitizeProseFact rejects unknown categories and half-facts', () => {
    expect(sanitizeProseFact({ category: 'nope', subject: 'X', statement: 'Y' })).toBeNull();
    expect(sanitizeProseFact({ category: 'physical', subject: '', statement: 'Y' })).toBeNull();
    expect(sanitizeProseFact({ category: 'physical', subject: 'X', statement: 'Y' })).toMatchObject({ source: 'prose' });
  });
});
