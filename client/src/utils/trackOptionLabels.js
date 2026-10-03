import { formatDateShort, formatDurationSec } from './formatters.js';

/**
 * Shared library-track option text, keyed by record ID. Build against the full
 * library before filtering eligibility so labels agree across selectors.
 */
export function trackOptionLabels(tracks = []) {
  const groups = new Map();
  for (const track of tracks) {
    const duration = formatDurationSec(track.durationSec);
    const created = formatDateShort(track.createdAt);
    const label = [
      track.title?.trim() || 'Untitled track',
      track.artist?.trim(),
      duration === '—' ? 'Duration unknown' : duration,
      created === '—' ? 'Created unknown' : `Created ${created}`,
      !track.audioFilename && 'No audio',
    ].filter(Boolean).join(' · ');
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(track.id);
  }

  const labels = new Map();
  for (const [label, ids] of groups) {
    // Extend the shared suffix length until every colliding ID is distinct.
    // IDs, rather than list positions, keep the result stable after reordering.
    let length = 6;
    const maxLength = Math.max(...ids.map((id) => id.length));
    while (length < maxLength && new Set(ids.map((id) => id.slice(-length))).size < ids.length) length++;
    for (const id of ids) labels.set(id, ids.length > 1 ? `${label} [${id.slice(-length)}]` : label);
  }
  return labels;
}
