import { describe, it, expect, vi } from 'vitest';
import { up } from './026-music-video-lyric-marker-drift.js';
import { parseLyricSheet } from '../../lib/lyricMarkers.js';
import { lyricSectionSpans } from '../../lib/lyricSectionSpans.js';

// A sheet whose first parsed line (a title) was later deleted from the project.
const SHEET = 'Example Title\n[Intro]\n[Verse 1]\nLine one\nLine two\n[Verse 2]\nLine three\n[Chorus]\nLine four';
const timed = (texts) => texts.map((text, i) => ({ id: `c${i}`, text, startSec: 10 + i * 5, endSec: 14 + i * 5 }));

const makeClient = (rows, { tables = true } = {}) => {
  const updates = [];
  const query = vi.fn(async (sql, params) => {
    if (sql.includes('to_regclass')) return { rows: [{ projects: tables ? 'music_video_projects' : null, tracks: tables ? 'tracks' : null }] };
    if (sql.startsWith('SELECT')) return { rows };
    updates.push([params[0], JSON.parse(params[1])]);
    return { rows: [] };
  });
  return { client: { query }, updates };
};

// Uniquely catches projects whose markers drifted before #14471 staying a sung line late.
describe('db-migration 026 - lyric marker drift', () => {
  it('re-anchors drifted markers to the cue each header precedes and renames sheet-named sections', async () => {
    const lyricCues = timed(['Line one', 'Line two', 'Line 3 (edited)', 'Line four']);
    const audioAnalysis = { sections: [
      { startSec: 0, endSec: 10, label: 'Intro', labelSource: 'lyrics', analysisLabel: 'A' },
      { startSec: 10, endSec: 20, label: 'Verse 1', labelSource: 'lyrics', analysisLabel: 'B' },
      { startSec: 20, endSec: 25, label: 'Verse 1', labelSource: 'lyrics', analysisLabel: 'C' },
      { startSec: 25, endSec: 30, label: 'Verse 2', labelSource: 'lyrics', analysisLabel: 'D' },
    ] };
    const drifted = { id: 'p1', lyrics: SHEET, lyricCues, lyricMarkers: parseLyricSheet(SHEET).markers, audioAnalysis };
    const { client, updates } = makeClient([drifted]);
    await up(client);
    expect(updates).toHaveLength(1);
    const [id, patch] = updates[0];
    expect(id).toBe('p1');
    expect(patch.lyricMarkers.map((m) => [m.label, m.line])).toEqual([['Intro', 0], ['Verse 1', 0], ['Verse 2', 2], ['Chorus', 3]]);
    const verse1 = lyricSectionSpans(lyricCues, patch.lyricMarkers).find((s) => s.label === 'Verse 1');
    expect(verse1.startSec).toBe(10);
    expect(patch.audioAnalysis.sections.map((s) => s.label)).toEqual(['Intro', 'Verse 1', 'Verse 2', 'Chorus']);
  });

  it('leaves markers that were edited, already on their cue, or from another sheet', async () => {
    const markers = parseLyricSheet(SHEET).markers;
    const edited = markers.map((m) => (m.label === 'Chorus' ? { ...m, label: 'Hook' } : m));
    const intact = parseLyricSheet(SHEET).cues.map((c) => c.text);
    const { client, updates } = makeClient([
      { id: 'edited', lyrics: SHEET, lyricCues: timed(['Line one', 'Line two', 'Line three', 'Line four']), lyricMarkers: edited },
      { id: 'intact', lyrics: SHEET, lyricCues: timed(intact), lyricMarkers: markers },
      { id: 'unrelated', lyrics: SHEET, lyricCues: timed(['Other a', 'Other b', 'Other c', 'Line four']), lyricMarkers: markers },
    ]);
    await up(client);
    expect(updates).toEqual([]);
  });

  it('does nothing when the tables are absent', async () => {
    const { client, updates } = makeClient([], { tables: false });
    await up(client);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([]);
  });
});
