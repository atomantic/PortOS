import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock file I/O so tests stay pure
vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  PATHS: { meatspace: '/tmp/test-meatspace' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  readJSONFile: vi.fn().mockResolvedValue({ items: [] }),
}));

// submitPractice stamps the training-log entry's day via userLocalToday →
// getSettings (issue #2681). Pin it to UTC so the day-key is deterministic
// regardless of the runner's own system timezone.
const memorySettingsState = vi.hoisted(() => ({ current: { timezone: 'UTC' } }));
vi.mock('../services/settings.js', () => ({
  getSettings: () => Promise.resolve(memorySettingsState.current),
}));

import { readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import {
  getMemoryItems,
  getMemoryItem,
  createMemoryItem,
  updateMemoryItem,
  deleteMemoryItem,
  submitPractice,
  advanceScheduleFromSession,
  mergeMasteryFromSession,
  applySessionToMemoryItems,
  getMastery,
  getChunkMasteryOrder,
  generateMemoryDrill,
  getDueMemoryItems,
  advanceSchedule,
  mergeScheduleAdvance,
  isMemoryItemDue,
  defaultSchedule,
  DEFAULT_EASE,
  ELEMENTS_SONG,
  windowedAccuracy,
  isStatMastered,
  computeOverallMastery,
  MASTERY_WINDOW,
} from './meatspacePostMemory.js';

// =============================================================================
// ELEMENTS SONG BUILT-IN
// =============================================================================

describe('ELEMENTS_SONG', () => {
  it('has correct structure', () => {
    expect(ELEMENTS_SONG.id).toBe('elements-song');
    expect(ELEMENTS_SONG.builtin).toBe(true);
    expect(ELEMENTS_SONG.type).toBe('song');
    expect(ELEMENTS_SONG.content.lines.length).toBeGreaterThan(20);
    expect(ELEMENTS_SONG.content.chunks.length).toBeGreaterThan(0);
    expect(Object.keys(ELEMENTS_SONG.content.elementMap).length).toBeGreaterThan(100);
  });

  it('has all element symbols mapped to names and atomic numbers', () => {
    const map = ELEMENTS_SONG.content.elementMap;
    // Spot check some elements
    expect(map.H).toEqual({ name: 'Hydrogen', atomicNumber: 1 });
    expect(map.He).toEqual({ name: 'Helium', atomicNumber: 2 });
    expect(map.Au).toEqual({ name: 'Gold', atomicNumber: 79 });
    expect(map.Fe).toEqual({ name: 'Iron', atomicNumber: 26 });
    expect(map.No).toEqual({ name: 'Nobelium', atomicNumber: 102 });
  });

  it('every element referenced in lines exists in elementMap', () => {
    const map = ELEMENTS_SONG.content.elementMap;
    for (const line of ELEMENTS_SONG.content.lines) {
      for (const sym of line.elements || []) {
        expect(map).toHaveProperty(sym);
      }
    }
  });

  it('chunks cover all lines', () => {
    const totalLines = ELEMENTS_SONG.content.lines.length;
    const covered = new Set();
    for (const chunk of ELEMENTS_SONG.content.chunks) {
      for (let i = chunk.lineRange[0]; i <= chunk.lineRange[1]; i++) {
        covered.add(i);
      }
    }
    expect(covered.size).toBe(totalLines);
  });
});

// =============================================================================
// MEMORY ITEMS CRUD
// =============================================================================

describe('getMemoryItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns items with built-in elements song injected', async () => {
    readJSONFile.mockResolvedValue({ items: [] });
    const items = await getMemoryItems();
    expect(items.length).toBe(1);
    expect(items[0].id).toBe('elements-song');
  });

  it('does not duplicate elements song if already present', async () => {
    readJSONFile.mockResolvedValue({ items: [{ ...ELEMENTS_SONG }] });
    const items = await getMemoryItems();
    const elementsSongs = items.filter(i => i.id === 'elements-song');
    expect(elementsSongs.length).toBe(1);
  });
});

describe('createMemoryItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readJSONFile.mockResolvedValue({ items: [] });
  });

  it('creates item with auto-generated id and chunks', async () => {
    const item = await createMemoryItem({
      title: 'Test Poem',
      type: 'poem',
      lines: ['Line one', 'Line two', 'Line three', 'Line four', 'Line five'],
    });

    expect(item.id).toBeTruthy();
    expect(item.title).toBe('Test Poem');
    expect(item.type).toBe('poem');
    expect(item.builtin).toBe(false);
    expect(item.content.lines).toHaveLength(5);
    expect(item.content.chunks.length).toBeGreaterThan(0);
    expect(item.mastery.overallPct).toBe(0);
  });

  it('handles structured line objects', async () => {
    const item = await createMemoryItem({
      title: 'Test',
      lines: [{ text: 'Hello world', elements: ['H'] }],
    });
    expect(item.content.lines[0].text).toBe('Hello world');
    expect(item.content.lines[0].elements).toEqual(['H']);
  });
});

describe('deleteMemoryItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cannot delete built-in items', async () => {
    readJSONFile.mockResolvedValue({ items: [{ ...ELEMENTS_SONG }] });
    const result = await deleteMemoryItem('elements-song');
    expect(result).toBeNull();
  });

  it('deletes custom items', async () => {
    readJSONFile.mockResolvedValue({
      items: [{ id: 'custom-1', title: 'Test', builtin: false, content: { lines: [], chunks: [] }, mastery: { overallPct: 0, chunks: {}, elements: {} } }]
    });
    const result = await deleteMemoryItem('custom-1');
    expect(result).toBeTruthy();
    expect(result.id).toBe('custom-1');
  });
});

// =============================================================================
// UPDATE MEMORY ITEM — built-in "mastery only" restriction (gap #8, issue #2102)
// =============================================================================

describe('updateMemoryItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for an unknown id', async () => {
    readJSONFile.mockResolvedValue({ items: [] });
    const result = await updateMemoryItem('does-not-exist', { title: 'New Title' });
    expect(result).toBeNull();
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('built-in items: applies a mastery update', async () => {
    readJSONFile.mockResolvedValue({ items: [{ ...ELEMENTS_SONG }] });
    const newMastery = { overallPct: 42, chunks: {}, elements: {} };
    const result = await updateMemoryItem('elements-song', { mastery: newMastery });
    expect(result.mastery).toEqual(newMastery);
    expect(atomicWrite).toHaveBeenCalled();
  });

  it('built-in items: applies a schedule update', async () => {
    readJSONFile.mockResolvedValue({ items: [{ ...ELEMENTS_SONG }] });
    const newSchedule = { ease: 2.8, intervalDays: 3, nextReview: '2026-07-10T00:00:00.000Z', lastReviewed: '2026-07-07T00:00:00.000Z' };
    const result = await updateMemoryItem('elements-song', { schedule: newSchedule });
    expect(result.schedule).toEqual(newSchedule);
  });

  it('built-in items: ignores title/lines/chunks updates (mastery/schedule only)', async () => {
    readJSONFile.mockResolvedValue({ items: [{ ...ELEMENTS_SONG }] });
    const originalTitle = ELEMENTS_SONG.title;
    const originalLineCount = ELEMENTS_SONG.content.lines.length;
    const result = await updateMemoryItem('elements-song', {
      title: 'Hacked Title',
      lines: ['only one line now'],
    });
    // Neither mastery nor schedule was in the patch, so the built-in branch's
    // "if (updates.mastery || updates.schedule)" guard is never entered — the
    // item is returned completely untouched (no write at all).
    expect(result.title).toBe(originalTitle);
    expect(result.content.lines.length).toBe(originalLineCount);
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('custom items: applies title/lines/chunks updates freely', async () => {
    readJSONFile.mockResolvedValue({
      items: [{
        id: 'custom-1', title: 'Old Title', builtin: false, type: 'text',
        content: { lines: [{ text: 'old line' }], chunks: [] },
        mastery: { overallPct: 0, chunks: {}, elements: {} },
      }],
    });
    const result = await updateMemoryItem('custom-1', {
      title: 'New Title',
      lines: ['new line one', 'new line two'],
    });
    expect(result.title).toBe('New Title');
    expect(result.content.lines).toEqual([{ text: 'new line one' }, { text: 'new line two' }]);
  });
});

// =============================================================================
// getChunkMasteryOrder — spaced-repetition practice ordering (gap #8, issue #2102)
// =============================================================================

describe('getChunkMasteryOrder', () => {
  it('sorts chunks worst-mastery-first', () => {
    const item = {
      content: {
        chunks: [
          { id: 'verse-1', lineRange: [0, 2], label: 'Verse 1' },
          { id: 'verse-2', lineRange: [3, 5], label: 'Verse 2' },
          { id: 'verse-3', lineRange: [6, 8], label: 'Verse 3' },
        ],
      },
      mastery: {
        chunks: {
          'verse-1': { correct: 9, attempts: 10, lastPracticed: '2026-07-01T00:00:00.000Z' },
          'verse-2': { correct: 1, attempts: 10, lastPracticed: '2026-07-02T00:00:00.000Z' },
          // verse-3 has no recorded stats
        },
      },
    };
    const order = getChunkMasteryOrder(item);
    expect(order.map(c => c.id)).toEqual(['verse-3', 'verse-2', 'verse-1']);
    expect(order.find(c => c.id === 'verse-1').accuracy).toBe(90);
    expect(order.find(c => c.id === 'verse-2').accuracy).toBe(10);
    expect(order.find(c => c.id === 'verse-3').accuracy).toBe(0);
    expect(order.find(c => c.id === 'verse-3').attempts).toBe(0);
    expect(order.find(c => c.id === 'verse-3').lastPracticed).toBeNull();
  });

  it('derives hint levels from accuracy thresholds (0/1/2/3)', () => {
    const item = {
      content: {
        chunks: [
          { id: 'a', lineRange: [0, 0], label: 'A' }, // 95% -> no hints (3)
          { id: 'b', lineRange: [1, 1], label: 'B' }, // 75% -> minimal (2)
          { id: 'c', lineRange: [2, 2], label: 'C' }, // 50% -> partial (1)
          { id: 'd', lineRange: [3, 3], label: 'D' }, // 20% -> full hints (0)
        ],
      },
      mastery: {
        chunks: {
          a: { correct: 19, attempts: 20 },
          b: { correct: 3, attempts: 4 },
          c: { correct: 1, attempts: 2 },
          d: { correct: 1, attempts: 5 },
        },
      },
    };
    const order = getChunkMasteryOrder(item);
    const byId = Object.fromEntries(order.map(c => [c.id, c]));
    expect(byId.a.hintLevel).toBe(3);
    expect(byId.b.hintLevel).toBe(2);
    expect(byId.c.hintLevel).toBe(1);
    expect(byId.d.hintLevel).toBe(0);
  });

  it('returns an empty array when the item has no chunks', () => {
    expect(getChunkMasteryOrder({ content: {}, mastery: {} })).toEqual([]);
    expect(getChunkMasteryOrder({})).toEqual([]);
  });
});

// =============================================================================
// DRILL GENERATION
// =============================================================================

describe('generateMemoryDrill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Return elements song as the only item
    readJSONFile.mockResolvedValue({ items: [] });
  });

  it('generates fill-blank drill', async () => {
    const drill = await generateMemoryDrill({ mode: 'fill-blank', count: 3 });
    expect(drill).toBeTruthy();
    expect(drill.type).toBe('memory-fill-blank');
    expect(drill.memoryItemId).toBe('elements-song');
    expect(drill.questions.length).toBeGreaterThan(0);
    expect(drill.questions.length).toBeLessThanOrEqual(3);

    for (const q of drill.questions) {
      expect(q.prompt).toContain('____');
      expect(q.fullText).toBeTruthy();
      expect(q.answers.length).toBeGreaterThan(0);
    }
  });

  // Regression (issue #2116): generateFillBlank used to return only an
  // `answers[]` array of { index, word, element } objects with no scalar
  // `expected` — the client's fill-blank scoring path (and any generic
  // consumer expecting `expected`, like DrillQuestionReview) had nothing
  // consistent to read. `expected` must now be the primary (first blanked)
  // word, and it must always be ONE of the acceptable `answers[]` words.
  it('stamps a scalar `expected` on every fill-blank question, matching the primary acceptable answer', async () => {
    const drill = await generateMemoryDrill({ mode: 'fill-blank', count: 5 });
    for (const q of drill.questions) {
      expect(typeof q.expected).toBe('string');
      expect(q.expected).toBe(q.answers[0].word);
      expect(q.answers.map(a => a.word)).toContain(q.expected);
    }
  });

  it('generates sequence drill', async () => {
    const drill = await generateMemoryDrill({ mode: 'sequence', count: 3 });
    expect(drill).toBeTruthy();
    expect(drill.type).toBe('memory-sequence');
    expect(drill.questions.length).toBeGreaterThan(0);
    expect(drill.questions.length).toBeLessThanOrEqual(3);

    for (const q of drill.questions) {
      expect(q.prompt).toBeTruthy();
      expect(q.expected).toBeTruthy();
      expect(q.promptLabel).toBe('What comes next?');
    }
  });

  it('generates element-flash drill for elements song', async () => {
    const drill = await generateMemoryDrill({ mode: 'element-flash', count: 5 });
    expect(drill).toBeTruthy();
    expect(drill.type).toBe('memory-element-flash');
    expect(drill.questions.length).toBe(5);

    for (const q of drill.questions) {
      expect(q.element).toBeTruthy();
      expect(q.expected).toBeTruthy();
      expect(['name-to-symbol', 'symbol-to-name']).toContain(q.direction);
    }
  });

  it('picks lowest mastery item by default', async () => {
    // Elements song (0% mastery) is auto-injected, plus two custom items
    // Item 'b' at 10% should be picked over 'a' at 90%, but elements song at 0% would win
    // So use memoryItemId config to test the selection with a specific item
    readJSONFile.mockResolvedValue({
      items: [
        { ...ELEMENTS_SONG, mastery: { overallPct: 95, chunks: {}, elements: {} } },
        { id: 'a', title: 'A', type: 'text', builtin: false, mastery: { overallPct: 90, chunks: {}, elements: {} }, content: { lines: [{ text: 'Line 1' }, { text: 'Line 2' }, { text: 'Line 3' }], chunks: [] } },
        { id: 'b', title: 'B', type: 'text', builtin: false, mastery: { overallPct: 10, chunks: {}, elements: {} }, content: { lines: [{ text: 'Line A' }, { text: 'Line B' }, { text: 'Line C' }], chunks: [] } },
      ]
    });
    const drill = await generateMemoryDrill({ mode: 'sequence', count: 1 });
    expect(drill.memoryItemId).toBe('b');
  });
});

// =============================================================================
// PRACTICE & MASTERY
// =============================================================================

describe('submitPractice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readJSONFile
      .mockResolvedValueOnce({
        items: [{
          ...ELEMENTS_SONG,
          mastery: { overallPct: 0, chunks: {}, elements: {} }
        }]
      })
      .mockResolvedValueOnce({ entries: [] }); // training log
  });

  it('updates element mastery on practice submission', async () => {
    const result = await submitPractice('elements-song', {
      mode: 'element-flash',
      chunkId: null,
      results: [
        { correct: true, element: 'H' },
        { correct: false, element: 'He' },
        { correct: true, element: 'Li' },
      ],
      totalMs: 5000,
    });

    expect(result).toBeTruthy();
    expect(result.mastery.elements.H.correct).toBe(1);
    expect(result.mastery.elements.H.attempts).toBe(1);
    expect(result.mastery.elements.He.correct).toBe(0);
    expect(result.mastery.elements.He.attempts).toBe(1);
  });

  it('updates chunk mastery when chunkId provided', async () => {
    const result = await submitPractice('elements-song', {
      mode: 'fill-blank',
      chunkId: 'verse-1',
      results: [
        { correct: true },
        { correct: true },
        { correct: false },
      ],
      totalMs: 10000,
    });

    expect(result.mastery.chunks['verse-1'].correct).toBe(2);
    expect(result.mastery.chunks['verse-1'].attempts).toBe(3);
    expect(result.mastery.chunks['verse-1'].lastPracticed).toBeTruthy();
  });

  it('stamps the training-log entry date in the user local timezone (issue #2681)', async () => {
    // 2026-07-16T05:00Z = 2026-07-15 22:00 PDT — UTC day July 16, LA day July 15.
    // The logged practice must key off the local day so it counts toward today's
    // unified streak, with the exact instant preserved in `timestamp`.
    memorySettingsState.current = { timezone: 'America/Los_Angeles' };
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T05:00:00.000Z'));
    try {
      await submitPractice('elements-song', {
        mode: 'element-flash', chunkId: null,
        results: [{ correct: true, element: 'H' }], totalMs: 1000,
      });
      const trainingWrite = atomicWrite.mock.calls.find(([p]) => String(p).includes('post-training-log'));
      expect(trainingWrite).toBeTruthy();
      const entry = trainingWrite[1].entries.at(-1);
      expect(entry.date).toBe('2026-07-15');
      expect(entry.timestamp).toBe('2026-07-16T05:00:00.000Z');
    } finally {
      vi.useRealTimers();
      memorySettingsState.current = { timezone: 'UTC' };
    }
  });
});

describe('advanceScheduleFromSession', () => {
  const now = new Date('2026-07-01T00:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('advances the schedule of the referenced item (a POST-session review counts like submitPractice)', async () => {
    readJSONFile.mockResolvedValueOnce({
      items: [{
        ...ELEMENTS_SONG,
        schedule: { ease: 2.5, intervalDays: 0, nextReview: now.toISOString(), lastReviewed: null },
      }],
    });

    const schedule = await advanceScheduleFromSession('elements-song', 1, now);

    expect(schedule).toBeTruthy();
    expect(schedule.intervalDays).toBeGreaterThan(0);
    expect(schedule.lastReviewed).toBe(now.toISOString());
    expect(atomicWrite).toHaveBeenCalledTimes(1);
    const [, written] = atomicWrite.mock.calls[0];
    expect(written.items.find(i => i.id === 'elements-song').schedule).toEqual(schedule);
  });

  it('returns null and writes nothing when memoryItemId is absent', async () => {
    const schedule = await advanceScheduleFromSession(undefined, 1, now);
    expect(schedule).toBeNull();
    expect(readJSONFile).not.toHaveBeenCalled();
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('returns null and writes nothing when the item id does not match any item', async () => {
    readJSONFile.mockResolvedValueOnce({ items: [{ ...ELEMENTS_SONG }] });

    const schedule = await advanceScheduleFromSession('does-not-exist', 1, now);

    expect(schedule).toBeNull();
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('resets the item to due-now on a miss-heavy review (ratio < 0.6)', async () => {
    readJSONFile.mockResolvedValueOnce({
      items: [{
        ...ELEMENTS_SONG,
        schedule: { ease: 2.5, intervalDays: 6, nextReview: now.toISOString(), lastReviewed: '2026-06-20T00:00:00.000Z' },
      }],
    });

    const schedule = await advanceScheduleFromSession('elements-song', 0, now);

    expect(schedule.intervalDays).toBe(0);
    expect(schedule.nextReview).toBe(now.toISOString());
  });
});

describe('mergeMasteryFromSession', () => {
  const now = new Date('2026-07-01T00:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null and writes nothing when memoryItemId is absent', async () => {
    const result = await mergeMasteryFromSession(undefined, [{ chunkId: 'verse-1', correct: true }], now);
    expect(result).toBeNull();
    expect(readJSONFile).not.toHaveBeenCalled();
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('returns null and writes nothing when questions is empty or absent', async () => {
    expect(await mergeMasteryFromSession('elements-song', [], now)).toBeNull();
    expect(await mergeMasteryFromSession('elements-song', undefined, now)).toBeNull();
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('returns null and writes nothing when the item id does not match any item', async () => {
    readJSONFile.mockResolvedValueOnce({ items: [{ ...ELEMENTS_SONG }] });
    const result = await mergeMasteryFromSession('does-not-exist', [{ chunkId: 'verse-1', correct: true }], now);
    expect(result).toBeNull();
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('buckets per-question chunk attribution (memory-sequence) into chunk mastery', async () => {
    readJSONFile.mockResolvedValueOnce({
      items: [{
        ...ELEMENTS_SONG,
        mastery: { overallPct: 0, chunks: {}, elements: {} },
      }],
    });

    const result = await mergeMasteryFromSession('elements-song', [
      { chunkId: 'verse-1', correct: true },
      { chunkId: 'verse-1', correct: false },
      { chunkId: 'verse-2', correct: true },
    ], now);

    expect(result.chunks['verse-1']).toEqual({ correct: 1, attempts: 2, lastPracticed: now.toISOString(), recent: [1, 0] });
    expect(result.chunks['verse-2']).toEqual({ correct: 1, attempts: 1, lastPracticed: now.toISOString(), recent: [1] });
    expect(atomicWrite).toHaveBeenCalledTimes(1);
  });

  it('buckets per-question element attribution (memory-element-flash) into element mastery', async () => {
    readJSONFile.mockResolvedValueOnce({
      items: [{
        ...ELEMENTS_SONG,
        mastery: { overallPct: 0, chunks: {}, elements: {} },
      }],
    });

    const result = await mergeMasteryFromSession('elements-song', [
      { element: 'H', correct: true },
      { element: 'H', correct: true },
      { element: 'He', correct: false },
    ], now);

    expect(result.elements.H).toEqual({ correct: 2, attempts: 2, recent: [1, 1] });
    expect(result.elements.He).toEqual({ correct: 0, attempts: 1, recent: [0] });
  });

  it('accumulates onto existing mastery counts rather than overwriting them', async () => {
    readJSONFile.mockResolvedValueOnce({
      items: [{
        ...ELEMENTS_SONG,
        mastery: {
          overallPct: 0,
          chunks: { 'verse-1': { correct: 2, attempts: 3, lastPracticed: '2026-06-01T00:00:00.000Z' } },
          elements: {},
        },
      }],
    });

    const result = await mergeMasteryFromSession('elements-song', [
      { chunkId: 'verse-1', correct: true },
    ], now);

    expect(result.chunks['verse-1']).toEqual({ correct: 3, attempts: 4, lastPracticed: now.toISOString(), recent: [1] });
  });

  it('ignores questions with neither chunkId nor element', async () => {
    readJSONFile.mockResolvedValueOnce({
      items: [{
        ...ELEMENTS_SONG,
        mastery: { overallPct: 0, chunks: {}, elements: {} },
      }],
    });

    const result = await mergeMasteryFromSession('elements-song', [
      { correct: true },
    ], now);

    expect(result.chunks).toEqual({});
    expect(result.elements).toEqual({});
  });

  it('recomputes overallPct after merging', async () => {
    readJSONFile.mockResolvedValueOnce({
      items: [{
        ...ELEMENTS_SONG,
        mastery: { overallPct: 0, chunks: {}, elements: {} },
      }],
    });

    // 3 correct/3 attempts >= 0.8 accuracy threshold with >=3 attempts marks
    // element mastered per computeOverallMastery's elements-song branch.
    const result = await mergeMasteryFromSession('elements-song', [
      { element: 'H', correct: true },
      { element: 'H', correct: true },
      { element: 'H', correct: true },
    ], now);

    expect(result.overallPct).toBeGreaterThan(0);
  });
});

describe('applySessionToMemoryItems (consolidated one-pass, issue #2098)', () => {
  const now = new Date('2026-07-01T00:00:00.000Z');

  const seedItem = () => ({
    ...ELEMENTS_SONG,
    schedule: { ease: 2.5, intervalDays: 0, nextReview: now.toISOString(), lastReviewed: null },
    mastery: { overallPct: 0, chunks: {}, elements: {} },
  });

  beforeEach(() => vi.clearAllMocks());

  it('reads and writes the memory file exactly once regardless of task count', async () => {
    readJSONFile.mockResolvedValueOnce({ items: [seedItem()] });
    await applySessionToMemoryItems([
      { memoryItemId: 'elements-song', questions: [{ chunkId: 'verse-1', correct: true }] },
      { memoryItemId: 'elements-song', questions: [{ chunkId: 'verse-2', correct: true }] },
    ], now);
    expect(readJSONFile).toHaveBeenCalledTimes(1);
    expect(atomicWrite).toHaveBeenCalledTimes(1);
  });

  it('skips the write entirely for a session with no memory tasks', async () => {
    const result = await applySessionToMemoryItems([{ type: 'doubling-chain' }], now);
    expect(result).toEqual({ updated: 0 });
    expect(readJSONFile).not.toHaveBeenCalled();
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('produces schedule + mastery IDENTICAL to the legacy two-pass path', async () => {
    const questions = [
      { chunkId: 'verse-1', correct: true },
      { chunkId: 'verse-1', correct: false },
      { chunkId: 'verse-2', correct: true },
    ];
    const ratio = questions.filter(q => q.correct).length / questions.length;

    // Legacy path: advanceScheduleFromSession THEN mergeMasteryFromSession, each
    // its own load+save. Feed a fresh item to each call (mocked reads).
    readJSONFile.mockResolvedValueOnce({ items: [seedItem()] }); // advance schedule read
    const legacySchedule = await advanceScheduleFromSession('elements-song', ratio, now);
    readJSONFile.mockResolvedValueOnce({ items: [seedItem()] }); // mastery merge read
    const legacyMastery = await mergeMasteryFromSession('elements-song', questions, now);

    // Consolidated path: single load+save applying both.
    vi.clearAllMocks();
    readJSONFile.mockResolvedValueOnce({ items: [seedItem()] });
    await applySessionToMemoryItems([{ memoryItemId: 'elements-song', questions }], now);
    const written = atomicWrite.mock.calls[0][1].items.find(i => i.id === 'elements-song');

    expect(written.schedule).toEqual(legacySchedule);
    expect(written.mastery.chunks).toEqual(legacyMastery.chunks);
    expect(written.mastery.elements).toEqual(legacyMastery.elements);
    expect(written.mastery.overallPct).toEqual(legacyMastery.overallPct);
  });
});

// =============================================================================
// SPACED-REPETITION SCHEDULER
// =============================================================================

describe('advanceSchedule', () => {
  const now = new Date('2026-07-01T00:00:00.000Z');

  it('a fully-correct session steps a fresh item to a 1-day interval', () => {
    const next = advanceSchedule(defaultSchedule(now.toISOString()), 1, now);
    expect(next.intervalDays).toBe(1);
    expect(next.ease).toBeGreaterThanOrEqual(DEFAULT_EASE);
    expect(next.lastReviewed).toBe(now.toISOString());
    expect(Date.parse(next.nextReview)).toBe(now.getTime() + 24 * 60 * 60 * 1000);
  });

  it('steps 1-day → 6-day → interval*ease on repeated success', () => {
    const one = advanceSchedule({ ease: DEFAULT_EASE, intervalDays: 1, nextReview: now.toISOString() }, 1, now);
    expect(one.intervalDays).toBe(6);
    const two = advanceSchedule({ ease: 2.5, intervalDays: 6, nextReview: now.toISOString() }, 1, now);
    expect(two.intervalDays).toBe(Math.round(6 * two.ease));
    expect(two.intervalDays).toBeGreaterThan(6);
  });

  it('a miss-heavy session resets the interval to 0 (due now) and lowers ease', () => {
    const next = advanceSchedule({ ease: 2.5, intervalDays: 20, nextReview: now.toISOString() }, 0, now);
    expect(next.intervalDays).toBe(0);
    expect(next.ease).toBeLessThan(2.5);
    expect(Date.parse(next.nextReview)).toBe(now.getTime()); // due now
  });

  it('never drops ease below the SM-2 floor of 1.3', () => {
    let schedule = { ease: 1.3, intervalDays: 0, nextReview: now.toISOString() };
    for (let i = 0; i < 10; i++) schedule = advanceSchedule(schedule, 0, now);
    expect(schedule.ease).toBe(1.3);
  });

  it('never lifts ease above the schema ceiling of 5 across many perfect reps', () => {
    let schedule = { ease: 4.9, intervalDays: 6, nextReview: now.toISOString() };
    for (let i = 0; i < 40; i++) schedule = advanceSchedule(schedule, 1, now);
    expect(schedule.ease).toBeLessThanOrEqual(5); // matches memoryScheduleSchema.ease.max(5)
  });

  it('tolerates a missing/garbage prior schedule', () => {
    const next = advanceSchedule(undefined, 1, now);
    expect(next.intervalDays).toBe(1);
    expect(next.ease).toBeGreaterThan(0);
  });
});

describe('mergeScheduleAdvance', () => {
  const now = new Date('2026-07-01T12:00:00.000Z');

  it('applies a first-of-day advance (no prior same-day review)', () => {
    const prev = { ease: 2.5, intervalDays: 0, nextReview: '2026-06-30T00:00:00.000Z', lastReviewed: '2026-06-30T00:00:00.000Z' };
    const advanced = advanceSchedule(prev, 1, now);
    const merged = mergeScheduleAdvance(prev, advanced, now);
    expect(merged.intervalDays).toBe(1); // yesterday's review → today advances once
  });

  it('does not compound the interval on a same-day continuation (per-chunk submits)', () => {
    // Chunk 1 already advanced the item today: interval 1, reviewed today.
    const afterChunk1 = { ease: 2.6, intervalDays: 1, nextReview: '2026-07-02T12:00:00.000Z', lastReviewed: '2026-07-01T09:00:00.000Z' };
    const advanced = advanceSchedule(afterChunk1, 1, now); // would step 1 → 6
    const merged = mergeScheduleAdvance(afterChunk1, advanced, now);
    expect(merged.intervalDays).toBe(1); // interval held, not compounded to 6
    expect(merged.nextReview).toBe(afterChunk1.nextReview); // still tomorrow
    expect(merged.lastReviewed).toBe(advanced.lastReviewed); // ease/lastReviewed refreshed
  });

  it('still resets to due-now on a same-day miss after earlier success', () => {
    const afterChunk1 = { ease: 2.6, intervalDays: 1, nextReview: '2026-07-02T12:00:00.000Z', lastReviewed: '2026-07-01T09:00:00.000Z' };
    const advanced = advanceSchedule(afterChunk1, 0, now); // miss → interval 0
    const merged = mergeScheduleAdvance(afterChunk1, advanced, now);
    expect(merged.intervalDays).toBe(0); // shrink always applies
    expect(Date.parse(merged.nextReview)).toBe(now.getTime()); // due now again
  });
});

describe('isMemoryItemDue', () => {
  const now = new Date('2026-07-01T00:00:00.000Z');

  it('treats a missing schedule as due', () => {
    expect(isMemoryItemDue({}, now)).toBe(true);
    expect(isMemoryItemDue({ schedule: {} }, now)).toBe(true);
  });

  it('is due when nextReview is in the past', () => {
    expect(isMemoryItemDue({ schedule: { nextReview: '2026-06-01T00:00:00.000Z' } }, now)).toBe(true);
  });

  it('is not due when nextReview is in the future', () => {
    expect(isMemoryItemDue({ schedule: { nextReview: '2026-08-01T00:00:00.000Z' } }, now)).toBe(false);
  });
});

describe('getDueMemoryItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns only items whose schedule is due, most-overdue first', async () => {
    readJSONFile.mockResolvedValue({
      items: [
        { id: 'future', title: 'F', schedule: { nextReview: '2999-01-01T00:00:00.000Z' } },
        { id: 'due-recent', title: 'R', schedule: { nextReview: '2026-06-30T00:00:00.000Z' } },
        { id: 'due-old', title: 'O', schedule: { nextReview: '2020-01-01T00:00:00.000Z' } },
      ],
    });
    const now = new Date('2026-07-01T00:00:00.000Z');
    const due = await getDueMemoryItems(now);
    const ids = due.map(i => i.id);
    // elements-song is re-seeded on load and has no persisted schedule → due now.
    expect(ids).toContain('due-old');
    expect(ids).toContain('due-recent');
    expect(ids).not.toContain('future');
    // Most overdue (oldest nextReview) sorts before the recent one.
    expect(ids.indexOf('due-old')).toBeLessThan(ids.indexOf('due-recent'));
  });
});

describe('submitPractice — schedule advancement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readJSONFile
      .mockResolvedValueOnce({ items: [{ ...structuredClone(ELEMENTS_SONG) }] })
      .mockResolvedValueOnce({ entries: [] }); // training log
  });

  it('advances and returns the schedule after a correct session', async () => {
    const result = await submitPractice('elements-song', {
      mode: 'fill-blank',
      results: [{ correct: true }, { correct: true }, { correct: true }],
      totalMs: 5000,
    });
    expect(result.schedule).toBeTruthy();
    expect(result.schedule.intervalDays).toBeGreaterThanOrEqual(1);
    expect(result.schedule.lastReviewed).toBeTruthy();
    expect(Date.parse(result.schedule.nextReview)).toBeGreaterThan(Date.now());
  });

  it('keeps a miss-heavy session due now (interval 0)', async () => {
    const result = await submitPractice('elements-song', {
      mode: 'fill-blank',
      results: [{ correct: false }, { correct: false }, { correct: true }],
      totalMs: 5000,
    });
    expect(result.schedule.intervalDays).toBe(0);
  });
});

// =============================================================================
// DECAY-AWARE WINDOWED MASTERY (issue #2096)
// =============================================================================

describe('windowedAccuracy / isStatMastered', () => {
  it('uses the recent window when present (decay-aware)', () => {
    // Cumulative would read 8/10=80%, but the recent window is a run of misses.
    const stat = { correct: 8, attempts: 10, recent: [0, 0, 0, 1] };
    expect(windowedAccuracy(stat)).toEqual({ attempts: 4, accuracy: 0.25 });
    expect(isStatMastered(stat)).toBe(false);
  });

  it('falls back to cumulative counts for legacy stats with no recent window', () => {
    const stat = { correct: 9, attempts: 10 }; // no `recent`
    expect(windowedAccuracy(stat)).toEqual({ attempts: 10, accuracy: 0.9 });
    expect(isStatMastered(stat)).toBe(true);
  });

  it('enforces the >=3-attempt gate on the window', () => {
    expect(isStatMastered({ recent: [1, 1] })).toBe(false);       // 2 attempts — gated
    expect(isStatMastered({ recent: [1, 1, 1] })).toBe(true);     // 3 attempts, 100%
    expect(isStatMastered({ recent: [1, 1, 0] })).toBe(false);    // 3 attempts, 67% < 0.8
  });

  it('masters at exactly the 0.8 window accuracy', () => {
    expect(isStatMastered({ recent: [1, 1, 1, 1, 0] })).toBe(true); // 4/5 = 0.8
  });
});

describe('computeOverallMastery — ratchet removed, decay-aware (issue #2096)', () => {
  const songWith = (elements) => ({
    id: 'elements-song',
    content: { elementMap: { H: {}, He: {} } },
    mastery: { chunks: {}, elements },
  });

  it('a recent run of misses LOWERS element mastery (no permanent ratchet)', () => {
    // Both elements were mastered all-time (high cumulative), but H just had a
    // window full of recent misses — mastery must drop, not ratchet.
    const before = songWith({
      H: { correct: 20, attempts: 20, recent: [1, 1, 1, 1, 1] },
      He: { correct: 20, attempts: 20, recent: [1, 1, 1, 1, 1] },
    });
    expect(computeOverallMastery(before)).toBe(100);

    const after = songWith({
      H: { correct: 20, attempts: 25, recent: [0, 0, 0, 0, 0] }, // recent decay
      He: { correct: 20, attempts: 20, recent: [1, 1, 1, 1, 1] },
    });
    expect(computeOverallMastery(after)).toBe(50); // H no longer mastered
  });

  it('early misses recover — an element answered wrong early is not permanently diluted', () => {
    // Cumulative 6/10 = 60% (would fail the old all-time >=0.8 gate forever), but
    // the recent window is clean, so it now reads as mastered.
    const item = songWith({
      H: { correct: 6, attempts: 10, recent: [1, 1, 1, 1, 1] },
      He: { correct: 10, attempts: 10, recent: [1, 1, 1, 1, 1] },
    });
    expect(computeOverallMastery(item)).toBe(100);
  });

  it('keeps the >=3-attempt gate (a barely-practiced element is not mastered)', () => {
    const item = songWith({
      H: { correct: 2, attempts: 2, recent: [1, 1] },  // only 2 attempts
      He: { correct: 10, attempts: 10, recent: [1, 1, 1] },
    });
    expect(computeOverallMastery(item)).toBe(50); // only He counts
  });

  it('legacy items with no recent window still report via cumulative counts', () => {
    const item = songWith({
      H: { correct: 9, attempts: 10 },   // legacy shape, 90% >= 0.8
      He: { correct: 5, attempts: 10 },  // 50% < 0.8
    });
    expect(computeOverallMastery(item)).toBe(50);
  });

  it('windows generic-item chunk mastery too', () => {
    const item = {
      id: 'custom',
      content: { chunks: [] },
      mastery: {
        elements: {},
        chunks: {
          a: { correct: 10, attempts: 10, recent: [0, 0, 0, 0] }, // recent decay → 0%
          b: { correct: 10, attempts: 10, recent: [1, 1, 1, 1] }, // 100%
        },
      },
    };
    expect(computeOverallMastery(item)).toBe(50); // (0 + 100) / 2
  });
});

describe('mastery window is bounded', () => {
  it('caps the recent array at MASTERY_WINDOW entries', async () => {
    readJSONFile.mockResolvedValueOnce({
      items: [{
        ...ELEMENTS_SONG,
        mastery: { overallPct: 0, chunks: {}, elements: {} },
      }],
    });
    const answers = Array.from({ length: MASTERY_WINDOW + 5 }, () => ({ element: 'H', correct: true }));
    const result = await mergeMasteryFromSession('elements-song', answers, new Date());
    expect(result.elements.H.recent.length).toBe(MASTERY_WINDOW);
    expect(result.elements.H.attempts).toBe(MASTERY_WINDOW + 5); // cumulative unbounded
  });
});
