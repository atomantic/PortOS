import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ chronotypeData: null }));

vi.mock('./store.js', () => ({
  CHRONOTYPE_FILE: 'chronotype.json',
  DEFAULT_CHRONOTYPE: { type: null, confidence: 0, behavioralData: {} },
  loadJSON: vi.fn(async () => structuredClone(h.chronotypeData)),
  saveJSON: vi.fn(async (_file, data) => { h.chronotypeData = data; })
}));

vi.mock('../genome.js', () => ({
  getGenomeSummary: vi.fn(async () => ({ savedMarkers: {} }))
}));

const { deriveChronotype } = await import('./chronotype.js');

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
