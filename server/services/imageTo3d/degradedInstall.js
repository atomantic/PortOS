/**
 * Image-to-3D — the one builder for a degraded-but-working install's projection (remedy
 * plus missing modules, for the card and the install `verify` frame). Takes a plain `string[]`.
 */

/**
 * Card line naming the modules (`Missing: o_voxel`); `''` when none so the detail key is omitted.
 * @param {string[]|undefined} missing module names the probe found absent
 */
export function missingModulesLabel(missing) {
  return missing?.length ? `Missing: ${missing.join(', ')}` : '';
}

/**
 * Remedy prose plus the missing modules as a closing sentence, for lanes that emit one string.
 * @param {string} help the remedy prose (already ends in its own punctuation)
 * @param {string[]|undefined} missing module names the probe found absent
 */
export function appendMissingModules(help, missing) {
  const label = missingModulesLabel(missing);
  return [help, label && `${label}.`].filter(Boolean).join(' ');
}

/**
 * Both consumers of one degraded install state, from one description (`degraded` card
 * projection, `warnings` prose for the install `verify` stage); building them per
 * adapter lets the two drift (#4741). `help` carries ONLY the remedy, never module names.
 * @param {object} args
 * @param {string} args.label short badge text (`incomplete install`)
 * @param {string} args.help the remedy, and ONLY the remedy — never the culprit names
 * @param {boolean} [args.repairable=true] can re-running install fix it?
 * @param {string[]} [args.missing] module names the probe found absent, when it knows
 * @returns {{degraded: {label: string, help: string, repairable: boolean, detail?: string},
 *   warnings: string[]}}
 */
export function describeDegradedInstall({ label, help, repairable = true, missing }) {
  const detail = missingModulesLabel(missing);
  return {
    degraded: { label, help, repairable, ...(detail ? { detail } : {}) },
    // No prose means no warning frame, never `[undefined]`.
    warnings: help ? [appendMissingModules(help, missing)] : [],
  };
}
