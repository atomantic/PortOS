/**
 * Re-export of `server/lib/canonPrompt.js`.
 *
 * SHORT/RICH/PREVIEW spec + `flattenCanonDescriptorFragments` / `mapCanonDescriptorFragments` /
 * `descriptorForCanonEntry`. Named exports only, so the server-only `flatten*` helpers stay out of the
 * client barrel.
 */

/**
 * SHORT/RICH/PREVIEW canon descriptor spec and its fragment renderers.
 *
 * Re-export of `server/lib/canonPrompt.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/canonPrompt` import path in the client is unchanged.
 */
export {
  descriptorForCanonEntry,
  flattenCanonDescriptorFragments,
  hasCanonDescriptorContent,
  mapCanonDescriptorFragments,
  previewCanonFragments,
  richCanonDescriptorFragments,
  shortCanonDescriptorFragments,
} from '../../../server/lib/canonPrompt.js';
