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

// submitTrainingEntry + getUnifiedActivityStreak + getTrainingStats (via
// meatspacePost.js) derive the local day through getUserTimezone → getSettings
// (issue #2681). Default-pin to UTC so the day boundary is the UTC day regardless
// of the runner's own system timezone; tz-specific tests set settingsState.current.
const settingsState = vi.hoisted(() => ({ current: { timezone: 'UTC' } }));
vi.mock('../services/settings.js', () => ({
  getSettings: () => Promise.resolve(settingsState.current),
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

  it('derives the window cutoff from the user local day, not the server UTC day (issue #2681)', async () => {
    // Freeze at 2026-07-16T05:00Z = 2026-07-15 22:00 PDT (UTC day July 16, LA day
    // July 15) and configure LA. A 7-day window ends at local July 15, so its
    // cutoff is 2026-07-08; an entry dated 2026-07-08 (local) is the oldest that
    // must be INCLUDED. Under the old UTC-day cutoff (today=July 16 → cutoff
    // July 09) that entry would be wrongly excluded.
    settingsState.current = { timezone: 'America/Los_Angeles' };
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T05:00:00.000Z'));
    try {
      readJSONFile.mockResolvedValue({
        entries: [
          { date: '2026-07-08', module: 'mental-math', drillType: 'powers', questionCount: 5, correctCount: 5, totalMs: 3000 },
          { date: '2026-07-07', module: 'mental-math', drillType: 'powers', questionCount: 5, correctCount: 4, totalMs: 3000 },
        ],
      });
      const stats = await getTrainingStats(7);
      expect(stats.totalEntries).toBe(1); // only 2026-07-08 falls inside the local window
    } finally {
      vi.useRealTimers();
      settingsState.current = { timezone: 'UTC' };
    }
  });

  it('uses the user-local day for legacy ISO entries in windows and active-day counts', async () => {
    settingsState.current = { timezone: 'Asia/Tokyo' };
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T00:30:00.000Z'));
    try {
      readJSONFile.mockResolvedValue({
        entries: [{
          date: '2026-07-16T15:30:00.000Z',
          module: 'morse',
          drillType: 'morse-copy',
          questionCount: 5,
          correctCount: 4,
          totalMs: 60000,
        }],
      });

      const stats = await getTrainingStats(1);
      expect(stats.totalEntries).toBe(1); // July 17 in Tokyo; raw UTC prefix is July 16.
      expect(stats.activeDays).toBe(1);
      expect(stats.byDrill['morse:morse-copy'].daysActive).toBe(1);
    } finally {
      vi.useRealTimers();
      settingsState.current = { timezone: 'UTC' };
    }
  });
});

describe('getTrainingStats — re-derived day keys after a timezone change (issue #4168)', () => {
  // Entries written while the user was in Los Angeles: `date` is the LA day, while
  // `timestamp` is the true instant (late local evening = next UTC day). Only the
  // SETTING changes below — the stored bytes stay exactly as they were written.
  const laEntries = [
    { id: 'e1', module: 'morse', drillType: 'morse-copy', date: '2026-07-16', timestamp: '2026-07-17T05:30:00.000Z', questionCount: 5, correctCount: 5, totalMs: 30000 },
    { id: 'e2', module: 'morse', drillType: 'morse-copy', date: '2026-07-17', timestamp: '2026-07-18T05:30:00.000Z', questionCount: 5, correctCount: 4, totalMs: 30000 },
  ];

  it('counts the streak against the CURRENT zone, not the frozen stored keys', async () => {
    settingsState.current = { timezone: 'UTC' };
    vi.useFakeTimers();
    // 07-19 UTC: today is unpracticed, so the grace window anchors on 07-18.
    // Under UTC the instants key to 07-17 + 07-18 → a live 2-day streak, where
    // the frozen LA keys (07-16 + 07-17) reach neither and report 0.
    vi.setSystemTime(new Date('2026-07-19T12:00:00Z'));
    try {
      readJSONFile.mockResolvedValue({ entries: laEntries });
      const stats = await getTrainingStats(30);
      expect(stats.currentStreak).toBe(2);
      expect(stats.activeDays).toBe(2);
      expect(stats.byDrill['morse:morse-copy'].daysActive).toBe(2);
      // The stored records are untouched — derivation is a read-time view.
      expect(laEntries.map(e => e.date)).toEqual(['2026-07-16', '2026-07-17']);
    } finally {
      vi.useRealTimers();
      settingsState.current = { timezone: 'UTC' };
    }
  });

  it('windows the same history off the re-derived days', async () => {
    settingsState.current = { timezone: 'UTC' };
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T12:00:00Z'));
    try {
      readJSONFile.mockResolvedValue({ entries: laEntries });
      // A 1-day window ends at 2026-07-17 under UTC, so both re-derived days survive;
      // the older stored key (2026-07-16) would have been clipped.
      const stats = await getTrainingStats(1);
      expect(stats.totalEntries).toBe(2);
    } finally {
      vi.useRealTimers();
      settingsState.current = { timezone: 'UTC' };
    }
  });
});

describe('getTrainingEntries', () => {
  it('re-derives each displayed entry date in the current timezone (issue #4168)', async () => {
    settingsState.current = { timezone: 'UTC' };
    readJSONFile.mockResolvedValue({
      entries: [{ id: 'a', date: '2026-07-16', timestamp: '2026-07-17T05:30:00.000Z' }],
    });
    const entries = await getTrainingEntries(10);
    expect(entries[0].date).toBe('2026-07-17');
  });

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
