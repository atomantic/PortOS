/** Picking a song out of Suno's picker rows (#10375). */

const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

const normalizeTitle = (value) => String(value || '').trim().replace(/\s+/g, ' ').replace(/(?:\.{3,}|…+)$/, '').trim().toLowerCase();

/** Picker row text starts with the title; metadata and the Use button follow it. */
const rowTitle = (text) => String(text || '').split(/\r?\n/)[0]
  .replace(/\s+\d+:\d{2}\s*$/, '').replace(/\bUse\b/g, '').trim();

/** Pick only by song id, or by an exact title with enough length evidence. */
export function pickSongRow(rows, { songId, durationSec, title }) {
  const byId = rows.findIndex((r) => songId && r.html.toLowerCase().includes(songId.toLowerCase()));
  if (byId >= 0) return byId;
  const exactTitle = rows.map((r, i) => [r, i]).filter(([r]) => normalizeTitle(rowTitle(r.text)) === normalizeTitle(title));
  if (!title || exactTitle.length === 0) return -1;
  if (!Number.isFinite(durationSec)) return exactTitle.length === 1 ? exactTitle[0][1] : -1;
  const clock = Number.isFinite(durationSec) ? fmtClock(Math.round(durationSec)) : null;
  const sameLength = clock ? exactTitle.filter(([r]) => r.text.includes(clock)) : [];
  if (sameLength.length === 1) return sameLength[0][1];
  return -1;
}
