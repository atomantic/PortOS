// `mergeExpandIntoDraft(draft, result)` merges an LLM expand response into a Universe Builder draft,
// honoring locks and deduping canon, shared with the server merge.
//
// `mergeExpandIntoDraft(draft, result)` — pure merge of a Universe Builder draft with the LLM
// expand-API response (lock honoring, category/sheet merge with `kind` precedence, canon dedupe by
// name/slugline/alias). Also exports `mergeVariations`, `mergeCanonByName`, and
// `extractPreservedFromDraft` for callers that need the building blocks (per-category Generate,
// save-time refetch+merge).
//
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
