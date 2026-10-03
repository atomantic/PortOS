// Re-export of the pure Universe-Builder expand merge in
// `server/lib/universeExpandMerge.js` — the one definition of the lock /
// preserve / dedupe rules, shared with the Story Builder's server path so the
// two cannot drift. Only the influence merge is client-specific: it comes from
// the targeted apiUniverseBuilder module (NOT the global `services/api` barrel,
// which would pull ~40 service modules into this lib's dep graph).
import { mergeInfluencesWithLocks } from '../services/apiUniverseBuilder';
import { mergeExpandIntoDraft as sharedMergeExpandIntoDraft } from '../../../server/lib/universeExpandMerge.js';

export {
  mergeVariations,
  mergeCanonByName,
  extractPreservedFromDraft,
} from '../../../server/lib/universeExpandMerge.js';

export const mergeExpandIntoDraft = (draft, result, opts = {}) => sharedMergeExpandIntoDraft(
  draft,
  result,
  { mergeInfluences: mergeInfluencesWithLocks, ...opts },
);
