/**
 * Thread ref vocabulary + route table.
 *
 * Re-export of `server/lib/threadRefKinds.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift (the
 * "One pure module, one definition" convention in this directory's README).
 *
 * A Brain *thread* is a tracked topic or commitment, not a message thread.
 *
 * Named exports only, and only the two the client renders with — the registry
 * table and the server-side predicates stay out of the client barrel until
 * something here needs them.
 */
export { threadRefLabel, threadRefUrl } from '../../../server/lib/threadRefKinds.js';
