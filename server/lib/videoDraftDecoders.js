/**
 * Draft VIDEO DECODE for local video runtimes (issue #5423).
 *
 * A diffusion video model produces a latent sequence; a VAE decoder turns that
 * sequence into pixels. On MiniMax H3 the decode is not a rounding error on the
 * render — it is a full-sequence pass over every latent frame at the output
 * canvas, and it happens twice over: once at the end of the render, and once
 * per denoise step for the stepwise preview PortOS publishes to the Video Gen
 * stage. Most of the time a user spends looking at an H3 render is spent
 * deciding whether the PROMPT and the COMPOSITION are right, which a
 * lower-fidelity decode answers just as well as the shipped one.
 *
 * A *draft decoder* is a separately downloaded, resource-light replacement for
 * the model's own video VAE decoder that answers that question faster. This
 * module is the single source of truth for which ones PortOS ships, and — more
 * importantly — for the four gates a draft decode has to clear before it can
 * touch a render:
 *
 *   1. **Declaration.** The model entry must carry a `draftDecoder` this
 *      module attached. Nothing is inferred from a runtime or a repo name.
 *   2. **Runtime capability.** Only a runtime whose arg builder actually emits
 *      the draft-decode flags may declare one, and the INSTALLED runner
 *      checkout must be the revision the asset was verified against. An older
 *      checkout silently ignores unknown argv, which would leave a full-decode
 *      render reporting a draft one.
 *   3. **Asset readiness.** The weights must already be resolved in the local
 *      HF cache. PortOS never downloads at render time.
 *   4. **Delivery intent.** A model the finish graph names as a delivery
 *      target ALWAYS decodes on the full decoder, whatever was requested, so a
 *      preview-grade asset can never reach a delivery clip. The client's Finish
 *      flow resets the control to Full for the same reason, so the form and the
 *      server agree about what a delivery render will do.
 *
 * Every one of those returns a REASON rather than throwing, and the render
 * proceeds on the full decoder. Draft decode only ever makes a render cheaper,
 * so failing it closed with a 400 would turn a convenience into an outage — the
 * same "degrade, don't reject" contract `speedProfileDeclineReason` uses in
 * lib/videoSpeedProfiles.js.
 *
 * ## Why absence and `'full'` are the same request
 *
 * `DRAFT_DECODE_FULL` ('full') is the shipped contract: the model's own
 * decoder, exactly as every render before this feature existed. It is a named
 * option so the picker has something to show as selected, and a deliberate
 * NO-OP — `resolveVideoDraftDecoder` returns `null` for it, so a full-decode
 * render builds byte-identical spawn args and stamps no extra history field.
 * Same rule as `'quality'` in lib/videoSpeedProfiles.js and `'stock'` in
 * lib/videoTextEncoders.js.
 *
 * ## Why `VIDEO_DRAFT_DECODERS` currently ships no entry
 *
 * The mechanism is declared and wired; the ASSET is not, because none of the
 * published candidates clears this repo's own bar for a pinned weight (see the
 * table below for the checklist a candidate must pass). Shipping the gates
 * first is deliberate: the day an asset is verified, it is one table row plus a
 * migration, and every fallback path it depends on is already covered by tests.
 *
 * Pure module: no I/O, and the one import is a sibling lib predicate.
 */

import { isDeliveryVideoModel } from './videoFinishProfiles.js';

/**
 * The implicit "unchanged" decode. Never resolves to an override.
 */
export const DRAFT_DECODE_FULL = 'full';

/**
 * The one non-default decode id. A single named alternative rather than an open
 * enum: a draft decoder is a property of the MODEL entry (there is at most one
 * per entry), so the request only ever selects between "the model's decoder"
 * and "the draft decoder this model declares".
 */
export const DRAFT_DECODE_DRAFT = 'draft';

export const DRAFT_DECODE_IDS = Object.freeze([DRAFT_DECODE_FULL, DRAFT_DECODE_DRAFT]);

/**
 * Runtimes whose arg builder emits the draft-decode flags AND whose helper
 * loads them. Declared here so a table row can never widen itself onto a runner
 * that would silently ignore the flags — the failure mode that check exists to
 * prevent is a render that reports a draft decode it never performed.
 *
 * Mirrors the `LTX2_FAMILY_RUNTIMES` guard in lib/videoSpeedProfiles.js.
 */
export const DRAFT_DECODE_RUNTIMES = Object.freeze(['minimax_h3']);

/**
 * Shipped draft decoders, keyed by registry entry id.
 *
 * Shape of a row:
 *
 *   shippedRepo      fork-preservation guard — the profile attaches only while
 *   shippedRevision  the entry still points at the weights the decoder was
 *                    verified against. Guards BOTH, like the speed-profile
 *                    table and unlike the finish-profile one: a decoder is
 *                    matched to a specific VAE latent contract, which is
 *                    revision-sensitive.
 *   decoder.id       stable key, persisted in history and submitted by the UI
 *   decoder.label    picker label
 *   decoder.description  one line under the picker; states the trade honestly
 *   decoder.repo     HF repo the asset is downloaded from
 *   decoder.revision exact pinned commit — never a branch
 *   decoder.files    explicit file list, never a repo snapshot (same rule as
 *                    `requiredWeights` in lib/mediaModels.js). Exactly ONE
 *                    entry today: the pinned MLX loader opens
 *                    `video_vae/source/model.safetensors` by name rather than
 *                    globbing, so a multi-shard decoder has nowhere to go —
 *                    validated here so a declaration can never reach a runner
 *                    that would reject it mid-render.
 *   decoder.sizeLabel  download size, shown before the user commits to it
 *   decoder.runtimeRevision  the runner checkout the asset was verified
 *                    against; an install on any other revision declines
 *
 * CHECKLIST a candidate must pass before it is added here — all four, because a
 * decoder that fails any of them produces plausible-looking pixels that are
 * wrong in a way no test can catch:
 *
 *   - **Key contract.** Its tensor names load into the pinned runner's decoder
 *     module tree under that loader's STRICT check. A quantized repack whose
 *     keys carry `.scales`/`.biases` needs loader support first; it is not a
 *     drop-in.
 *   - **Latent contract.** It decodes the SAME latent space — channel count,
 *     `latents_mean`/`latents_std`, and spatial/temporal compression ratios
 *     identical to the model's own decoder.
 *   - **Publicly verifiable.** The repo, its revision and its own statement of
 *     what the weights are must be readable without a gate, so the pin can be
 *     reviewed rather than taken on trust.
 *   - **Preview-honest.** Its own documentation must not disclaim the use PortOS
 *     puts it to. A checkpoint whose authors say "do not use this as a video
 *     decoder" is not made suitable by only showing its output in a preview.
 */
export const VIDEO_DRAFT_DECODERS = Object.freeze({});

const isEntry = (entry) => !!entry && typeof entry === 'object' && typeof entry.id === 'string';

const modelLabel = (model) => model?.name || model?.id || 'This model';

/**
 * Absence and `'full'` are the same request.
 */
export const isFullDecode = (id) => id == null || id === '' || id === DRAFT_DECODE_FULL;

/**
 * The draft decoder a model declares, or `null`.
 */
export const videoDraftDecoder = (model) => {
  const decoder = model?.draftDecoder;
  return decoder && typeof decoder === 'object' && typeof decoder.id === 'string' ? decoder : null;
};

/**
 * Does this model offer a draft decode at all?
 */
export const supportsDraftDecode = (model) => videoDraftDecoder(model) !== null;

/**
 * Attach `draftDecoder` to shipped entries that don't already carry one. Pure;
 * returns a new array and never mutates the input entries.
 *
 * Preservation contract (identical to `applyVideoSpeedProfiles`):
 *   - `'draftDecoder' in entry`      → user/existing value wins, `null`
 *                                      included (the explicit "no draft decode
 *                                      on this entry" override).
 *   - entry id not shipped           → custom model, left as-is.
 *   - `repo`/`revision` differ       → forked or re-pinned weights, left as-is.
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
 * Validate one platform's video list for draft-decoder problems. Pure — returns
 * `{ id, reason }` rows (empty when sound). Callers decide whether to
 * warn-and-strip (load path) or fail (the test that pins the shipped registry).
 *
 * Checked, in the order a hand-edit is most likely to break it:
 *   - `draftDecoder` is an object (or absent/null)
 *   - the runtime is one whose builder actually emits the flags
 *   - `id`, `label`, `repo`, `revision` and `runtimeRevision` are non-empty
 *     strings — every one of them reaches argv or an HF cache lookup
 *   - `files` names exactly one non-empty relative path, with no traversal (it is
 *     joined against a cache snapshot root and handed to a child process)
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
    if (decoder.id === DRAFT_DECODE_FULL) {
      fail(entry.id, `"${DRAFT_DECODE_FULL}" is the reserved full-decode id`);
      continue;
    }
    const files = decoder.files;
    if (!Array.isArray(files) || files.length === 0
      || files.some((f) => typeof f !== 'string' || f.length === 0)) {
      fail(entry.id, 'draftDecoder.files must be a non-empty array of non-empty strings');
      continue;
    }
    // Mirrors build_draft_decoder_shim in scripts/generate_minimax_h3.py: the
    // pinned VAE loader reads one named source weight, so a multi-shard
    // declaration is refused HERE rather than failing minutes into a render.
    if (files.length !== 1) {
      fail(entry.id, `draftDecoder.files must name exactly one weight file (the pinned VAE loader reads one); got ${files.length}`);
      continue;
    }
    // These are joined onto an HF snapshot root by the resolver and then handed
    // to a child process, so an absolute or climbing path is a real escape, not
    // a style nit.
    const unsafe = files.find((f) => f.startsWith('/') || f.split('/').includes('..'));
    if (unsafe) fail(entry.id, `draftDecoder.files entry "${unsafe}" must be a relative path inside the repo`);
  }
  return problems;
};

/**
 * Load-time guard: strip every invalid `draftDecoder`, logging each problem. A
 * user-edited (or migration-stale) registry must not be able to offer a decode
 * this build's runner cannot perform, and must not crash boot
 * (`loadMediaModels` runs at import time). Returns the input array unchanged
 * when the table is sound, so the common path allocates nothing.
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
 * Why a requested draft decode could not be applied — a machine-readable code
 * plus a sentence the UI/log can show verbatim. `null` when it applies.
 *
 * Returned rather than thrown, for the reason in the module header: the render
 * still proceeds, on the model's own decoder.
 *
 * @param {object}  args.model            resolved video model entry
 * @param {string}  args.decodeId         what the request asked for
 * @param {Array}   args.models           the platform's video list, so a model
 *                                        that IS somebody's declared Finish
 *                                        target counts as a delivery model
 * @param {string}  args.runtimeRevision  the INSTALLED runner checkout revision,
 *                                        or null when it could not be read
 * @param {boolean} args.assetCached      the pinned files resolved in the HF cache
 */
export const draftDecodeDeclineReason = ({
  model, decodeId, models = null, runtimeRevision = null, assetCached = true,
}) => {
  if (isFullDecode(decodeId)) return null;
  // Delivery intent outranks everything, including a model that declares no
  // decoder at all: the answer to "may this clip be decoded at preview
  // fidelity?" is no before the question of "with what?" is even asked. The
  // finish graph is the authority (lib/videoFinishProfiles.js): a model another
  // entry names as its Finish target is where compositions are DELIVERED, so a
  // preview-grade decoder has no business on it however the request was phrased.
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
  // A checkout at any other revision has a different helper, whose argparse
  // either rejects the flags outright or (worse, on an older PortOS helper)
  // ignores them while the render reports a draft decode that never happened.
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
 * Resolve the draft decoder a render should actually use.
 *
 * Returns `null` whenever anything at all declines — the caller then leaves the
 * decode exactly where it was, and the spawn args stay byte-identical to a
 * pre-feature render.
 *
 * @returns {{ id, label, repo, revision, files, runtimeRevision } | null}
 */
export const resolveVideoDraftDecoder = (args) => {
  // Checked BEFORE the decline reason, not after: a full decode has no reason
  // to report (nothing was declined), so a resolver that only asked
  // `draftDecodeDeclineReason` would fall through and hand a decoder to the
  // request that explicitly asked for the model's own one.
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
 * The decode options to put in front of the user for one model, in picker
 * order. EMPTY for a model with no draft decoder, so the client renders no
 * control rather than a one-entry select — the same presentation rule
 * `publicVideoTextEncoderOptions` follows. The full-decode entry is included
 * only when there is a real second choice.
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

/**
 * Every downloadable draft-decoder asset across a video model list, de-duped by
 * repo+revision. Used by the Video Gen download/repair surface, which needs the
 * targets without caring which entry declared them.
 */
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
