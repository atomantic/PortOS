// Client mirror of `resolveCleanersFromConfig` from `server/lib/imageClean.js`.
// The server is authoritative — keep the two copies in sync. Used by the
// Settings ImageGenTab and the per-render ImageGen page so both surfaces
// agree on how the saved per-mode settings map into the two-flag world.
// Defaults are mode-aware: cleanC2PA defaults on only for backends that
// actually emit C2PA chunks today — codex + external. Allow-list rather
// than deny-list so a future 4th backend defaults off until confirmed.

export function resolveCleanersFromConfig(modeCfg, mode) {
  const cfg = modeCfg || {};
  const cleanC2PADefault = mode === 'codex' || mode === 'external';
  return {
    cleanC2PA: typeof cfg.cleanC2PA === 'boolean' ? cfg.cleanC2PA : cleanC2PADefault,
    denoise: typeof cfg.denoise === 'boolean' ? cfg.denoise : false,
  };
}
