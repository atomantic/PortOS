/**
 * `LAYERED_INTELLIGENCE_SOURCE_KEYS` — the ordered list of built-in Layer-1 telemetry sources the
 * self-improvement loop can gather.
 *
 * Used by server schema and client UI to build source lists from one canonical definition. Pure leaf:
 * no Node built-in, nothing outside `server/lib`. Re-exported by
 * `client/src/lib/layeredIntelligenceSources.js`.
 */

export { LAYERED_INTELLIGENCE_SOURCE_KEYS } from './layeredIntelligenceSourceKeys.js';
