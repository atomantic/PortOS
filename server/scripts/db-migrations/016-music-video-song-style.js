/**
 * Give Music Video projects the song's own style. A project
 * linked to a track used to copy the track's Suno style prompt into
 * `concept.style`, the visual style suffixed onto every frame and shot
 * prompt, so music words ("gated snare", "-metal") reached the image model.
 * Snapshot the track's prompt into `concept.songStyle`, which the planners
 * translate into design, and clear `concept.style` only where it is still that
 * untouched copy. Idempotent: rows already carrying `songStyle` are skipped.
 */

/** The concept a legacy project gets, or null when nothing changes. */
export function migrateSongStyle(concept, trackPrompt) {
  const songStyle = typeof trackPrompt === 'string' ? trackPrompt.trim().slice(0, 2000) : '';
  if (!songStyle || (concept && Object.hasOwn(concept, 'songStyle'))) return null;
  const copied = typeof concept?.style === 'string' && concept.style.trim() === songStyle;
  return { ...concept, songStyle, ...(copied ? { style: '' } : {}) };
}

export async function up(client) {
  const tables = await client.query("SELECT to_regclass('public.music_video_projects') AS projects, to_regclass('public.tracks') AS tracks");
  if (!tables.rows[0]?.projects || !tables.rows[0]?.tracks) return;
  const { rows } = await client.query(`SELECT p.id, p.data->'concept' AS concept, t.data->>'prompt' AS prompt
    FROM music_video_projects p JOIN tracks t ON t.id = p.data->>'trackId'
    WHERE NOT COALESCE(p.data->'concept' ? 'songStyle', FALSE)`);
  for (const { id, concept, prompt } of rows) {
    const next = migrateSongStyle(concept, prompt);
    if (!next) continue;
    await client.query(`UPDATE music_video_projects SET data = jsonb_set(data, '{concept}', $2::jsonb)
      WHERE id = $1 AND NOT COALESCE(data->'concept' ? 'songStyle', FALSE)`, [id, JSON.stringify(next)]);
  }
}
