/**
 * Consumer-side conditioning-asset plumbing shared by the image and video
 * remote adapters (ADR
 * docs/decisions/2026-08-22-federated-media-input-assets.md rule 1).
 *
 * The central decision here is **what the queue marker persists**: LOCAL file
 * paths, not the provider-issued asset ids.
 *
 * An asset id is the provider's, and it expires — the staging area is TTL-swept
 * because it holds another machine's bytes. A marker that stored ids would
 * therefore reconcile after a restart into a `410 MEDIA_PROVIDER_ASSET_NOT_FOUND`
 * with nothing left on this side to recover from. Storing the source paths means
 * a replay re-stages the same bytes; the upload is content-addressed, so that
 * costs one transfer and yields the same id, never a duplicate render.
 *
 * The paths themselves never cross the wire — they are resolved to ids
 * immediately before submission and are meaningless to the peer, which is the
 * same reason the audio marker keeps its profile rather than a rendered prompt.
 */

import { z } from 'zod';
import {
  FEDERATED_MEDIA_ASSET_MAX_COUNT,
  FEDERATED_MEDIA_INPUT_ROLES,
  isMultiInputRole,
} from '../../lib/federatedMediaWire.js';

// Deliberately NOT imported from remoteExecutor.js. That module statically
// pulls the peer registry and consumer, and this one is reached from the image
// and video generate routes — the same edge remoteSubmission.js lazily imports
// around so a partially-mocked route suite can still load. One three-line
// helper is cheaper than re-introducing that graph.
const inputAssetError = (message, code) => Object.assign(new Error(message), { code });

// Which local param each role reads, per kind. One table, because three call
// sites were hand-writing this map and two of them had already drifted: the
// unattended router accepted `sourceImagePath` OR `sourceImageFile` (a planner
// writes either) while the interactive video route read only `sourceImageFile`.
// A divergence like that is invisible from either file.
const ROLE_PARAMS = Object.freeze({
  image: Object.freeze({
    initImage: ['initImagePath'],
    referenceImages: ['referenceImagePaths'],
  }),
  video: Object.freeze({
    sourceImage: ['sourceImagePath', 'sourceImageFile'],
    lastImage: ['lastImagePath', 'lastImageFile'],
  }),
});

// Pairings a single render cannot be missing half of. Enforced HERE rather than
// per-lane because all four lanes (Image Gen, Video Gen, the unattended router,
// and any future one) funnel through `inputAssetRejection` — the video route had
// its own copy and the unattended router had none, which is exactly the
// nobody-is-watching case where a silently-wrong render costs most.
const REQUIRED_PAIRS = Object.freeze([
  { role: 'lastImage', needs: 'sourceImage', why: 'a first-last-frame render needs both ends' },
]);

export const remoteInputAssetSchema = z.object({
  role: z.enum(FEDERATED_MEDIA_INPUT_ROLES),
  path: z.string().trim().min(1).max(4096),
}).strict();

export const remoteInputAssetsSchema = z.array(remoteInputAssetSchema)
  .max(FEDERATED_MEDIA_ASSET_MAX_COUNT);

/**
 * Would this capability accept these conditioning assets? Consumer-side
 * preflight only — the provider re-checks everything at admission — but it
 * turns "the peer 400s after you commit" into "Generate tells you why".
 *
 * Absent `inputAssets` reads as UNSUPPORTED, never as unrestricted: a provider
 * predating this ADR omits the block and rejects the fields.
 *
 * @returns {string|null} a human-facing reason, or null when acceptable
 */
export function inputAssetRejection(capability, assets = []) {
  const limits = capability?.inputAssets;
  const model = capability?.modelName || 'The selected model';
  // The remedy names the kind the caller is actually rendering. Saying
  // "pick a text-to-image model" to someone blocked on a VIDEO render is worse
  // than saying nothing — it points at a control that is not on their screen.
  const textToKind = `text-to-${capability?.kind === 'video' ? 'video' : 'image'}`;
  if (!assets.length) {
    return limits?.required
      ? `${model} renders only from a source image — add one, or pick a ${textToKind} model.`
      : null;
  }
  if (!limits) {
    return `${model} on this peer does not accept source or reference images. Render locally, or pick a peer model that does.`;
  }
  const roles = [...new Set(assets.map((asset) => asset.role))];
  for (const pair of REQUIRED_PAIRS) {
    if (roles.includes(pair.role) && !roles.includes(pair.needs)) {
      return `This render supplies a ${pair.role} with no ${pair.needs} — ${pair.why}. Add one, or render on this instance.`;
    }
  }
  const unsupported = roles.filter((role) => !limits.roles.includes(role));
  if (unsupported.length) {
    return `The selected peer model does not accept ${unsupported.join(' or ')}. Render locally, or clear that input.`;
  }
  if (assets.length > limits.maxCount) {
    return `The selected peer model accepts at most ${limits.maxCount} conditioning image(s); this render has ${assets.length}.`;
  }
  return null;
}

/**
 * Stage each local asset on the provider and fold the returned ids into the
 * wire request.
 *
 * The assembled body is re-validated against the kind's REFINED schema before it
 * is returned. The marker stores the base (un-refined) shape because at rest the
 * asset refs are legitimately absent — but the body that leaves this machine is
 * complete, so its cross-field rules ("a strength needs an image", "an end frame
 * needs a start frame") have something to check and must run here. Skipping that
 * left them enforced only on the provider, which cannot tell the user which
 * local input to clear.
 *
 * @param {object} request - validated wire submission, without asset refs
 * @param {Array<{role: string, path: string}>} assets
 * @param {(path: string) => Promise<string>} stageAsset - uploads and returns an assetId
 * @param {import('zod').ZodTypeAny} [schema] - refined schema for the finished body
 * @returns {Promise<object>} the request with `{ assetId }` refs filled in
 */
export async function applyRemoteInputAssets(request, assets, stageAsset, schema) {
  if (!Array.isArray(assets) || assets.length === 0) return request;
  // Staged CONCURRENTLY: up to 8 independent multi-megabyte uploads, each one
  // otherwise waiting out the last inside the run's timeout envelope. The
  // results are folded in afterwards, in the original order, because reference
  // order is conditioning order.
  const assetIds = await Promise.all(assets.map(({ path }) => stageAsset(path)));
  const next = { ...request };
  for (const [index, { role }] of assets.entries()) {
    const assetId = assetIds[index];
    if (isMultiInputRole(role)) {
      next[role] = [...(next[role] || []), { assetId }];
    } else if (next[role]) {
      // Two assets claiming one slot means the caller built the list wrong.
      // Overwriting would render from whichever happened to be last, so refuse.
      throw inputAssetError(`Remote render supplied more than one ${role}`, 'MEDIA_PROVIDER_INPUT_UNSUPPORTED');
    } else {
      next[role] = { assetId };
    }
  }
  const parsed = schema?.safeParse(next);
  if (parsed && !parsed.success) {
    throw inputAssetError(
      `Assembled federated request is invalid: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      'MEDIA_PROVIDER_INPUT_UNSUPPORTED',
    );
  }
  return parsed ? parsed.data : next;
}

/**
 * Collect the conditioning a local render would have used into the marker
 * shape, reading each role off the LOCAL params by the one shared table above.
 * Returns `[]` when there is none, so a caller can treat "no conditioning" and
 * "conditioning this build does not know about" identically.
 *
 * Takes the raw params rather than a hand-built `{ role: path }` object on
 * purpose: three call sites used to build that object themselves and two of them
 * disagreed about which param a video start frame lives in.
 *
 * @param {'image'|'video'} kind
 * @param {object} params - local job params
 */
export function collectRemoteInputAssets(kind, params) {
  const roleParams = ROLE_PARAMS[kind];
  if (!roleParams) return [];
  const assets = [];
  for (const role of FEDERATED_MEDIA_INPUT_ROLES) {
    // First param that carries a value wins; the aliases are spellings of one
    // slot, never two separate inputs.
    const value = roleParams[role]?.map((key) => params?.[key]).find(Boolean);
    if (!value) continue;
    for (const path of Array.isArray(value) ? value : [value]) {
      if (typeof path === 'string' && path.trim()) assets.push({ role, path: path.trim() });
    }
  }
  return assets;
}
