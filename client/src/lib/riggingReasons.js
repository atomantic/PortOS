/**
 * Re-export of `server/lib/riggingReasons.js`, the one definition of the character-rigging readiness reason labels.
 *
 * The server returns stable kebab-case reason codes whenever rigging is not ready; this is the label side. Names are prefixed (`RIGGING_…`) so a call site importing the image-to-3D lane's `UNAVAILABLE_REASONS` too never has to alias.
 */

export { RIGGING_UNAVAILABLE_REASONS, RIGGING_REASON_FALLBACK, riggingReasonLabel } from '../../../server/lib/riggingReasons.js';
