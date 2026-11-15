import { describe, expect, it } from 'vitest';
import { _parseSceneCutTimes } from './videoSceneCuts.js';

describe('_parseSceneCutTimes', () => {
  it('reads showinfo stamps as ascending seconds, merging a flash into one cut', () => {
    const log = [
      '[Parsed_showinfo_2 @ 0x1] n:   0 pts:  53248 pts_time:2.208   duration: 512',
      '[Parsed_showinfo_2 @ 0x1] n:   1 pts:  53760 pts_time:2.25    duration: 512',
      '[Parsed_showinfo_2 @ 0x1] n:   2 pts:  98304 pts_time:4.0     duration: 512',
      'frame=  145 fps=0.0 q=-0.0 Lsize=N/A time=00:00:06.04',
    ].join('\n');
    expect(_parseSceneCutTimes(log)).toEqual([2.21, 4]);
  });

  it('drops a zero stamp and caps the count', () => {
    const log = Array.from({ length: 5 }, (_, i) => `pts_time:${i}`).join('\n');
    expect(_parseSceneCutTimes(log, { maxCuts: 2 })).toEqual([1, 2]);
    expect(_parseSceneCutTimes('')).toEqual([]);
  });
});
