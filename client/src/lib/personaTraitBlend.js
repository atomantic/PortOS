/**
 * Digital-twin persona trait blending, so the Personas UI previews the same directional wording the twin will use.
 *
 * Re-export of `server/lib/personaTraitBlend.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/personaTraitBlend` import path in the client is unchanged.
 */
export {
  BIG_FIVE_DELTA_MAX,
  BIG_FIVE_DELTA_MIN,
  BIG_FIVE_LEAN,
  COMM_DELTA_MAX,
  COMM_DELTA_MIN,
  EMOJI_USAGE_VALUES,
  blendCommunicationProfile,
  describeTraitAdjustments,
  hasTraitAdjustments,
  renderTraitBlendDirective,
} from '../../../server/lib/personaTraitBlend.js';
