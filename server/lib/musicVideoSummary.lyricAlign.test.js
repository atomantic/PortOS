import { describe, expect, it } from 'vitest';
import { summarizeMusicVideoProject } from './musicVideoSummary.js';

const words = [{ text: 'hi', startSec: 1, endSec: 2, conf: 'matched' }];
const base = { id: 'p1', name: 'x', lyricCues: [{ id: 'c', text: 'hi', words }] };

describe('summary lyricAlignStale (#10610)', () => {
  it('is stale only when a stem arrived after a master-only alignment', () => {
    const stale = (extra) => summarizeMusicVideoProject({ ...base, ...extra }, {}).lyricAlignStale;
    expect(stale({ vocalStemFilename: 's.wav', lyricAlignSource: 'master' })).toBe(true);
    expect(stale({ vocalStemFilename: 's.wav', lyricAlignSource: 'vocal-stem' })).toBe(false);
    expect(stale({ lyricAlignSource: 'master' })).toBe(false);
  });
});
