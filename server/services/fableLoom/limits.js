/**
 * Re-export shim. The caps themselves moved to `server/lib/fableLoomLimits.js`
 * so `lib/fableLoomValidation.js` can read them without importing upward into
 * services (issue #4901). They were always a leaf module; only the address
 * changed. Existing deep imports from inside the service keep working.
 */

export { LOOM_LIMITS } from '../../lib/fableLoomLimits.js';
