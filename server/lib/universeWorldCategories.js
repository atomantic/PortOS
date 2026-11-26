/** Built-in category buckets seeded for each new Universe Builder world. */

// Built-in default categories carry a known kind so they land under the right
// trunk in the UI without user intervention. Custom keys not in this map fall
// to DEFAULT_CATEGORY_KIND ('other') unless the input carries an explicit
// valid `kind`.
export const WORLD_CATEGORY_DEFAULT_KINDS = Object.freeze({
  landscapes: 'places',
  environments: 'places',
  structures: 'places',
  vehicles: 'objects',
});

export const WORLD_CATEGORIES = Object.freeze(Object.keys(WORLD_CATEGORY_DEFAULT_KINDS));
