import { describe, expect, it } from 'vitest';
import {
  VERTICAL_FOOTER_Y,
  VERTICAL_FRAME_HEIGHT,
  VERTICAL_FRAME_THEMES,
  VERTICAL_FRAME_WIDTH,
  VERTICAL_SAFE_ZONES,
  activeLyricPair,
  defaultVerticalFrameOptions,
  escapeSvgText,
  verticalFrameDynamicSvg,
  verticalFrameStaticSvg,
  verticalSafeZonesSvg,
  wrapTextLines,
} from './musicVideoVerticalFrame.js';

describe('musicVideoVerticalFrame', () => {
  it('places every theme cinema window cleanly between TikTok top tabs and bottom caption area', () => {
    for (const theme of Object.values(VERTICAL_FRAME_THEMES)) {
      const { y, height, width } = theme.videoRect;
      expect(y).toBeGreaterThanOrEqual(VERTICAL_SAFE_ZONES.top.height);
      expect(y + height).toBeLessThanOrEqual(VERTICAL_FOOTER_Y);
      expect(width).toBeLessThanOrEqual(VERTICAL_FRAME_WIDTH);
    }
    expect(VERTICAL_FOOTER_Y).toBeLessThan(VERTICAL_SAFE_ZONES.bottom.y);
  });

  it('defaults footer lyrics off when the master already draws overlay lyrics and on when the master is lyric-free', () => {
    const cues = [{ text: 'First line', startSec: 1, endSec: 4 }];
    const withMasterLyrics = defaultVerticalFrameOptions({
      title: 'Example Song',
      artistName: 'Example Artist',
      lyricOverlayEnabled: true,
      lyricCues: cues,
    });
    expect(withMasterLyrics.showLyrics).toBe(false);

    const withoutMasterLyrics = defaultVerticalFrameOptions({
      title: 'Example Song',
      artistName: 'Example Artist',
      lyricOverlayEnabled: false,
      lyricCues: cues,
    });
    expect(withoutMasterLyrics.showLyrics).toBe(true);
    expect(withoutMasterLyrics.title).toBe('Example Song');
    expect(withoutMasterLyrics.subtitle).toContain('Example Artist');
  });

  it('escapes XML special characters and renders valid static, dynamic, and safe-zone SVGs', () => {
    expect(escapeSvgText('A & B <"C"> \'D\'')).toBe('A &amp; B &lt;&quot;C&quot;&gt; &apos;D&apos;');
    const staticSvg = verticalFrameStaticSvg({ theme: 'analog-16mm', title: 'Lights & Shadows', subtitle: 'Artist <1986>' });
    expect(staticSvg).toContain(`viewBox="0 0 ${VERTICAL_FRAME_WIDTH} ${VERTICAL_FRAME_HEIGHT}"`);
    expect(staticSvg).toContain('Lights &amp; Shadows');
    expect(staticSvg).toContain('ARTIST &lt;1986&gt;');

    const lines = [
      { text: 'First sung line', startSec: 2, endSec: 5 },
      { text: 'Second sung line', startSec: 6, endSec: 9 },
    ];
    expect(activeLyricPair(lines, 3)).toEqual({ current: lines[0], next: lines[1] });
    const dynamicSvg = verticalFrameDynamicSvg({
      theme: 'cinema-matte', timeSec: 3, startSec: 0, endSec: 10, lyrics: lines, beats: [1, 2, 3], showLyrics: true, showWaveform: true,
    });
    expect(dynamicSvg).toContain('First sung line');
    expect(dynamicSvg).toContain('Second sung line');
    expect(dynamicSvg).toContain('0:03');
    expect(dynamicSvg).toContain('0:10');

    expect(verticalSafeZonesSvg()).toContain('TIKTOK TOP TABS');
    expect(wrapTextLines('one two three four five six seven eight nine ten', 16, 2)).toHaveLength(2);
  });
});
