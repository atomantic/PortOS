import { describe, expect, it } from 'vitest';
import { lyricSectionSpans } from './lyricSectionSpans.js';
import { parseLyricSheet, realignLyricMarkersToSheet } from './lyricMarkers.js';

const linesOf = (markers) => markers.map((marker) => [marker.label, marker.line]);

// Uniquely catches a section header jumping onto the next anchor when two
// sheet lines were merged into one cue whose text matches neither (#14507).
describe('realignLyricMarkersToSheet', () => {
  it('keeps a header on the first cue of a merge and leaves the chorus span', () => {
    const sheet = '[Verse]\nalpha one\nalpha two\n[Chorus]\nbeta one\nbeta two\n[Bridge]\ngamma one\ngamma two\ndelta';
    const markers = parseLyricSheet(sheet).markers;
    const cues = ['alpha one', 'alpha two', 'merged beta lines', 'gamma one', 'gamma two', 'delta']
      .map((text, i) => ({ text, startSec: i * 10, endSec: i * 10 + 8 }));
    const repaired = realignLyricMarkersToSheet(cues, markers, sheet);
    expect(linesOf(repaired)).toEqual([['Verse', 0], ['Chorus', 2], ['Bridge', 3]]);
    expect(lyricSectionSpans(cues, repaired).map((span) => span.label)).toEqual(['Verse', 'Chorus', 'Bridge']);
  });

  it('pairs an equal gap in order when a line between anchors was edited in place', () => {
    // The leading sung line is gone from the cue list, so the edited line's
    // cue index differs from its sheet index and a missed pairing is visible.
    const sheet = 'dropped\n[Verse]\nalpha\n[Bridge]\nmiddle original\n[Chorus]\ngamma';
    const markers = parseLyricSheet(sheet).markers;
    const cues = ['alpha', 'middle edited', 'gamma'].map((text) => ({ text }));
    const repaired = realignLyricMarkersToSheet(cues, markers, sheet);
    expect(linesOf(repaired)).toEqual([['Verse', 0], ['Bridge', 1], ['Chorus', 2]]);
  });

  it('keeps a header on its exact anchor when a cue is inserted between anchors', () => {
    const sheet = '[Verse]\nalpha\n[Chorus]\ngamma';
    const markers = parseLyricSheet(sheet).markers;
    const cues = ['alpha', 'inserted', 'gamma'].map((text) => ({ text }));
    const repaired = realignLyricMarkersToSheet(cues, markers, sheet);
    expect(linesOf(repaired)).toEqual([['Verse', 0], ['Chorus', 2]]);
  });

  it('pairs a header with the first cue when one sheet line was split into two', () => {
    const sheet = '[Verse]\nalpha\n[Chorus]\nonly one\n[Bridge]\ngamma';
    const markers = parseLyricSheet(sheet).markers;
    const cues = ['alpha', 'split a', 'split b', 'gamma'].map((text) => ({ text }));
    const repaired = realignLyricMarkersToSheet(cues, markers, sheet);
    expect(linesOf(repaired)).toEqual([['Verse', 0], ['Chorus', 1], ['Bridge', 3]]);
  });
});

describe('parseLyricSheet singer voices', () => {
  const sung = (sheet) => parseLyricSheet(sheet).cues.map(({ text, voice }) => [text, voice]);

  it('lifts a `Name - ` or `Name: ` prefix into voice and keeps it out of the sung text', () => {
    expect(sung('A - hello\nSinger B: world\nAlice – again')).toEqual([['hello', 'A'], ['world', 'Singer B'], ['again', 'Alice']]);
    expect(parseLyricSheet('A - hello').markers).toEqual([]);
  });

  it('carries a whole-line [Name] tag to the following lines until the next tag', () => {
    const { cues, markers } = parseLyricSheet('[Singer A]\none\ntwo\n[Singer B]\nthree\n[Spoken, close]\nfour');
    expect(cues.map((c) => [c.text, c.voice])).toEqual([['one', 'Singer A'], ['two', 'Singer A'], ['three', 'Singer B'], ['four', 'Singer B']]);
    expect(markers).toEqual([{ type: 'direction', label: 'Spoken, close', kind: 'spoken', line: 3 }]);
  });

  it('reads a leading [Name] on a sung line as its singer', () => {
    expect(sung('[A] hello there')).toEqual([['hello there', 'A']]);
  });

  it('leaves ordinary lyrics, sections and directions alone', () => {
    expect(sung('oh - yeah\nWait, what: now\nI love you - really\nChorus: la la\n[Chorus]\nla')).toEqual([
      ['oh - yeah', undefined], ['Wait, what: now', undefined], ['I love you - really', undefined],
      ['Chorus: la la', undefined], ['la', undefined],
    ]);
  });
});
