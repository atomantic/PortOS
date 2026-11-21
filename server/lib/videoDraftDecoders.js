/**
 * Draft VIDEO DECODE for local video runtimes: a separately downloaded, resource-light replacement for a model's video VAE decoder, used to make previews cheaper.
 *
 * This module is the single source of truth for which decoders ship and for the four gates a draft decode must clear before touching a render:
 *
 *   1. Declaration: the model entry must carry a `draftDecoder` this module attached; nothing is inferred from a runtime or repo name.
 *   2. Runtime capability: only a runtime whose arg builder emits the draft-decode flags may declare one, and the INSTALLED runner checkout must be the revision
 *      the asset was verified against (an older checkout silently ignores unknown argv and would report a draft decode it never performed).
 *   3. Asset readiness: the weights must already be in the local HF cache; PortOS never downloads at render time.
 *   4. Delivery intent: a model the finish graph names as a delivery target ALWAYS decodes on the full decoder, so a preview-grade asset never reaches a delivery clip.
 *
 * Every gate returns a REASON rather than throwing and the render proceeds on the full decoder (same "degrade, don't reject" contract as `speedProfileDeclineReason`
 * in lib/videoSpeedProfiles.js).
 *
 * Absence and `'full'` are the same request: `DRAFT_DECODE_FULL` is a named no-op so the picker has a selected option; `resolveVideoDraftDecoder` returns `null` for it,
 * keeping spawn args byte-identical to a full-decode render.
 *
 * `VIDEO_DRAFT_DECODERS` ships no entry on purpose (ADR docs/decisions/2026-08-30-h3-draft-decoder-asset.md): the pinned strict loader cannot load any
 * genuinely light decoder, and everything that loads is a full-size VAE that saves nothing. The gates ship first so a qualifying asset is one table row plus a migration.
 *
 * Pure module: no I/O, and the one import is a sibling lib predicate.
 */

import { isDeliveryVideoModel } from './videoFinishProfiles.js';

/** The implicit "unchanged" decode. Never resolves to an override. */
export const DRAFT_DECODE_FULL = 'full';

/** The one non-default decode id: a draft decoder is a property of the MODEL entry (at most one per entry). */
export const DRAFT_DECODE_DRAFT = 'draft';

export const DRAFT_DECODE_IDS = Object.freeze([DRAFT_DECODE_FULL, DRAFT_DECODE_DRAFT]);

/**
 * Runtimes whose arg builder emits the draft-decode flags AND whose helper loads them, so a table row can never widen onto a runner that silently ignores the flags.
 * Mirrors `LTX2_FAMILY_RUNTIMES` in lib/videoSpeedProfiles.js.
 */
export const DRAFT_DECODE_RUNTIMES = Object.freeze(['minimax_h3']);

/**
 * Shipped draft decoders, keyed by registry entry id.
 *
 * Row shape: `shippedRepo`/`shippedRevision` (fork guard: the profile attaches only while the entry still points at the weights the decoder was verified
 * against; both are guarded because the VAE latent contract is revision-sensitive), and `decoder` { id, label, description, repo, revision (pinned commit, never a branch),
 * files, sizeLabel, runtimeRevision (runner checkout the asset was verified against) }.
 * `decoder.files` is an explicit list of exactly ONE entry: the pinned MLX loader opens `video_vae/source/model.safetensors` by name, so a multi-shard decoder has nowhere to go.
 *
 * Candidate checklist, all four required (a failing decoder yields plausible-looking wrong pixels no test can catch):
 *   - Key contract, check first: `build_draft_decoder_shim` swaps ONE file into upstream's checkpoint root and the pinned `load_video_vae` STRICT-matches it
 *     against the whole `VideoVAE` tree, so it must be a COMPLETE, UNQUANTIZED, full-`VideoVAE`-shaped checkpoint with upstream's exact key set.
 *   - Latent contract: same channel count, `latents_mean`/`latents_std` and compression ratios as the model's own decoder.
 *   - Publicly verifiable: repo, revision and its own statement of what the weights are must be readable without a gate.
 *   - Preview-honest: its documentation must not disclaim the use PortOS puts it to.
 */
export const VIDEO_DRAFT_DECODERS = Object.freeze({});

const isEntry = (entry) => !!entry && typeof entry === 'object' && typeof entry.id === 'string';

const modelLabel = (model) => model?.name || model?.id || 'This model';

/** Absence and `'full'` are the same request. */
export const isFullDecode = (id) => id == null || id === '' || id === DRAFT_DECODE_FULL;

/** The draft decoder a model declares, or `null`. */
export const videoDraftDecoder = (model) => {
  const decoder = model?.draftDecoder;
  return decoder && typeof decoder === 'object' && typeof decoder.id === 'string' ? decoder : null;
};

/** Does this model offer a draft decode at all? */
export const supportsDraftDecode = (model) => videoDraftDecoder(model) !== null;

/**
 * Attach `draftDecoder` to shipped entries that don't already carry one. Pure; never mutates the input.
 * Preservation contract (as `applyVideoSpeedProfiles`): `'draftDecoder' in entry` (even `null`) wins; unshipped ids and entries whose `repo`/`revision` differ are left as-is.
 */
export const applyVideoDraftDecoders = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isEntry(entry)) return entry;
    if ('draftDecoder' in entry) return entry;
    const spec = VIDEO_DRAFT_DECODERS[entry.id];
    if (!spec) return entry;
    if (spec.shippedRepo !== null && entry.repo !== spec.shippedRepo) return entry;
    if (spec.shippedRevision !== null && entry.revision !== spec.shippedRevision) return entry;
    return { ...entry, draftDecoder: { ...spec.decoder } };
  });
};

/**
 * Validate one platform's video list for draft-decoder problems. Pure; returns `{ id, reason }` rows (empty when sound).
 * Checks: `draftDecoder` is an object; the runtime emits the flags; `label`/`repo`/`revision`/`runtimeRevision` are non-empty strings and `id` is exactly
 * `DRAFT_DECODE_DRAFT`; `files` is exactly one non-empty relative path with no traversal (it is joined onto a cache snapshot root and handed to a child process).
 */
export const validateDraftDecoderTable = (list) => {
  if (!Array.isArray(list)) return [];
  const problems = [];
  const fail = (id, reason) => problems.push({ id, reason });
  const requiredString = (decoder, key) => typeof decoder[key] === 'string' && decoder[key].length > 0;
  for (const entry of list) {
    if (!isEntry(entry)) continue;
    if (!('draftDecoder' in entry) || entry.draftDecoder == null) continue;
    const decoder = entry.draftDecoder;
    if (typeof decoder !== 'object' || Array.isArray(decoder)) {
      fail(entry.id, 'draftDecoder must be an object');
      continue;
    }
    if (!DRAFT_DECODE_RUNTIMES.includes(entry.runtime)) {
      fail(entry.id, `draftDecoder needs one of the ${DRAFT_DECODE_RUNTIMES.join('/')} runtimes (got "${entry.runtime || 'none'}") — no other builder emits its flags`);
      continue;
    }
    const missing = ['id', 'label', 'repo', 'revision', 'runtimeRevision'].filter((key) => !requiredString(decoder, key));
    if (missing.length > 0) {
      fail(entry.id, `draftDecoder is missing required string field(s): ${missing.join(', ')}`);
      continue;
    }
    if (decoder.id !== DRAFT_DECODE_DRAFT) {
      fail(entry.id, `draftDecoder.id must be "${DRAFT_DECODE_DRAFT}" — the request field is a closed enum, so any other id would reach the picker and then be rejected by the route; got "${decoder.id}"`);
      continue;
    }
    const files = decoder.files;
    if (!Array.isArray(files) || files.length === 0
      || files.some((f) => typeof f !== 'string' || f.length === 0)) {
      fail(entry.id, 'draftDecoder.files must be a non-empty array of non-empty strings');
      continue;
    }
    // Mirrors build_draft_decoder_shim in scripts/ml/generate_minimax_h3.py: one named source weight, so refuse multi-shard here rather than minutes into a render.
    if (files.length !== 1) {
      fail(entry.id, `draftDecoder.files must name exactly one weight file (the pinned VAE loader reads one); got ${files.length}`);
      continue;
    }
    // Joined onto an HF snapshot root and handed to a child process: an absolute or climbing path is a real escape.
    const unsafe = files.find((f) => f.startsWith('/') || f.split('/').includes('..'));
    if (unsafe) fail(entry.id, `draftDecoder.files entry "${unsafe}" must be a relative path inside the repo`);
  }
  return problems;
};

/**
 * Load-time guard: strip every invalid `draftDecoder`, logging each problem, so a hand-edited or stale registry can neither offer an unperformable decode nor crash boot
 * (`loadMediaModels` runs at import time). Returns the input unchanged when sound.
 */
export const sanitizeDraftDecoders = (list) => {
  const problems = validateDraftDecoderTable(list);
  if (problems.length === 0) return list;
  const bad = new Set(problems.map((p) => p.id));
  for (const p of problems) {
    console.log(`⚠️ media-models: dropping draftDecoder on "${p.id}" — ${p.reason}`);
  }
  return list.map((entry) => {
    if (!isEntry(entry) || !bad.has(entry.id)) return entry;
    const { draftDecoder: _dropped, ...rest } = entry;
    return rest;
  });
};

/**
 * Why a requested draft decode could not be applied: a machine-readable code plus a UI-ready sentence, or `null` when it applies. Returned, not thrown,
 * so the render proceeds on the model's own decoder.
 *
 * @param {object}  args.model            resolved video model entry
 * @param {string}  args.decodeId         what the request asked for
 * Every gate FAILS CLOSED on a missing argument: a caller that omits the model list or the cache verdict has not proved preview fidelity is allowed.
  *
 *
 * @param {Array}   args.models           the platform's video list (REQUIRED; a non-array declines) so a declared Finish target counts as a delivery model.
  * @param {string}  args.runtimeRevision  the INSTALLED runner checkout revision, or null when unreadable
 * @param {boolean} args.assetCached      the pinned files resolved in the HF cache
 */
export const draftDecodeDeclineReason = ({
  model, decodeId, models = null, runtimeRevision = null, assetCached = false,
}) => {
  if (isFullDecode(decodeId)) return null;
  if (!Array.isArray(models)) {
    return {
      code: 'DRAFT_DECODE_DELIVERY_UNVERIFIABLE',
      message: `${modelLabel(model)} — the model list needed to check delivery intent was not supplied, so this render decodes on the full decoder.`,
    };
  }
  // Delivery intent outranks everything, even a model with no decoder: the finish graph (lib/videoFinishProfiles.js) is the authority on delivery targets.
  if (isDeliveryVideoModel(model, models)) {
    return {
      code: 'DRAFT_DECODE_DELIVERY_MODEL',
      message: `${modelLabel(model)} is a delivery model — final and Finish renders always decode on the full decoder.`,
    };
  }
  const decoder = videoDraftDecoder(model);
  if (!decoder || decodeId !== DRAFT_DECODE_DRAFT) {
    return {
      code: 'DRAFT_DECODE_UNSUPPORTED',
      message: `${modelLabel(model)} doesn't offer a draft decode — rendering on its own decoder.`,
    };
  }
  // A checkout at another revision has a different helper that rejects or silently ignores the flags.
  if (runtimeRevision !== decoder.runtimeRevision) {
    return {
      code: 'DRAFT_DECODE_RUNTIME_UNSUPPORTED',
      message: `The installed ${model?.runtime || 'runtime'} checkout can't perform a draft decode. Run Repair in Video Gen to move it to the supported revision.`,
    };
  }
  if (!assetCached) {
    return {
      code: 'DRAFT_DECODE_ASSET_NOT_CACHED',
      message: `The ${decoder.label} draft decoder isn't downloaded. Download it in Video Gen to render previews on it.`,
    };
  }
  return null;
};

/**
 * Resolve the draft decoder a render should actually use, or `null` whenever anything declines (spawn args then stay byte-identical to a full-decode render).
 *
 * @returns {{ id, label, repo, revision, files, runtimeRevision } | null}
 */
export const resolveVideoDraftDecoder = (args) => {
  // Checked BEFORE the decline reason: a full decode has no decline reason, so falling through would hand a decoder to a request for the model's own one.
  if (isFullDecode(args?.decodeId)) return null;
  if (draftDecodeDeclineReason(args)) return null;
  const decoder = videoDraftDecoder(args?.model);
  if (!decoder) return null;
  return {
    id: decoder.id,
    label: decoder.label,
    repo: decoder.repo,
    revision: decoder.revision,
    files: [...decoder.files],
    runtimeRevision: decoder.runtimeRevision,
  };
};

/**
 * Decode options for the picker, in order. EMPTY for a model with no draft decoder so the client renders no control (as `publicVideoTextEncoderOptions`);
 * the full-decode entry appears only when there is a real second choice.
 */
export const publicVideoDraftDecodeOptions = (model) => {
  const decoder = videoDraftDecoder(model);
  if (!decoder) return [];
  return [
    {
      id: DRAFT_DECODE_FULL,
      label: 'Full decode',
      description: "The model's own decoder. Delivery quality, and what every final render uses.",
    },
    {
      id: decoder.id,
      label: decoder.label,
      description: decoder.description || 'A resource-light decoder for judging prompt and composition. Never used for a final render.',
      repo: decoder.repo,
      revision: decoder.revision,
      sizeLabel: decoder.sizeLabel || null,
    },
  ];
};

/** Every downloadable draft-decoder asset across a video model list, de-duped by repo+revision, for the Video Gen download/repair surface. */
export const downloadableVideoDraftDecoders = (list) => {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const decoder = videoDraftDecoder(entry);
    if (!decoder) continue;
    const key = `${decoder.repo}@${decoder.revision}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...decoder, modelId: entry.id });
  }
  return out;
};
