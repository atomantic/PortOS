import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { meatspace: '/tmp/test-meatspace' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  readJSONFile: vi.fn().mockResolvedValue({ entries: [] }),
}));

import { readJSONFile } from '../lib/fileUtils.js';
import { writeFile } from 'fs/promises';
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
    expect(writeFile).toHaveBeenCalledOnce();
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

    const savedData = JSON.parse(writeFile.mock.calls[0][1]);
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
