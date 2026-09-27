// Display labels for a music take's provenance — the `source` a render records
// when its audio did not come from a local engine (server/services/tracks/
// logic.js, #8967). A plain upload gets no label: the Upload icon already says
// it, and '' (unrecorded, pre-provenance) must not be guessed at.
const SOURCE_LABELS = Object.freeze({ suno: 'Suno', youtube: 'YouTube' });

/** Label for a render `source`, or '' when there is nothing worth naming. */
export const renderSourceLabel = (source) => SOURCE_LABELS[source] || '';

/** The provenance label of a track's ACTIVE take (the one its audio pointer plays). */
export const trackSourceLabel = (track) => {
  if (!track?.audioFilename) return '';
  const active = (track.renders || []).find((r) => r.audioFilename === track.audioFilename);
  return renderSourceLabel(active?.source);
};
