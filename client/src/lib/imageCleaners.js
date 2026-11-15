// Share the pure settings policy without importing image-processing dependencies.
//
// Re-exports `resolveCleanersFromConfig` from the shared pure `server/lib/imageCleanDefaults.js`
// policy. Reads `{cleanC2PA, denoise}` off a per-mode settings record. `cleanC2PA` defaults are
// mode-aware (on for `codex` + `external` — the backends that emit C2PA chunks today — off otherwise,
// as an allow-list rather than a deny-list); `denoise` defaults off everywhere (lossy, opt-in only).
export { resolveCleanersFromConfig } from '../../../server/lib/imageCleanDefaults.js';
