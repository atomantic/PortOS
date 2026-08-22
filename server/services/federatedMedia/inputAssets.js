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
} from '../../lib/federatedMediaWire.js';

// Deliberately NOT imported from remoteExecutor.js. That module statically
// pulls the peer registry and consumer, and this one is reached from the image
// and video generate routes — the same edge remoteSubmission.js lazily imports
// around so a partially-mocked route suite can still load. One three-line
// helper is cheaper than re-introducing that graph.
const inputAssetError = (message, code) => Object.assign(new Error(message), { code });

// Only `referenceImages` is a list on the wire; every other role is one slot.
const MULTI_ROLES = new Set(['referenceImages']);

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
  if (!assets.length) {
    return limits?.required
      ? `${capability?.modelName || 'The selected model'} renders only from a source image — add one, or pick a text-to-image model.`
      : null;
  }
  if (!limits) {
    return `${capability?.modelName || 'The selected model'} on this peer does not accept source or reference images. Render locally, or pick a peer model that does.`;
  }
  const roles = [...new Set(assets.map((asset) => asset.role))];
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
 * @param {object} request - validated wire submission, without asset refs
 * @param {Array<{role: string, path: string}>} assets
 * @param {(path: string) => Promise<string>} stageAsset - uploads and returns an assetId
 * @returns {Promise<object>} the request with `{ assetId }` refs filled in
 */
export async function applyRemoteInputAssets(request, assets, stageAsset) {
  if (!Array.isArray(assets) || assets.length === 0) return request;
  const next = { ...request };
  for (const { role, path } of assets) {
    const assetId = await stageAsset(path);
    if (MULTI_ROLES.has(role)) {
      next[role] = [...(next[role] || []), { assetId }];
    } else if (next[role]) {
      // Two assets claiming one slot means the caller built the list wrong.
      // Overwriting would render from whichever happened to be last, so refuse.
      throw inputAssetError(`Remote render supplied more than one ${role}`, 'MEDIA_PROVIDER_INPUT_UNSUPPORTED');
    } else {
      next[role] = { assetId };
    }
  }
  return next;
}

/**
 * Collect the conditioning a local render would have used into the marker
 * shape, dropping empty slots. Returns `[]` when there is none, so a caller can
 * treat "no conditioning" and "conditioning this build does not know about"
 * identically.
 *
 * @param {object} slots - `{ [role]: string | string[] | null | undefined }`
 */
export function collectRemoteInputAssets(slots) {
  const assets = [];
  for (const role of FEDERATED_MEDIA_INPUT_ROLES) {
    const value = slots?.[role];
    if (!value) continue;
    for (const path of Array.isArray(value) ? value : [value]) {
      if (typeof path === 'string' && path.trim()) assets.push({ role, path: path.trim() });
    }
  }
  return assets;
}
