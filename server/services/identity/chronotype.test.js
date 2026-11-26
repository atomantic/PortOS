import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ chronotypeData: null }));

vi.mock('./store.js', () => ({
  queueDerivedIdentityWrite: (_file, work) => work(),
  CHRONOTYPE_FILE: 'chronotype.json',
  DEFAULT_CHRONOTYPE: { type: null, confidence: 0, behavioralData: {} },
  loadJSON: vi.fn(async () => structuredClone(h.chronotypeData)),
  saveJSON: vi.fn(async (_file, data) => { h.chronotypeData = data; })
}));

vi.mock('../genome.js', () => ({
  getGenomeSummary: vi.fn(async () => ({ savedMarkers: {} }))
}));

const { deriveChronotype, getEnergySchedule, updateChronotypeBehavioral } = await import('./chronotype.js');
const { saveJSON } = await import('./store.js');

describe('deriveChronotype log line', () => {
  let logs;

  beforeEach(() => {
    logs = [];
    h.chronotypeData = { type: null, confidence: 0, behavioralData: { preferredWakeTime: '05:30', preferredSleepTime: '21:00' } };
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
  });
  afterEach(() => vi.restoreAllMocks());

  it('logs only the marker count, never the chronotype type or confidence', async () => {
    const result = await deriveChronotype();
    const line = logs.find(l => l.includes('Chronotype derived'));
    expect(line).toMatch(/Chronotype derived: \d+ markers$/);
    expect(line).not.toMatch(/morning|intermediate|evening/);
    expect(line).not.toContain(String(result.confidence));
  });
});

it('writes a behavioral edit and its derived values in one save', async () => {
  h.chronotypeData = { behavioralData: { preferredSleepTime: '01:00' } };
  saveJSON.mockClear();
  const updated = await updateChronotypeBehavioral({ preferredWakeTime: '10:00' });

  expect(updated).toMatchObject({
    behavioralData: { preferredSleepTime: '01:00', preferredWakeTime: '10:00' },
    type: 'evening',
    scores: { behavioral: 1, composite: 1 },
  });
  expect(saveJSON).toHaveBeenCalledExactlyOnceWith('chronotype.json', updated);
});

describe('getEnergySchedule', () => {
  beforeEach(() => {
    h.chronotypeData = { type: null, confidence: 0, recommendations: {}, behavioralData: {} };
  });

  it.each([
    ['morning', ['wake', 360, 390], ['exercise', 390, 480], ['peak-focus', 480, 720], ['caffeine-cutoff', 840, 840], ['meal-cutoff', 1140, 1140], ['wind-down', 1230, 1320]],
    ['intermediate', ['wake', 420, 450], ['exercise', 450, 540], ['peak-focus', 570, 780], ['caffeine-cutoff', 900, 900], ['meal-cutoff', 1200, 1200], ['wind-down', 1290, 1380]],
    ['evening', ['wake', 510, 540], ['exercise', 600, 720], ['peak-focus', 660, 900], ['caffeine-cutoff', 960, 960], ['meal-cutoff', 1260, 1260], ['wind-down', 1380, 1440]],
  ])('%s template produces its six schedule bands', async (type, ...expected) => {
    const recs = {
      morning: { wakeTime: '06:00', sleepTime: '22:00', peakFocusStart: '08:00', peakFocusEnd: '12:00', exerciseWindow: '06:30-08:00', windDownStart: '20:30', caffeineCutoff: '14:00', lastMealCutoff: '19:00' },
      intermediate: { wakeTime: '07:00', sleepTime: '23:00', peakFocusStart: '09:30', peakFocusEnd: '13:00', exerciseWindow: '07:30-09:00', windDownStart: '21:30', caffeineCutoff: '15:00', lastMealCutoff: '20:00' },
      evening: { wakeTime: '08:30', sleepTime: '00:30', peakFocusStart: '11:00', peakFocusEnd: '15:00', exerciseWindow: '10:00-12:00', windDownStart: '23:00', caffeineCutoff: '16:00', lastMealCutoff: '21:00' },
    };
    h.chronotypeData = { type, confidence: 0.8, derivedAt: 'now', recommendations: recs[type] };

    const result = await getEnergySchedule();

    expect(result.zones.map(({ id, startMin, endMin }) => [id, startMin, endMin])).toEqual(expected);
    expect(result).toMatchObject({ type, confidence: 0.8 });
  });

  it('omits malformed times and reversed exercise windows', async () => {
    h.chronotypeData = {
      type: 'intermediate', confidence: 0.8, derivedAt: 'now', recommendations: {
        wakeTime: '25:99',
        exerciseWindow: '09:00-07:30',
        peakFocusStart: '25:99',
        peakFocusEnd: '13:00',
        windDownStart: '25:99',
        sleepTime: '22:00',
      }
    };

    expect((await getEnergySchedule()).zones).toEqual([]);
  });

  it('returns an empty schedule when recommendations are absent', async () => {
    h.chronotypeData = { type: 'evening', confidence: 0.8, derivedAt: 'now' };

    expect(await getEnergySchedule()).toEqual({ zones: [], type: null, confidence: 0 });
  });
});
