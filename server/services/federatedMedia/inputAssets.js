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
 *
 * That resolution — the upload itself — lives here too, not in the shared
 * remote-media executor. Staging must still run inside a run's retry/cancel/
 * timeout envelope, so the executor lends the ONE thing only it can provide (an
 * authenticated, in-envelope `requestJson`) and everything image-shaped stays on
 * this side of the seam: the size cap, the MIME allowlist, the digest check.
 */

import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import {
  FEDERATED_MEDIA_ASSET_MAX_BYTES,
  FEDERATED_MEDIA_ASSET_MAX_COUNT,
  FEDERATED_MEDIA_ASSET_MIME_TYPES,
  FEDERATED_MEDIA_INPUT_ROLES,
  federatedMediaAssetId,
  federatedMediaAssetSchema,
  federatedMediaDeniesFeature,
  federatedMediaSupports,
  isMultiInputRole,
} from '../../lib/federatedMediaWire.js';
import { detectImageFormat, resolveImageInputPath, sha256File } from '../../lib/fileUtils.js';

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
 * Absent support reads as UNSUPPORTED, never as unrestricted: a provider
 * predating this ADR omits the block and rejects the fields (see
 * `federatedMediaSupports`).
 *
 * The two ways that can fail get separate remedies, because the block's absence
 * conflated them: a peer whose BUILD predates conditioning needs updating,
 * while a peer that speaks it and simply allowlisted a text-only model needs a
 * different model picked. A status-root `features` list (#4826) is what tells
 * them apart; a peer that published no list is undecidable and keeps the older,
 * merged message.
 *
 * @param {object|null} capability - the resolved provider capability
 * @param {Array<{role: string}>} [assets]
 * @param {object|null} [status] - the provider status the capability came from
 * @returns {string|null} a human-facing reason, or null when acceptable
 */
export function inputAssetRejection(capability, assets = [], status = null) {
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
  // Both halves, in the same order the client's `peerModelAcceptsInput` checks
  // them: the BUILD has to carry conditioning at all, and THIS MODEL has to
  // advertise a block. Gating on the block alone would admit a job a peer that
  // published a vocabulary without `inputAssets` then answers with a 400 —
  // and would leave this end more permissive than the UI that fronts it.
  if (!limits || !federatedMediaSupports(status, 'inputAssets', capability)) {
    // Which remedy is a MESSAGE decision, not a gating one, so it asks the
    // shared policy rather than restating when a missing signal indicts the
    // peer's build. For conditioning it does not: mid-overlap a healthy peer
    // may speak it and simply have only text-only models allowlisted.
    return federatedMediaDeniesFeature(status, 'inputAssets', capability)
      ? 'The selected peer runs a PortOS build that cannot carry conditioning images. Update the peer, or render locally.'
      : `${model} on this peer does not accept source or reference images. Render locally, or pick a peer model that does.`;
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
 * Build this run's conditioning-image stager: local path -> provider asset id
 * (ADR docs/decisions/2026-08-22-federated-media-input-assets.md rule 1).
 *
 * The executor lends exactly one capability — `requestJson`, its own
 * authenticated request helper already bound to the run, so peer resolution,
 * auth, cancellation and the timeout envelope all stay intact and the upload
 * happens INSIDE the run's retry/cancel envelope rather than beside it.
 * Everything image-shaped — the approved-roots re-anchor, the size cap, the MIME
 * allowlist, the digest verification — lives here, where the next non-image
 * sub-request will not inherit it.
 *
 * The `localPath` memo is per run and deliberately not persisted: an id names a
 * slot in the provider's TTL-swept staging area, so caching it across a restart
 * would produce a confident reference to bytes that are gone. Within one run it
 * collapses a repeated path — two identical reference images, or a source frame
 * reused as the last frame — into a single upload.
 *
 * @param {object} ctx
 * @param {(path: string, options?: object, requestOptions?: object) => Promise<any>} ctx.requestJson
 * @param {(message: string) => void} ctx.emitStatus
 * @returns {(localPath: string) => Promise<string>}
 */
function createInputAssetStager({ requestJson, emitStatus }) {
  const uploads = new Map();

  async function uploadInputAsset(localPath) {
    // Re-anchored against the approved image roots on every attempt, exactly as
    // the LOCAL runner re-validates the same input. The marker is persisted,
    // user-editable queue state, so the path that becomes an outbound upload has
    // to be one this machine would have rendered from — a bare basename resolves,
    // and anything outside those roots resolves to null and is refused.
    const resolved = resolveImageInputPath(localPath);
    const info = resolved ? await stat(resolved).catch(() => null) : null;
    if (!info?.isFile()) {
      throw inputAssetError(
        'A conditioning image for this render is missing or unreadable',
        'MEDIA_PROVIDER_INPUT_UNREADABLE',
      );
    }
    if (info.size > FEDERATED_MEDIA_ASSET_MAX_BYTES) {
      throw inputAssetError(
        'A conditioning image for this render is too large to send to a peer',
        'MEDIA_PROVIDER_ASSET_TOO_LARGE',
      );
    }
    // Streamed above 512 KB, so the ASK-FIRST path below never buffers a
    // multi-megabyte image just to learn it is already staged.
    const digest = await sha256File(resolved);
    // Lazily imported, not statically: the image/video generate routes reach
    // this module, and a static edge to the peer registry would drag it (and
    // its settings/DB dependencies) into every route suite's module graph.
    // Same reason remoteSubmission.js defers the same import.
    const { getInstanceId } = await import('../instanceIdentity.js');
    const assetId = federatedMediaAssetId(await getInstanceId(), digest);

    // Ask before sending. The id is fully derivable from our own instance id and
    // the content digest — that is what content addressing buys — so a job
    // replayed after a restart, or a second render from the same init image,
    // costs one small GET instead of re-sending up to 32 MiB. A 404 is the
    // normal miss (never uploaded, or swept), not an error.
    const staged = await requestJson(`/api/federation/media/v1/assets/${assetId}`)
      .then((body) => federatedMediaAssetSchema.safeParse(body), () => null);
    if (staged?.success && staged.data.sha256 === digest) return staged.data.assetId;

    const body = await readFile(resolved).catch(() => null);
    if (!body) {
      throw inputAssetError(
        'A conditioning image for this render is missing or unreadable',
        'MEDIA_PROVIDER_INPUT_UNREADABLE',
      );
    }
    const detected = detectImageFormat(body);
    if (!detected || !FEDERATED_MEDIA_ASSET_MIME_TYPES.includes(detected.mime)) {
      throw inputAssetError(
        'A conditioning image for this render is not a format peers accept',
        'MEDIA_PROVIDER_ASSET_TYPE_UNSUPPORTED',
      );
    }
    emitStatus('Sending source image to the remote provider');
    const response = await requestJson('/api/federation/media/v1/assets', {
      method: 'POST',
      headers: { 'Content-Type': detected.mime, 'X-Content-SHA256': digest },
      body,
    }, {
      // A multi-megabyte upload legitimately outruns the JSON request timeout.
      timeoutScale: 10,
    });
    const parsed = federatedMediaAssetSchema.safeParse(response);
    // The provider echoes back the digest it computed. A mismatch means the
    // bytes it stored are not the bytes we sent, and rendering from them would
    // produce a plausible image of the wrong thing.
    if (!parsed.success || parsed.data.sha256 !== digest) {
      throw inputAssetError(
        'Remote media provider returned an invalid asset receipt',
        'MEDIA_PROVIDER_ASSET_INTEGRITY',
      );
    }
    return parsed.data.assetId;
  }

  // Keyed on the in-flight PROMISE, not the resolved id: the caller stages every
  // path concurrently, so memoizing only completed uploads would let a repeated
  // path start a second transfer of the same bytes before the first could
  // populate the cache — the exact case the memo exists to collapse.
  return function stageInputAsset(localPath) {
    const pending = uploads.get(localPath);
    if (pending) return pending;
    const upload = uploadInputAsset(localPath);
    uploads.set(localPath, upload);
    return upload;
  };
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
 * @param {{requestJson: Function, emitStatus: Function}} ctx - the executor's
 *   in-envelope request capability for this run; the stager is built from it
 *   lazily, so a text-only render never allocates one.
 * @param {import('zod').ZodTypeAny} [schema] - refined schema for the finished body
 * @returns {Promise<object>} the request with `{ assetId }` refs filled in
 */
export async function applyRemoteInputAssets(request, assets, ctx, schema) {
  if (!Array.isArray(assets) || assets.length === 0) return request;
  const stageAsset = createInputAssetStager(ctx);
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
