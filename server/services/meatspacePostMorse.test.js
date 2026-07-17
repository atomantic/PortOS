import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/fileUtils.js', () => ({
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  PATHS: { meatspace: '/tmp/test-meatspace' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  readJSONFile: vi.fn(),
}));

// appendMorseRound / getMorseProgress derive the local day via userLocalToday →
// getSettings (issue #2681). Pin to UTC so the day-key is the UTC day regardless
// of the runner's system timezone (matching the UTC-today assertions below).
vi.mock('../services/settings.js', () => ({
  getSettings: () => Promise.resolve({ timezone: 'UTC' }),
}));

import { readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import {
  appendMorseRound,
  getMorseProgress,
  setKochLevel,
  DEFAULT_KOCH_LEVEL,
  MAX_KOCH_LEVEL,
} from './meatspacePostMorse.js';

const EMPTY = () => ({ kochLevel: null, settings: null, rounds: [] });
const today = () => new Date().toISOString().split('T')[0];

beforeEach(() => {
  vi.clearAllMocks();
  readJSONFile.mockResolvedValue(EMPTY());
});

describe('appendMorseRound', () => {
  it('recomputes accuracy from items and stamps id/date/mode', async () => {
    const round = await appendMorseRound({
      mode: 'copy',
      kochLevel: 5,
      wpm: 18,
      farnsworthWpm: 12,
      items: [
        { sent: 'K', guessed: 'K', correct: true, responseMs: 300 },
        { sent: 'M', guessed: 'R', correct: false, responseMs: 500 },
      ],
    });

    expect(round.accuracy).toBe(50); // 1/2
    expect(round.mode).toBe('copy');
    expect(round.kochLevel).toBe(5);
    expect(round.id).toBeTruthy();
    expect(round.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(atomicWrite).toHaveBeenCalledOnce();
    const saved = atomicWrite.mock.calls[0][1];
    expect(saved.rounds).toHaveLength(1);
  });

  it('normalizes a null/absent guess to an empty-string miss', async () => {
    const round = await appendMorseRound({
      mode: 'send',
      items: [{ sent: 'S', guessed: null, correct: false }],
    });
    expect(round.items[0].guessed).toBe('');
    expect(round.accuracy).toBe(0);
  });

  it('counts an empty-sent insertion against round accuracy', async () => {
    // K→KM flattens to [{K,K},{'',M}] — the insertion drops accuracy to 50%.
    const round = await appendMorseRound({
      mode: 'copy',
      items: [
        { sent: 'K', guessed: 'K', correct: true },
        { sent: '', guessed: 'M', correct: false },
      ],
    });
    expect(round.accuracy).toBe(50);
  });

  it('appends to existing rounds', async () => {
    readJSONFile.mockResolvedValue({ kochLevel: 3, settings: null, rounds: [{ id: 'old' }] });
    await appendMorseRound({ mode: 'copy', items: [{ sent: 'K', guessed: 'K', correct: true }] });
    const saved = atomicWrite.mock.calls[0][1];
    expect(saved.rounds).toHaveLength(2);
    expect(saved.rounds[0].id).toBe('old');
  });
});

describe('serialized writes (no lost update between round POST and level PUT)', () => {
  it('a concurrent round append and level change both persist', async () => {
    // Back the mocked file with a real in-memory store so a lost read-modify-
    // write would actually drop one of the two mutations.
    let store = { kochLevel: null, settings: null, rounds: [] };
    readJSONFile.mockImplementation(async () => JSON.parse(JSON.stringify(store)));
    atomicWrite.mockImplementation(async (_path, data) => { store = JSON.parse(JSON.stringify(data)); });

    // These are exactly the two writes the client fires at once when a round
    // advances the Koch level. Serialized, both must land.
    await Promise.all([
      appendMorseRound({ mode: 'copy', items: [{ sent: 'K', guessed: 'K', correct: true }] }),
      setKochLevel({ kochLevel: 7 }),
    ]);

    expect(store.rounds).toHaveLength(1); // the finished round survived
    expect(store.kochLevel).toBe(7);      // the level advance survived
  });
});

describe('setKochLevel', () => {
  it('sets the level explicitly (advance/reset)', async () => {
    const res = await setKochLevel({ kochLevel: 7 });
    expect(res.kochLevel).toBe(7);
    expect(res.kochLevelSet).toBe(true);
    expect(res.adopted).toBe(false);
    expect(atomicWrite.mock.calls[0][1].kochLevel).toBe(7);
  });

  it('clamps out-of-range levels', async () => {
    expect((await setKochLevel({ kochLevel: 999 })).kochLevel).toBe(MAX_KOCH_LEVEL);
    vi.clearAllMocks();
    readJSONFile.mockResolvedValue(EMPTY());
    expect((await setKochLevel({ kochLevel: 0 })).kochLevel).toBe(1);
  });

  it('adopts a level only when the server has none (adopt-once)', async () => {
    // Server unset → adopt applies.
    const first = await setKochLevel({ kochLevel: 9, adopt: true });
    expect(first.kochLevel).toBe(9);
    expect(first.adopted).toBe(true);
  });

  it('does NOT overwrite an existing server level on adopt', async () => {
    readJSONFile.mockResolvedValue({ kochLevel: 12, settings: null, rounds: [] });
    const res = await setKochLevel({ kochLevel: 4, adopt: true });
    expect(res.kochLevel).toBe(12); // kept the server's authoritative level
    expect(res.adopted).toBe(false);
  });

  it('merges settings when provided', async () => {
    const res = await setKochLevel({ kochLevel: 5, settings: { wpm: 20, toneHz: 650 } });
    expect(res.settings).toMatchObject({ wpm: 20, toneHz: 650 });
  });
});

describe('getMorseProgress', () => {
  it('reports the resolved default level and unset sentinel on a fresh install', async () => {
    const p = await getMorseProgress(30);
    expect(p.kochLevel).toBe(DEFAULT_KOCH_LEVEL);
    expect(p.kochLevelSet).toBe(false);
    expect(p.totalRounds).toBe(0);
    expect(p.confusionPairs).toEqual([]);
    expect(p.charAccuracy).toEqual([]);
  });

  it('reports kochLevelSet:true once a level is stored', async () => {
    readJSONFile.mockResolvedValue({ kochLevel: 8, settings: null, rounds: [] });
    const p = await getMorseProgress(30);
    expect(p.kochLevel).toBe(8);
    expect(p.kochLevelSet).toBe(true);
  });

  it('aggregates a confusion matrix and worst-first per-character accuracy', async () => {
    readJSONFile.mockResolvedValue({
      kochLevel: 5,
      settings: null,
      rounds: [
        {
          id: 'r1', date: today(), mode: 'copy',
          items: [
            { sent: 'K', guessed: 'K', correct: true },
            { sent: 'M', guessed: 'R', correct: false },
            { sent: 'M', guessed: 'R', correct: false },
            { sent: 'E', guessed: '', correct: false }, // a miss → '∅' bucket
          ],
        },
      ],
    });
    const p = await getMorseProgress(30);

    expect(p.confusionMatrix.M).toEqual({ R: 2 });
    expect(p.confusionMatrix.K).toEqual({ K: 1 });
    expect(p.confusionMatrix.E).toEqual({ '∅': 1 });

    // Worst-first: M (0%, 2 attempts) and E (0%, 1) before K (100%).
    expect(p.charAccuracy[0].char).toBe('M');
    expect(p.charAccuracy[0].accuracy).toBe(0);
    expect(p.charAccuracy[p.charAccuracy.length - 1].char).toBe('K');

    // Confusion pairs (sent !== guessed), worst-first by count.
    expect(p.confusionPairs[0]).toEqual({ sent: 'M', guessed: 'R', count: 2 });
  });

  it('excludes empty-sent insertions from the confusion matrix and mastery', async () => {
    readJSONFile.mockResolvedValue({
      kochLevel: 5,
      settings: null,
      rounds: [
        {
          id: 'r1', date: today(), mode: 'copy',
          items: [
            { sent: 'K', guessed: 'K', correct: true },
            { sent: '', guessed: 'M', correct: false }, // insertion — no sent
          ],
        },
      ],
    });
    const p = await getMorseProgress(30);
    // The insertion contributes no confusion cell and no character in mastery.
    expect(p.confusionMatrix['']).toBeUndefined();
    expect(p.charAccuracy.map((c) => c.char)).toEqual(['K']);
    expect(p.confusionPairs).toEqual([]);
  });

  it('builds a per-mode trend series with effective WPM', async () => {
    readJSONFile.mockResolvedValue({
      kochLevel: 5,
      settings: null,
      rounds: [
        { id: 'r1', date: today(), mode: 'copy', wpm: 18, farnsworthWpm: 12, accuracy: 80, items: [{ sent: 'K', guessed: 'K', correct: true }] },
        { id: 'r2', date: today(), mode: 'copy', wpm: 18, farnsworthWpm: 12, accuracy: 90, items: [{ sent: 'K', guessed: 'K', correct: true }] },
      ],
    });
    const p = await getMorseProgress(30);
    expect(p.series.copy).toHaveLength(2);
    expect(p.series.copy[0].effectiveWpm).toBe(12);
    expect(p.series.copy[1].accuracy).toBe(90);
  });

  it('filters rounds outside the day window', async () => {
    readJSONFile.mockResolvedValue({
      kochLevel: 5,
      settings: null,
      rounds: [
        { id: 'old', date: '2020-01-01', mode: 'copy', items: [{ sent: 'K', guessed: 'K', correct: true }] },
        { id: 'new', date: today(), mode: 'copy', items: [{ sent: 'M', guessed: 'M', correct: true }] },
      ],
    });
    const p = await getMorseProgress(7);
    expect(p.totalRounds).toBe(1);
    expect(p.confusionMatrix.M).toBeTruthy();
    expect(p.confusionMatrix.K).toBeUndefined();
  });
});
