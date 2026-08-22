/**
 * One builder for the versioned federated-media submission body.
 *
 * Three call sites now produce this object — the image generate route, the
 * video generate route, and the unattended default-provider router used by
 * Creative Director / Creative Commission — and every one of them persists it
 * inside the job's `remoteMedia` marker, where it is replayed verbatim on each
 * reconcile. A field that one site spreads and another forgets is therefore not
 * a cosmetic drift: it is a render that silently loses its seed or its
 * resolution the first time a worker restart replays it.
 *
 * Optional fields are conditionally spread rather than passed as `undefined`
 * because the wire schemas are `.strict()` and the marker is compared by shape
 * on the provider side; an explicit `undefined` would serialize to a key that
 * was never requested.
 */

import {
  federatedMediaImageJobSubmissionBaseSchema,
  federatedMediaVideoJobSubmissionBaseSchema,
  validateRequest,
} from './validation.js';

// Local param name -> wire field name, per kind. The two generate routes speak
// slightly different local dialects (video's route carries `guidanceScale`
// while the wire says `guidance`), so the mapping lives here rather than in a
// spread at each call site.
const FIELD_MAPS = Object.freeze({
  image: Object.freeze({
    negativePrompt: 'negativePrompt',
    width: 'width',
    height: 'height',
    steps: 'steps',
    guidance: 'guidance',
    guidanceScale: 'guidance',
    seed: 'seed',
    // Rides with the init image it scales (#4348). Dropping it would render at
    // full denoise — the opposite of what a low strength asked for, and
    // indistinguishable from a working render until the result comes back.
    initImageStrength: 'initImageStrength',
  }),
  video: Object.freeze({
    negativePrompt: 'negativePrompt',
    width: 'width',
    height: 'height',
    numFrames: 'numFrames',
    fps: 'fps',
    steps: 'steps',
    guidance: 'guidance',
    guidanceScale: 'guidance',
    seed: 'seed',
  }),
});

// The BASE (un-refined) schemas. Conditioning images reach the body as asset ids
// resolved immediately before submission, so at BUILD time the pairing rules
// ("a strength needs an image", "an end frame needs a start frame") have nothing
// to check yet. The generate routes enforce those pairings on the local params
// they actually hold, and the provider re-checks the fully assembled body.
const SCHEMAS = Object.freeze({
  image: federatedMediaImageJobSubmissionBaseSchema,
  video: federatedMediaVideoJobSubmissionBaseSchema,
});

/**
 * Build and validate a wire submission for a visual media kind.
 *
 * Audio is deliberately absent: its wire body is not a projection of local
 * params at all but a canonical prompt rendered from a fixed enum profile
 * (`renderFederatedMediaAudioPrompt`), so it has no field mapping to share.
 *
 * @param {object} args
 * @param {'image'|'video'} args.kind
 * @param {object} args.params - Local job params to project onto the wire.
 * @param {string} [args.engine] - Provider engine; defaults to `'local'`.
 * @returns {object} Validated wire submission body.
 */
export function buildFederatedMediaRequest({ kind, params, engine }) {
  const schema = SCHEMAS[kind];
  if (!schema) throw new Error(`buildFederatedMediaRequest: unsupported kind ${kind}`);
  const body = {
    kind,
    engine: engine || params?.mediaProviderEngine || 'local',
    modelId: params?.modelId,
    prompt: params?.prompt,
  };
  for (const [local, wire] of Object.entries(FIELD_MAPS[kind])) {
    // `negativePrompt` is the one field where an empty string is meaningless
    // rather than meaningful — the wire schema trims it to '' and then rejects
    // the min(1)-free optional as noise, so treat blank as absent.
    const value = params?.[local];
    if (value === undefined || value === null) continue;
    if (wire === 'negativePrompt' && !String(value).trim()) continue;
    if (body[wire] === undefined) body[wire] = value;
  }
  return validateRequest(schema, body);
}
