// Dependency-free policy shared by the server, browser, and route test doubles.
//
// `resolveCleanersFromConfig(modeCfg, mode)` and `resolveImageCleaners(body, settings, mode)` —
// dependency-free saved defaults and request overrides; C2PA defaults on for codex/external, denoise
// stays opt-in.

/**
 * Cleaner flags from a per-mode settings record: the shared "what did the user save" rule (no
 * body-override layer). `cleanC2PA` defaults on only for backends known to emit C2PA chunks
 * (`codex`, and `external` proxies that may re-encode through ComfyUI's stamp node); an
 * allow-list, so a future backend stays off until confirmed to emit caBX. `denoise` is lossy and
 * blurs text, so it defaults off everywhere.
 */
const C2PA_EMITTING_MODES = ['codex', 'external'];

export function resolveCleanersFromConfig(modeCfg, mode) {
  const cfg = modeCfg || {};
  const cleanC2PADefault = C2PA_EMITTING_MODES.includes(mode);
  return {
    cleanC2PA: typeof cfg.cleanC2PA === 'boolean' ? cfg.cleanC2PA : cleanC2PADefault,
    denoise: typeof cfg.denoise === 'boolean' ? cfg.denoise : false,
  };
}

// Explicit body fields (per-render checkbox) win over the saved per-mode defaults; also the safety
// net for direct `generateImage()` callers.
export function resolveImageCleaners(body, settings, mode) {
  const saved = resolveCleanersFromConfig(settings?.imageGen?.[mode], mode);
  return {
    cleanC2PA: typeof body?.cleanC2PA === 'boolean' ? body.cleanC2PA : saved.cleanC2PA,
    denoise: typeof body?.denoise === 'boolean' ? body.denoise : saved.denoise,
  };
}
