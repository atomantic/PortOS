// Collection record bounds and source vocabulary shared by storage and request validation.

import { MEDIA_COLLECTION_ITEMS_MAX } from './mediaItemKey.js';

export { REF_MAX_LENGTH } from './mediaItemKey.js';


export const NAME_MAX_LENGTH = 80;

export const DESCRIPTION_MAX_LENGTH = 500;

export const ITEMS_MAX = MEDIA_COLLECTION_ITEMS_MAX;

// Provenance stamp (#3311). `'auto'` = minted by a machine flow (Creative
// Director project, Writers Room work, universe/series render bucket);
// `'user'` = the person created it through the API. The grid uses it to sort
// auto-generated empties last and to badge the card.
//
// **LOCAL-ONLY.** `sanitizeRecordForWire` strips it, so provenance never
// crosses to a peer — see the rationale there (an emitted field would leave an
// upgraded peer permanently checksum-mismatched against an older one, and
// gating it behind a `schemaVersions` bump would pause all collection sync).
// Every install derives its own: the creators below stamp at mint time and
// `scripts/migrations/220-backfill-media-collection-source.js` classifies
// whatever was already on disk when the install upgraded.
//
// **Absent is a THIRD state, not a synonym for `'user'`.** A record written
// before this field shipped, or received from a peer after this install's
// migration ran, carries no stamp at all — the client falls back to its marker
// heuristic for those rather than mislabeling them user-made. So the sanitizer
// OMITS the key entirely rather than defaulting it (same posture as
// `sanitizeItem`'s optional `origin`).
export const COLLECTION_SOURCES = Object.freeze(['auto', 'user']);
