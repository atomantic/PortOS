/**
 * Writers Room — editable setting/world bible.
 *
 * Per-location bible keyed by screenplay slugline so SceneCard can match a
 * scene's slugline to its canonical setting and inject the description into
 * the image prompt. Per-work file at data/writers-room/works/<workId>/
 * settings.json. CRUD + file I/O + dedup rules all live in the shared
 * `createBibleStore` factory; this module supplies the per-kind config and
 * the name-OR-slugline identifier rule.
 */

import { createBibleStore, BIBLE_KIND, normalizeSlugline } from '../../lib/storyBible.js';
import { ServerError } from '../../lib/errorHandler.js';

// Re-export under the historical name for the existing test + import surface.
export { normalizeSlugline };

const dedupKey = (entry) => normalizeSlugline(entry?.slugline || entry?.name || '');

export const {
  list: listSettings,
  get: getSetting,
  create: createSetting,
  update: updateSetting,
  remove: deleteSetting,
  mergeExtracted: mergeExtractedSettings,
} = createBibleStore({
  kind: BIBLE_KIND.SETTING,
  idPrefix: 'wr-setting-',
  dedupKey,
  primaryFields: ['slugline', 'name'],
  editableFields: ['description', 'palette', 'era', 'weather', 'recurringDetails', 'notes'],
  requireOnCreate: (patch) => {
    const slugline = String(patch?.slugline || '').trim();
    const name = String(patch?.name || '').trim();
    return slugline || name ? null : 'Setting requires either a slugline or a name';
  },
  validateAfterUpdate: (next) => {
    // A PATCH that blanks the only non-empty identifier (e.g. name-only
    // setting receiving `{ name: '' }`) would leave the record unaddressable.
    if (!next.slugline && !next.name) {
      throw new ServerError('Setting needs slugline or name', { status: 400, code: 'VALIDATION_ERROR' });
    }
  },
  conflictMessage: ({ slugline, name }) => `A setting matching "${slugline || name}" already exists`,
  notFoundLabel: 'Setting',
  invalidIdMessage: 'Invalid setting id',
});
