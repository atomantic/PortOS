/**
 * Re-export of `server/lib/layeredIntelligenceSources.js` — `LAYERED_INTELLIGENCE_SOURCE_KEYS`, the
 * ordered list of built-in Layer-1 telemetry sources the self-improvement loop can gather.
 *
 * A test requires one `LI_SOURCE_FIELDS` toggle per key.
 */

/**
 * Layered Intelligence source keys — re-export of server/lib/layeredIntelligenceSources.js.
 *
 * The client and server build their source lists from one canonical definition
 * so they cannot drift. The file stays so every `client/src/lib/layeredIntelligenceSources`
 * import path is unchanged.
 */
export { LAYERED_INTELLIGENCE_SOURCE_KEYS } from '../../../server/lib/layeredIntelligenceSources.js';
