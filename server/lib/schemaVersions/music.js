/**
 * Music wire versions: artists, albums, tracks with their render history, and music video projects.
 *
 * One domain slice of `PORTOS_SCHEMA_VERSIONS` (`server/lib/schemaVersions.js` composes every slice in the shipped key order).
 * Bump a value here, never in the composer, so a routine bump runs scoped CI instead of the full matrix; a NEW category also needs its composer entry.
 * The live-push music video sender floor (`RECORD_SCHEMA_MIN_SENDER_VERSIONS.musicVideoProjects`) stays in the composer and does not move with a bump.
 */

export const MUSIC_SCHEMA_VERSIONS = Object.freeze({
  // Artists; v2 = press and submission profile.
  artists: 2,
  // Albums.
  albums: 1,
  // Tracks and render history; v13 = `sunoSongId` on takes.
  tracks: 13,
  // Music video project body (LWW whole); v64 = last MIDI transcription failure.
  musicVideoProjects: 64,
});
