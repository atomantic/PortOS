import { describe, it, expect } from 'vitest';
import {
  PHOTO_PRESETS,
  DEFAULT_PRESET_ID,
  getPreset,
  cyclePreset,
  buildPostcardStats,
  screenshotFilename,
} from './cityPhotoMode';

describe('PHOTO_PRESETS', () => {
  it('has unique ids and a position + target each', () => {
    const ids = PHOTO_PRESETS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PHOTO_PRESETS) {
      expect(p.position).toHaveLength(3);
      expect(p.target).toHaveLength(3);
      expect(typeof p.label).toBe('string');
    }
  });
  it('includes the default preset id', () => {
    expect(PHOTO_PRESETS.some(p => p.id === DEFAULT_PRESET_ID)).toBe(true);
  });
});

describe('getPreset', () => {
  it('resolves a known id', () => {
    expect(getPreset('downtown').id).toBe('downtown');
  });
  it('falls back to the default for an unknown id', () => {
    expect(getPreset('nope').id).toBe(DEFAULT_PRESET_ID);
    expect(getPreset(undefined).id).toBe(DEFAULT_PRESET_ID);
  });
});

describe('cyclePreset', () => {
  it('advances forward and wraps', () => {
    const first = PHOTO_PRESETS[0].id;
    const last = PHOTO_PRESETS[PHOTO_PRESETS.length - 1].id;
    expect(cyclePreset(last, 1)).toBe(first);
  });
  it('advances backward and wraps', () => {
    const first = PHOTO_PRESETS[0].id;
    const last = PHOTO_PRESETS[PHOTO_PRESETS.length - 1].id;
    expect(cyclePreset(first, -1)).toBe(last);
  });
  it('treats an unknown current id as the first preset', () => {
    expect(cyclePreset('bogus', 1)).toBe(PHOTO_PRESETS[1].id);
  });
});

describe('buildPostcardStats', () => {
  it('renders the headline lines that have data', () => {
    const lines = buildPostcardStats({ online: 3, total: 5, agents: 2, peers: 1, level: 7, streak: 4 });
    expect(lines).toContain('3/5 SYSTEMS ONLINE');
    expect(lines).toContain('2 AGENTS ACTIVE');
    expect(lines).toContain('1 PEER LINKED');
    expect(lines).toContain('LEVEL 7');
    expect(lines).toContain('4-DAY STREAK');
  });
  it('omits zero/absent fields rather than printing 0', () => {
    const lines = buildPostcardStats({ online: 0, total: 2, agents: 0, peers: 0 });
    expect(lines).toEqual(['0/2 SYSTEMS ONLINE']);
  });
  it('singularizes agent/peer counts of one', () => {
    const lines = buildPostcardStats({ agents: 1, peers: 1, total: 1, online: 1 });
    expect(lines).toContain('1 AGENT ACTIVE');
    expect(lines).toContain('1 PEER LINKED');
  });
  it('handles an empty snapshot', () => {
    expect(buildPostcardStats()).toEqual([]);
    expect(buildPostcardStats({})).toEqual([]);
  });
  it('renders level 0', () => {
    expect(buildPostcardStats({ level: 0 })).toContain('LEVEL 0');
  });
});

describe('screenshotFilename', () => {
  it('formats a zero-padded timestamped name', () => {
    const d = new Date(2026, 5, 3, 9, 7, 5); // 2026-06-03 09:07:05 (month is 0-based)
    expect(screenshotFilename(d)).toBe('cybercity-20260603-090705.png');
  });
  it('is deterministic for the same date', () => {
    const d = new Date(2026, 0, 1, 0, 0, 0);
    expect(screenshotFilename(d)).toBe(screenshotFilename(d));
  });
});
