/**
 * Writers Room — editable place/world bible.
 *
 * Per-location bible keyed by screenplay slugline so SceneCard can match a
 * scene's slugline to its canonical place and inject the description into
 * the image prompt. Per-work file at data/writers-room/works/<workId>/
 * places.json. CRUD + file I/O + dedup rules all live in the shared
 * `createBibleStore` factory; this module supplies the per-kind config and
 * the name-OR-slugline identifier rule.
 */

import { createBibleStore, BIBLE_KIND, normalizeSlugline } from '../../lib/storyBible.js';
import { ServerError } from '../../lib/errorHandler.js';

// Re-export under the historical name for the existing test + import surface.
export { normalizeSlugline };

const dedupKey = (entry) => normalizeSlugline(entry?.slugline || entry?.name || '');

export const {
  list: listPlaces,
  get: getPlace,
  create: createPlace,
  update: updatePlace,
  remove: deletePlace,
  mergeExtracted: mergeExtractedPlaces,
} = createBibleStore({
  kind: BIBLE_KIND.PLACE,
  idPrefix: 'wr-place-',
  dedupKey,
  primaryFields: ['slugline', 'name'],
  editableFields: ['description', 'palette', 'era', 'weather', 'recurringDetails', 'notes'],
  requireOnCreate: (patch) => {
    const slugline = String(patch?.slugline || '').trim();
    const name = String(patch?.name || '').trim();
    return slugline || name ? null : 'Place requires either a slugline or a name';
  },
  validateAfterUpdate: (next) => {
    // A PATCH that blanks the only non-empty identifier (e.g. name-only
    // place receiving `{ name: '' }`) would leave the record unaddressable.
    if (!next.slugline && !next.name) {
      throw new ServerError('Place needs slugline or name', { status: 400, code: 'VALIDATION_ERROR' });
    }
  },
  conflictMessage: ({ slugline, name }) => `A place matching "${slugline || name}" already exists`,
  notFoundLabel: 'Place',
  invalidIdMessage: 'Invalid place id',
});
