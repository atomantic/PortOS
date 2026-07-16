import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  // `data` is required because getTrainingStats now imports meatspacePost.js
  // (for the shared unified streak), which transitively loads the drill cache —
  // its module-load `join(PATHS.data, …)` needs a string.
  PATHS: { data: '/tmp/test-data', meatspace: '/tmp/test-meatspace' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  readJSONFile: vi.fn().mockResolvedValue({ entries: [] }),
}));

// getUnifiedActivityStreak (via meatspacePost.js) derives the local day through
// getUserTimezone → getSettings (issue #2681). Mock it to no configured tz so
// the day boundary falls back to the process timezone (TZ=UTC in tests).
vi.mock('../services/settings.js', () => ({
  getSettings: () => Promise.resolve({}),
}));

import { readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import {
  submitTrainingEntry,
  getTrainingStats,
  getTrainingEntries,
} from './meatspacePostTraining.js';

beforeEach(() => {
  vi.clearAllMocks();
  readJSONFile.mockResolvedValue({ entries: [] });
});

describe('submitTrainingEntry', () => {
  it('creates a training entry with correct fields', async () => {
    const entry = await submitTrainingEntry({
      module: 'mental-math',
      drillType: 'multiplication',
      questionCount: 10,
      correctCount: 7,
      totalMs: 45000,
    });

    expect(entry).toMatchObject({
      module: 'mental-math',
      drillType: 'multiplication',
      questionCount: 10,
      correctCount: 7,
      totalMs: 45000,
    });
    expect(entry.id).toBeTruthy();
    expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(entry.timestamp).toBeTruthy();
    expect(atomicWrite).toHaveBeenCalledOnce();
  });

  it('persists a per-question breakdown when supplied (issue #2114)', async () => {
    const questions = [
      { prompt: 'news___', response: 'paper', responseMs: 4200, score: 85, feedback: 'Nice.', correct: true },
      { items: ['firehouse'], responseMs: 5100, score: 40, feedback: 'Partial.', correct: false },
    ];

    const entry = await submitTrainingEntry({
      module: 'llm-drills',
      drillType: 'bridge-word',
      questionCount: 2,
      correctCount: 1,
      totalMs: 9300,
      questions,
    });

    expect(entry.questions).toEqual(questions);
    const savedData = atomicWrite.mock.calls[0][1];
    expect(savedData.entries[0].questions).toEqual(questions);
  });

  it('omits the questions field entirely when not supplied (back-compat)', async () => {
    const entry = await submitTrainingEntry({
      module: 'mental-math',
      drillType: 'multiplication',
      questionCount: 10,
      correctCount: 7,
      totalMs: 45000,
    });

    expect(entry).not.toHaveProperty('questions');
  });

  it('appends to existing entries', async () => {
    readJSONFile.mockResolvedValue({
      entries: [{ id: 'old', module: 'mental-math', drillType: 'powers' }]
    });

    await submitTrainingEntry({
      module: 'llm-drills',
      drillType: 'wit-comeback',
      questionCount: 5,
      correctCount: 3,
      totalMs: 30000,
    });

    const savedData = atomicWrite.mock.calls[0][1];
    expect(savedData.entries).toHaveLength(2);
    expect(savedData.entries[0].id).toBe('old');
    expect(savedData.entries[1].module).toBe('llm-drills');
  });
});

describe('getTrainingStats', () => {
  it('returns empty stats for no entries', async () => {
    const stats = await getTrainingStats(30);
    expect(stats).toMatchObject({
      days: 30,
      totalEntries: 0,
      currentStreak: 0,
      byDrill: {},
    });
  });

  it('computes accuracy and practice count by drill', async () => {
    const today = new Date().toISOString().split('T')[0];
    readJSONFile.mockResolvedValue({
      entries: [
        { date: today, module: 'mental-math', drillType: 'multiplication', questionCount: 10, correctCount: 8, totalMs: 5000 },
        { date: today, module: 'mental-math', drillType: 'multiplication', questionCount: 10, correctCount: 6, totalMs: 6000 },
      ]
    });

    const stats = await getTrainingStats(30);
    expect(stats.totalEntries).toBe(2);
    expect(stats.byDrill['mental-math:multiplication']).toMatchObject({
      practiceCount: 2,
      accuracy: 70, // (8+6)/(10+10) = 70%
      totalMs: 11000,
      daysActive: 1,
    });
  });

  it('computes streak for consecutive days', async () => {
    const dates = [0, 1, 2].map(d => {
      const dt = new Date(Date.now() - d * 86400000);
      return dt.toISOString().split('T')[0];
    });

    readJSONFile.mockResolvedValue({
      entries: dates.map(date => ({
        date,
        module: 'mental-math',
        drillType: 'multiplication',
        questionCount: 5,
        correctCount: 5,
        totalMs: 3000,
      }))
    });

    const stats = await getTrainingStats(30);
    expect(stats.currentStreak).toBe(3);
  });

  it('aggregates wordplay drill entries the same generic way as any other drill (issue #2097)', async () => {
    const today = new Date().toISOString().split('T')[0];
    readJSONFile.mockResolvedValue({
      entries: [
        { date: today, module: 'llm-drills', drillType: 'compound-chain', questionCount: 5, correctCount: 4, totalMs: 60000 },
        { date: today, module: 'llm-drills', drillType: 'compound-chain', questionCount: 5, correctCount: 5, totalMs: 55000 },
      ]
    });

    const stats = await getTrainingStats(30);
    expect(stats.byDrill['llm-drills:compound-chain']).toMatchObject({
      practiceCount: 2,
      accuracy: 90, // (4+5)/(5+5) = 90%
      totalMs: 115000,
      daysActive: 1,
    });
    expect(stats.currentStreak).toBe(1);
  });

  it('filters by date range', async () => {
    const old = '2020-01-01';
    const today = new Date().toISOString().split('T')[0];
    readJSONFile.mockResolvedValue({
      entries: [
        { date: old, module: 'mental-math', drillType: 'powers', questionCount: 5, correctCount: 5, totalMs: 3000 },
        { date: today, module: 'mental-math', drillType: 'powers', questionCount: 5, correctCount: 3, totalMs: 4000 },
      ]
    });

    const stats = await getTrainingStats(7);
    expect(stats.totalEntries).toBe(1);
  });
});

describe('getTrainingEntries', () => {
  it('returns entries in reverse order (most recent first)', async () => {
    readJSONFile.mockResolvedValue({
      entries: [
        { id: 'a', date: '2024-01-01' },
        { id: 'b', date: '2024-01-02' },
        { id: 'c', date: '2024-01-03' },
      ]
    });

    const entries = await getTrainingEntries(10);
    expect(entries.map(e => e.id)).toEqual(['c', 'b', 'a']);
  });

  it('respects limit', async () => {
    readJSONFile.mockResolvedValue({
      entries: Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, date: '2024-01-01' }))
    });

    const entries = await getTrainingEntries(5);
    expect(entries).toHaveLength(5);
  });
});
