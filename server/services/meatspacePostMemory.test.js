import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock file I/O so tests stay pure
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { meatspace: '/tmp/test-meatspace' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  readJSONFile: vi.fn().mockResolvedValue({ items: [] }),
}));

import { readJSONFile } from '../lib/fileUtils.js';
import {
  getMemoryItems,
  getMemoryItem,
  createMemoryItem,
  updateMemoryItem,
  deleteMemoryItem,
  submitPractice,
  getMastery,
  generateMemoryDrill,
  ELEMENTS_SONG,
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
});
