import { describe, it, expect } from 'vitest';
import { VIDEO_TILING_OPTIONS, normalizeVideoTiling } from './videoTilingOptions';
import { VIDEO_TILING_MODES } from '../../../server/lib/videoTiling.js';

describe('video tiling options', () => {
  // Guards the labels map: a mode added to the server list without a label
  // would otherwise render as an unlabeled <option> the server accepts.
  it('offers a labeled option for every server tiling mode', () => {
    expect(VIDEO_TILING_OPTIONS.map((o) => o.value)).toEqual([...VIDEO_TILING_MODES]);
    for (const option of VIDEO_TILING_OPTIONS) expect(option.label).toBeTruthy();
  });

  it('rejects values the server would not accept', () => {
    expect(normalizeVideoTiling('spatial')).toBe('spatial');
    expect(normalizeVideoTiling('diagonal')).toBeUndefined();
  });
});
