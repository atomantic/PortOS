/** Picking a song out of Suno's picker rows (#10375). */

const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/**
 * Which picker row is the song: by id when a row carries it, else by the one
 * row with the song's length, else the only row. Pure; rows are `{ text, html }`.
 */
export function pickSongRow(rows, { songId, durationSec, title }) {
  const byId = rows.findIndex((r) => songId && r.html.toLowerCase().includes(songId.toLowerCase()));
  if (byId >= 0) return byId;
  const named = rows.map((r, i) => [r, i]).filter(([r]) => !title || r.text.toLowerCase().includes(title.toLowerCase()));
  const pool = named.length ? named : rows.map((r, i) => [r, i]);
  if (pool.length === 1) return pool[0][1];
  const clock = Number.isFinite(durationSec) ? fmtClock(Math.round(durationSec)) : null;
  const sameLength = clock ? pool.filter(([r]) => r.text.includes(clock)) : [];
  if (sameLength.length === 1) return sameLength[0][1];
  return -1;
}
