// Reconciling the Eidoverse world-config drafts (recipe, asset overrides,
// label aliases) with a server response that lands while the user may have
// kept typing. Every function here is pure; the revision protocol that decides
// WHETHER a response may touch the draft at all lives in
// `hooks/useConfigDraftRevision.js`.
//
// The three-way merge always speaks in four roles:
//   current      what the user has in the draft right now
//   submitted    what the draft held when the request was sent
//   serverBefore the server's copy before the request
//   serverAfter  the server's copy in the response
// A key the user has since edited (`current !== submitted`) always wins; a key
// the user left alone follows the server change.
import {
  EIDOVERSE_SOURCE_KIND,
  eidoverseResetAssetSlotsForDistrict,
} from './eidoverseWorldReset.js';

// Returned out of the recursion to mean "the server removed this key"; never
// leaves this module.
const DELETE_DRAFT_VALUE = Symbol('delete-draft-value');
const isDraftRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const draftValuesEqual = (left, right) => Object.is(left, right)
  || JSON.stringify(left) === JSON.stringify(right);

function mergeServerChanges({ current, submitted, serverBefore, serverAfter }) {
  if (draftValuesEqual(serverBefore, serverAfter)) return current;
  if (isDraftRecord(current) && isDraftRecord(submitted)
    && isDraftRecord(serverBefore) && isDraftRecord(serverAfter)) {
    const merged = { ...current };
    const keys = new Set([...Object.keys(serverBefore), ...Object.keys(serverAfter)]);
    for (const key of keys) {
      if (draftValuesEqual(serverBefore[key], serverAfter[key])) continue;
      const value = mergeServerChanges({
        current: current[key],
        submitted: submitted[key],
        serverBefore: serverBefore[key],
        serverAfter: serverAfter[key],
      });
      if (value === DELETE_DRAFT_VALUE) delete merged[key];
      else merged[key] = value;
    }
    return merged;
  }
  if (!draftValuesEqual(current, submitted)) return current;
  return serverAfter === undefined ? DELETE_DRAFT_VALUE : structuredClone(serverAfter);
}

// Apply the server's change between `serverBefore` and `serverAfter` to
// `current`, leaving every key the user edited since `submitted` alone.
export function mergeDraft({ current, submitted, serverBefore, serverAfter }) {
  const merged = mergeServerChanges({ current, submitted, serverBefore, serverAfter });
  return merged === DELETE_DRAFT_VALUE ? {} : merged;
}

// Take the server's value for each listed key the user has not edited since it
// was submitted; keys absent from `serverAfter` are removed.
function takeServerKeys({ current = {}, submitted = {}, serverAfter = {}, keys }) {
  const merged = { ...current };
  for (const key of keys) {
    if (!draftValuesEqual(current?.[key], submitted?.[key])) continue;
    if (Object.hasOwn(serverAfter || {}, key)) merged[key] = structuredClone(serverAfter[key]);
    else delete merged[key];
  }
  return merged;
}

// A reset has no distinct "server before": the server's old value for
// everything it touched is, by construction, what was submitted. `mergeDraft`
// with `serverBefore = submitted` therefore applies the whole server result to
// every key the user has not edited since.
const mergeAfterFullReset = ({ current, submitted, serverAfter }) => mergeDraft({
  current, submitted, serverBefore: submitted, serverAfter,
});

const sourceKinds = (sources) => sources.map((source) => EIDOVERSE_SOURCE_KIND[source]).filter(Boolean);

function resetRecipe({ reset, current, submitted, serverAfter, sources }) {
  if (reset.scope === 'all') return mergeAfterFullReset({ current, submitted, serverAfter });
  if (reset.scope === 'assets') {
    const keys = new Set([
      ...Object.keys(current?.assets || {}),
      ...Object.keys(submitted?.assets || {}),
      ...Object.keys(serverAfter?.assets || {}),
    ]);
    return {
      ...current,
      assets: takeServerKeys({
        current: current?.assets, submitted: submitted?.assets, serverAfter: serverAfter?.assets, keys,
      }),
    };
  }
  const slots = eidoverseResetAssetSlotsForDistrict(reset.districtId, sources);
  const take = (field, keys) => takeServerKeys({
    current: current?.[field], submitted: submitted?.[field], serverAfter: serverAfter?.[field], keys,
  });
  return {
    ...current,
    includes: take('includes', sources),
    limits: take('limits', sources),
    scale: take('scale', sourceKinds(sources)),
    assets: take('assets', slots),
  };
}

function resetAssets({ reset, current, submitted, serverAfter, sources }) {
  if (reset.scope === 'all' || reset.scope === 'assets') {
    return mergeAfterFullReset({ current, submitted, serverAfter });
  }
  return takeServerKeys({
    current,
    submitted,
    serverAfter,
    keys: eidoverseResetAssetSlotsForDistrict(reset.districtId, sources),
  });
}

function resetAliases({ reset, current, submitted, serverAfter, sources }) {
  if (reset.scope === 'all') return mergeAfterFullReset({ current, submitted, serverAfter });
  if (reset.scope !== 'district') return current;
  const kinds = sourceKinds(sources);
  const keys = new Set([...Object.keys(current), ...Object.keys(submitted), ...Object.keys(serverAfter)]);
  return takeServerKeys({
    current,
    submitted,
    serverAfter,
    keys: [...keys].filter((key) => kinds.some((kind) => key.startsWith(`${kind}-`))),
  });
}

// The three drafts after a reset response lands on a draft the user has kept
// editing. `drafts` and `submitted` are `{ recipe, assets, aliases }`;
// `serverAfter` is that same shape read from the response (see
// `draftsFromWorld`). A response without a recipe leaves the recipe draft as is.
export function reconcileAfterReset({ reset, drafts, submitted, serverAfter }) {
  const sources = serverAfter.recipe?.districts
    ?.find(({ id }) => id === reset.districtId)?.sources || [];
  const scoped = (name) => ({
    reset, sources, current: drafts[name], submitted: submitted[name], serverAfter: serverAfter[name],
  });
  return {
    recipe: serverAfter.recipe ? resetRecipe(scoped('recipe')) : drafts.recipe,
    assets: resetAssets(scoped('assets')),
    aliases: resetAliases(scoped('aliases')),
  };
}

// The three drafts as the server holds them in a world response.
export const draftsFromWorld = (world) => ({
  recipe: world?.recipe || null,
  assets: world?.design?.userOverrides?.assets || {},
  aliases: world?.design?.labelAliases || {},
});

// May a server response replace the whole draft? Each request kind spells the
// same question with a different answer to "what if the draft was already dirty
// when the request left?" — every difference below is deliberate:
//
//   request       wasClean  isStillCurrent  forceReplace  why
//   projection    required  required        —             a dirty draft holds edits the projection
//                                                         never saw, so its recipe must not win
//   save          —         required        true          the server now holds exactly what was
//                                                         submitted, dirty or not
//   config action required  required        reset-all     a scoped action merges into a dirty draft
//                                                         instead; only reset-all discards the lot
//
// Takes a `useConfigDraftRevision().snapshot()`. `isStillCurrent()` turns false
// once the user edited while the request was in flight; the response is then
// merged (or ignored), never applied wholesale.
export const shouldReplaceDraft = ({ wasClean, isStillCurrent, forceReplace = false }) => (
  isStillCurrent() && (wasClean || forceReplace)
);
