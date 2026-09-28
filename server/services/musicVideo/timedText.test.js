import { describe, it, expect } from 'vitest';
import { parseLyricCues } from './timedText.js';

// The lyric importer is a parser with a real input matrix (LRC, SRT, WebVTT,
// plain text) — each case pins a format rule the route test cannot see.
describe('parseLyricCues', () => {
  it('parses LRC: metadata skipped, repeated stamps expanded, gap markers end a line, offset applied', () => {
    const lrc = [
      '[ar:Example Artist]',
      '[ti:Example Song]',
      '[offset:+500]',
      '[00:01.50]First line',
      '[00:04.00][00:20.00]Chorus hook',
      '[00:06.25]',
      '[00:08.000]Word <00:08.50>timed <00:09.00>line',
    ].join('\n');
    const { format, cues } = parseLyricCues(lrc);
    expect(format).toBe('lrc');
    // +500ms offset shows lyrics half a second sooner.
    expect(cues).toEqual([
      { text: 'First line', startSec: 1, endSec: 3.5 },
      { text: 'Chorus hook', startSec: 3.5, endSec: 5.75 },
      { text: 'Word timed line', startSec: 7.5, endSec: 19.5 },
      { text: 'Chorus hook', startSec: 19.5, endSec: null },
    ]);
  });

  it('parses SRT blocks, joining multi-line text and stripping markup', () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:03,500\r\n<i>Hello</i>\r\nthere\r\n\r\n2\r\n00:01:02,250 --> 00:01:04,000\r\n{\\an8}Second\r\n';
    expect(parseLyricCues(srt)).toEqual({
      format: 'srt',
      cues: [
        { text: 'Hello there', startSec: 1, endSec: 3.5 },
        { text: 'Second', startSec: 62.25, endSec: 64 },
      ],
    });
  });

  it('parses WebVTT short timings and speaker tags', () => {
    const vtt = 'WEBVTT\n\n00:05.000 --> 00:07.500\n<v Singer>Line one\n\n00:08.000 --> 00:09.000\nLine two';
    expect(parseLyricCues(vtt).cues).toEqual([
      { text: 'Line one', startSec: 5, endSec: 7.5 },
      { text: 'Line two', startSec: 8, endSec: 9 },
    ]);
  });

  it('imports plain lyrics as untimed lines, dropping section headers and blanks', () => {
    expect(parseLyricCues('[Verse 1]\nWalking home\n\n  under neon  \n[Chorus]\n')).toEqual({
      format: 'text',
      cues: [
        { text: 'Walking home', startSec: null, endSec: null },
        { text: 'under neon', startSec: null, endSec: null },
      ],
    });
  });

  it('honors an explicit format over detection', () => {
    expect(parseLyricCues('[00:01.00]stamped', 'text').cues).toEqual([
      { text: '[00:01.00]stamped', startSec: null, endSec: null },
    ]);
  });
});
