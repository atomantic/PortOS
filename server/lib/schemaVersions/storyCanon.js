/**
 * Story canon and writing wire versions: universes, pipeline series and issues, authors, the ingredient catalog, Story Builder and Writers Room.
 *
 * One domain slice of `PORTOS_SCHEMA_VERSIONS` (`server/lib/schemaVersions.js` composes every slice in the shipped key order).
 * Bump a value here, never in the composer, so a routine bump runs scoped CI instead of the full matrix; a NEW category also needs its composer entry.
 */

export const STORY_CANON_SCHEMA_VERSIONS = Object.freeze({
  // Universe canon layout (characters, places, objects, styles, mood-board link); v22 = place `world` map.
  universes: 22,
  // Pipeline issues; v7 omits stage run history, which older receivers would erase on overwrite.
  pipelineIssues: 7,
  // Pipeline series record (arc, styleGuide, characterArcs, exportSettings); v14 = author-owned `arc.seriesDesign`.
  pipelineSeries: 14,
  // Author personas (per-record push).
  authors: 1,
  // Story Builder sessions, synced only when `sync: true`.
  storyBuilder: 1,
  // Writers Room works (manifest, draft-version metadata, bible siblings); draft prose rides its own body manifest.
  writersRoomWorks: 1,
  // Writers Room folders (body-less, tombstoned).
  writersRoomFolders: 1,
  // Writers Room exercises (body-less).
  writersRoomExercises: 1,
  // Creative ingredient catalog (ingredients, scraps, relations, tags, media, user types); live rows need an exact match (`RECORD_SCHEMA_MIN_SENDER_VERSIONS`), tombstones do not; v17 = place/object `size`.
  catalog: 17,
});
