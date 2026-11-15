// Display labels for a music take's provenance — the `source` a render records when its audio did not
// come from a local engine (server/services/tracks/ logic.js, #8967).
//
// `renderSourceLabel(source)` / `trackSourceLabel(track)` — the display label (`Suno`, `YouTube`) for
// where a music take's audio came from, read off a render's `source` (#8967) or a track's ACTIVE
// render. Plain uploads and unrecorded (pre-provenance) takes return `''` — never guessed.
// `sunoRenderHref(render)` is the Suno song page when that take recorded a `sunoSongId`, else `''`.
// Shared by the Tracks render cards and the Music Video track row.
//
// A plain upload gets no label: the Upload icon already says it, and '' (unrecorded, pre-provenance)
// must not be guessed at.
import { sunoSongUrl } from '../../../server/lib/sunoSong.js';

const SOURCE_LABELS = Object.freeze({ suno: 'Suno', youtube: 'YouTube' });

/** Label for a render `source`, or '' when there is nothing worth naming. */
export const renderSourceLabel = (source) => SOURCE_LABELS[source] || '';

/** The provenance label of a track's ACTIVE take (the one its audio pointer plays). */
export const trackSourceLabel = (track) => {
  if (!track?.audioFilename) return '';
  const active = (track.renders || []).find((r) => r.audioFilename === track.audioFilename);
  return renderSourceLabel(active?.source);
};

/** The Suno song page for a take that recorded its song id, or '' when there is nothing to link. */
export function sunoRenderHref(render) {
  if (render?.source !== 'suno' || typeof render.sunoSongId !== 'string' || !render.sunoSongId) return '';
  return sunoSongUrl(render.sunoSongId);
}
