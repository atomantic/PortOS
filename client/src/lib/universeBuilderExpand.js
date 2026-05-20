// Pure merge: take a Universe-Builder draft + an LLM expand-API result and
// produce the next draft, alongside metadata the I/O shell in
// `pages/UniverseBuilder.jsx#handleExpand` needs to drive toasts, auto-save,
// and the pending-canon-additions ledger.
//
// Splitting the merge out lets us unit-test the lock/precedence/dedupe rules
// without standing up the whole component, and shrinks `handleExpand` to its
// I/O concerns (validation, API call, setDraft, auto-save, toast).
//
// Inputs:
//   - draft:  the live builder draft (locked map, categories, sheets, canon, …)
//   - result: the LLM expand-API payload
//
// Output:
//   {
//     expandedDraft,        // the next draft to put into React state
//     addedCanonCount,      // NEW canon entries this expand contributed
//     pendingAdditions,     // { characters, places, objects } — net-new only
//     lockedKeys,           // string[] for the "preserved N locked fields" log line
//   }
//
// Lock semantics:
//   - For scalar fields in WORLD_LOCKABLE_FIELDS, locked → keep draft value;
//     unlocked → take the LLM value unless the LLM omitted (null/undefined).
//     A returned empty string IS applied — it's an intentional clear.
//   - Variations/sheets aren't lock-scoped, but per-item `locked: true` rows
//     are preserved and merged ahead of LLM output.
//   - Canon arrays merge by name/slugline/alias collision (existing wins).
// Imports the influence-merge from the targeted apiUniverseBuilder module
// (NOT the global `services/api` barrel) — the helpers are pure functions
// that happen to be exported alongside HTTP wrappers, and tracing through
// the barrel pulls all ~40 service modules into this lib's dep graph,
// defeating the point of a `lib/` vs `services/` boundary.
import { mergeInfluencesWithLocks } from '../services/apiUniverseBuilder';
import { BIBLE_LIMITS } from './bibleLimits';
import { normalizeSlugline } from './scenePrompt';

// Aliased so the call site in mergeCanonByName reads naturally. Sourced from
// the BIBLE_LIMITS mirror so the client doesn't optimistically display +
// count entries the server will silently truncate at sanitize time. Without
// this cap, the post-expand toast can claim "+12 canon entries" while the
// server-saved record only kept some of them.
const CANON_ENTRIES_CAP = BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX;

// Merge two variation arrays under a single category bucket. Locked rows
// (already filtered upstream into `existing`) come first; LLM-supplied
// freshrows go second; dedup is label-keyed (case-insensitive). Rows missing a
// `label` (malformed LLM payloads) are dropped from both sides — keeping them
// in `merged` while excluding from the dedup Set would let a fresh row with
// the same missing label silently duplicate.
export const mergeVariations = (existing, fresh) => {
  const merged = [];
  const seen = new Set();
  for (const v of [...(existing || []), ...(fresh || [])]) {
    const key = v?.label?.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(v);
  }
  return merged;
};

// Merge LLM-expanded canon entries into the draft's existing canon array.
// Existing entries always win on collision (lock or no — the user authored
// them; the LLM's repeat is a hallucination at this point). Mirrors the
// server-side dedupe in backfillCanonFromCategories + storyBible's
// MERGE_CONFIG (`storyBible.js` keyFields).
//
// Identity rules are kind-aware to match the server's MERGE_CONFIG:
//   - characters/objects → `normalizeBibleName` (trim + lowercase) on `name`
//                          AND `aliases[]`. Without aliases, an existing
//                          character "Ashley" with alias "Ash" would not
//                          collide with an LLM-returned "Ash", producing a
//                          duplicate canon entry the user has to merge by hand.
//   - places             → `normalizeSlugline` for BOTH `slugline` AND `name`
//                          (`storyBible.js` MERGE_CONFIG.place.keyFields).
//                          Without this, sluglines that differ only in dash
//                          style or punctuation ("INT. FOUNDRY CITY — DAY"
//                          vs "INT FOUNDRY CITY - DAY") would land as two
//                          separate place-canon entries, and `Foundry-City`
//                          vs `Foundry City` would duplicate by name even
//                          though every downstream lookup treats them as one.
export const mergeCanonByName = (existing, fresh, kind = 'character') => {
  // Empty/missing fresh — return `existing` unchanged (preserve reference so
  // a no-op expand doesn't trigger downstream identity-comparing effects).
  if (!fresh?.length) return existing || [];
  const isPlace = kind === 'place';
  const normName = isPlace
    ? (s) => (typeof s === 'string' ? normalizeSlugline(s) : '')
    : (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
  const normSlug = (s) => (typeof s === 'string' ? normalizeSlugline(s) : '');
  // Aliases participate in identity for character/object only — places use
  // slugline collision instead (the server's MERGE_CONFIG.place has no
  // aliases field).
  const aliasKeys = (entry) => {
    if (isPlace || !Array.isArray(entry?.aliases)) return [];
    return entry.aliases.map(normName).filter(Boolean);
  };
  const seen = new Set();
  for (const e of existing || []) {
    if (e?.name) seen.add(normName(e.name));
    if (e?.slugline) seen.add(normSlug(e.slugline));
    for (const k of aliasKeys(e)) seen.add(k);
  }
  const merged = [...(existing || [])];
  for (const e of fresh) {
    const nameKey = normName(e?.name);
    const sluglineKey = normSlug(e?.slugline);
    const aliasMatches = aliasKeys(e);
    const collides = (nameKey && seen.has(nameKey))
      || (sluglineKey && seen.has(sluglineKey))
      || aliasMatches.some((k) => seen.has(k));
    // On collision, still register every identity key the fresh entry
    // carried — so a *later* fresh entry with overlapping aliases/sluglines
    // is recognized as a within-batch duplicate too. Without this, fresh
    // entry A (collides on alias) gets skipped silently and fresh entry B
    // (uses A's primary name) slips in as a duplicate of the existing record.
    if (nameKey) seen.add(nameKey);
    if (sluglineKey) seen.add(sluglineKey);
    for (const k of aliasMatches) seen.add(k);
    if (collides) continue;
    if (merged.length >= CANON_ENTRIES_CAP) break;
    merged.push(e);
  }
  return merged;
};

// Compute the net-new canon entries between `existing` and `merged` (i.e.
// the rows the LLM contributed this round). Identity matches mergeCanonByName
// for character/object (name + aliases); places use slugline. Used by the
// pending-canon-additions ledger so the save path can re-merge only the net
// new entries against a freshly-refetched server canon (concurrent edit
// safety).
const computeCanonAdditions = (existing, merged, kind = 'character') => {
  const isPlace = kind === 'place';
  const normName = isPlace
    ? (s) => (typeof s === 'string' ? normalizeSlugline(s) : '')
    : (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
  const normSlug = (s) => (typeof s === 'string' ? normalizeSlugline(s) : '');
  const existingNames = new Set(
    (existing || []).map((e) => normName(e?.name)).filter(Boolean),
  );
  const existingSluglines = new Set(
    (existing || []).map((e) => normSlug(e?.slugline)).filter(Boolean),
  );
  return (merged || []).filter((e) => {
    const n = normName(e?.name);
    const s = normSlug(e?.slugline);
    return !(n && existingNames.has(n)) && !(s && existingSluglines.has(s));
  });
};

// Categories ship with a `kind` that pins the bucket to a canon trunk
// (`characters`/`places`/`objects`/`other`). Precedence:
//   - existing non-'other' draft kind (user curated it to a specific trunk)
//   - LLM-returned kind for this expand round (fresh classification)
//   - existing 'other' draft kind (Phase-B default for custom buckets)
//   - undefined (server's sanitizeCategory falls back to default-map / 'other')
// Allowing a fresh LLM kind to supersede an existing 'other' is intentional:
// pre-Phase-B "factions" buckets saved as `other` can be promoted to
// `characters` by a re-expand without requiring the user to manually change
// the trunk. User-curated non-`other` kinds (e.g. `places`) are preserved.
const resolveCategoryKind = (existingKind, freshKind) => {
  if (existingKind && existingKind !== 'other') return existingKind;
  return freshKind || existingKind;
};

const mergeCategoriesWithLocks = (draftCategories, llmCategories, preservedVariations) => {
  const mergedCategories = {};
  const allCatKeys = new Set([
    ...Object.keys(preservedVariations),
    ...Object.keys(llmCategories),
  ]);
  for (const cat of allCatKeys) {
    const locked = preservedVariations[cat] || [];
    const fresh = (llmCategories[cat]?.variations || []);
    const kind = resolveCategoryKind(draftCategories?.[cat]?.kind, llmCategories[cat]?.kind);
    mergedCategories[cat] = {
      ...(kind ? { kind } : {}),
      variations: mergeVariations(locked, fresh),
    };
  }
  return mergedCategories;
};

// Composite-sheet merge: preserved (locked) sheets keep their slot at the top
// unconditionally — the upstream invariant (only `locked: true` rows reach
// here) means a missing label is a bug elsewhere, not a row to silently drop.
// Their labels still seed the dedupe Set so a fresh LLM sheet with the same
// label is suppressed. Mirrors the pre-extraction handleExpand behavior
// byte-for-byte (a malformed preserved sheet with no `label` would have
// crashed the pre-refactor code on `.toLowerCase()` — keeping the same fault
// surface so this is a pure boundary move, not a behavior change).
const mergeCompositeSheets = (preservedSheets, llmSheets) => {
  const preserved = preservedSheets || [];
  const seen = new Set(preserved.map((s) => s.label.toLowerCase()));
  const out = [...preserved];
  for (const s of llmSheets || []) {
    const key = s?.label?.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
};

// Distinguish "LLM omitted the field" (null/undefined → keep draft) from "LLM
// returned empty string" (a legitimate "" — the user's `||` would silently
// restore a stale value they wanted gone).
const pickLockableScalar = (key, locks, draft, llmValue) => {
  if (locks[key]) return draft[key];
  return llmValue == null ? draft[key] : llmValue;
};

// Pull the per-item-locked variations + composite sheets out of a draft so
// they can both (1) ride along with the expand API request (server-side
// prompt-builder uses them to tell the LLM not to regenerate locked items)
// AND (2) seed mergeExpandIntoDraft's pre-merge state on the way back in.
// Single source so the two surfaces can't drift.
export const extractPreservedFromDraft = (draft) => {
  const preservedVariations = {};
  for (const [cat, bucket] of Object.entries(draft?.categories || {})) {
    const locked = (bucket?.variations || []).filter((v) => v?.locked === true);
    if (locked.length) preservedVariations[cat] = locked;
  }
  const preservedCompositeSheets = (draft?.compositeSheets || []).filter((s) => s?.locked === true);
  return { preservedVariations, preservedCompositeSheets };
};

export const mergeExpandIntoDraft = (draft, result, opts = {}) => {
  // Caller can pass a pre-baked ensureDraftCategories so the helper stays
  // free of WORLD_CATEGORIES knowledge (which lives in pages/UniverseBuilder.jsx).
  const ensureCategories = opts.ensureDraftCategories || ((c) => c || {});
  const locks = draft.locked || {};

  const { preservedVariations, preservedCompositeSheets } = extractPreservedFromDraft(draft);

  const refinedInfluences = mergeInfluencesWithLocks(locks, result.influences, draft.influences);
  const mergedCategories = mergeCategoriesWithLocks(
    draft.categories || {},
    result.categories || {},
    preservedVariations,
  );
  const mergedSheets = mergeCompositeSheets(preservedCompositeSheets, result.compositeSheets);

  // Merge LLM-emitted canon arrays into the draft's existing canon. Existing
  // entries always win on name/slugline collision so a re-expand can't
  // clobber hand-authored or series-extracted records. mergeCanonByName
  // short-circuits when `fresh` is empty so identity is preserved.
  const pickCanon = (key, kind) => mergeCanonByName(
    draft[key] || [],
    Array.isArray(result[key]) ? result[key] : [],
    kind,
  );
  const mergedCharacters = pickCanon('characters', 'character');
  const mergedPlaces = pickCanon('places', 'place');
  const mergedObjects = pickCanon('objects', 'object');

  // Count NEW canon entries this expand added (post-merge minus pre-existing).
  // Used by the toast so a re-expand on a populated universe doesn't claim
  // credit for entries the user already authored. Existing entries always win
  // on collision in mergeCanonByName, so the delta is always non-negative.
  const addedCanonCount =
    (mergedCharacters.length - (draft.characters?.length || 0))
    + (mergedPlaces.length - (draft.places?.length || 0))
    + (mergedObjects.length - (draft.objects?.length || 0));

  const expandedDraft = {
    ...draft,
    starterPrompt: pickLockableScalar('starterPrompt', locks, draft, result.starterPrompt),
    logline: pickLockableScalar('logline', locks, draft, result.logline),
    premise: pickLockableScalar('premise', locks, draft, result.premise),
    styleNotes: pickLockableScalar('styleNotes', locks, draft, result.styleNotes),
    influences: refinedInfluences,
    categories: ensureCategories(mergedCategories),
    compositeSheets: mergedSheets,
    characters: mergedCharacters,
    places: mergedPlaces,
    objects: mergedObjects,
    llm: result.llm || draft.llm,
  };

  // Net-new entries only — what the I/O shell stashes in the
  // pending-canon-additions ledger so a manual save (or refetch-merge) can
  // re-apply just the LLM contributions against the freshest server canon.
  const pendingAdditions = addedCanonCount > 0 ? {
    characters: computeCanonAdditions(draft.characters, mergedCharacters, 'character'),
    places: computeCanonAdditions(draft.places, mergedPlaces, 'place'),
    objects: computeCanonAdditions(draft.objects, mergedObjects, 'object'),
  } : { characters: [], places: [], objects: [] };

  const lockedKeys = Object.keys(locks).filter((k) => locks[k]);

  return {
    expandedDraft,
    addedCanonCount,
    pendingAdditions,
    lockedKeys,
    mergedCharacters,
    mergedPlaces,
    mergedObjects,
  };
};
