/**
 * Repair Music Video lyric markers that drifted off their cue (#14380). Before
 * cue-list edits remapped `lyricMarkers` (#14471), removing or merging a line
 * left every later section header on its old index, so each section started a
 * sung line late. A project linked to a track still has the sheet its markers
 * were parsed from: where the stored markers match that sheet exactly, they move
 * to the cue each header precedes, and analysis sections already named after
 * the sheet are renamed from the repaired markers. Markers that were edited,
 * came from another sheet, or no longer need moving are left as they are.
 */
import { realignLyricMarkersToSheet, relabelAnalysisSections } from '../../lib/lyricMarkers.js';
import { toPgJson } from '../../lib/pgJson.js';

/** The data fields to merge into one project row, or null when it needs no repair. */
export function repairLyricMarkerDrift(project, sheetText) {
  const lyricMarkers = realignLyricMarkersToSheet(project?.lyricCues, project?.lyricMarkers, sheetText);
  if (!lyricMarkers) return null;
  const analysis = project.audioAnalysis;
  const relabeled = Array.isArray(analysis?.sections) && analysis.sections.some((s) => s?.labelSource === 'lyrics');
  return {
    lyricMarkers,
    ...(relabeled ? { audioAnalysis: relabelAnalysisSections(analysis, project.lyricCues, lyricMarkers) } : {}),
  };
}

export async function up(client) {
  const tables = await client.query("SELECT to_regclass('public.music_video_projects') AS projects, to_regclass('public.tracks') AS tracks");
  if (!tables.rows[0]?.projects || !tables.rows[0]?.tracks) return;
  const { rows } = await client.query(`SELECT p.id, p.data->'lyricCues' AS "lyricCues", p.data->'lyricMarkers' AS "lyricMarkers",
      p.data->'audioAnalysis' AS "audioAnalysis", t.data->>'lyrics' AS lyrics
    FROM music_video_projects p JOIN tracks t ON t.id = p.data->>'trackId'
    WHERE p.deleted IS NOT TRUE AND jsonb_typeof(p.data->'lyricMarkers') = 'array' AND jsonb_typeof(p.data->'lyricCues') = 'array'`);
  for (const { id, lyrics, ...project } of rows) {
    const patch = repairLyricMarkerDrift(project, lyrics);
    if (!patch) continue;
    await client.query('UPDATE music_video_projects SET data = data || $2::jsonb WHERE id = $1', [id, toPgJson(patch)]);
    console.log(`🎼 Re-anchored lyric markers on music video project ${id}`);
  }
}
