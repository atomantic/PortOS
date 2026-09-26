// Dependency-free policy shared by the server, browser, and route test doubles.

/**
 * Read cleaner flags off a per-mode settings record. Pure: no I/O, no
 * body-override layer (that's the resolver's job — this is the shared
 * "what did the user save" rule that resolver + Settings UI + ImageGen
 * page + test mocks all need to agree on).
 *
 * Defaults are mode-aware: `cleanC2PA` defaults on only for backends that
 * actually emit C2PA chunks today — `codex` (gpt-image-2) and `external`
 * (A1111 / Forge proxies that may re-encode through ComfyUI's C2PA stamp
 * node). Allow-list rather than deny-list: a future backend defaults
 * off until someone confirms it emits caBX. `denoise` defaults to false
 * everywhere (lossy, blurs text — must be explicitly opted into).
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
