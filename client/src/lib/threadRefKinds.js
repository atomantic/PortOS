/**
 * Thread ref vocabulary + route table.
 *
 * Re-export of `server/lib/threadRefKinds.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift (the
 * "One pure module, one definition" convention in this directory's README).
 *
 * A Brain *thread* is a tracked topic or commitment, not a message thread.
 *
 * Named exports only: the two the client renders with plus the kind id list
 * the Threads tab's ref picker enumerates. The server-side predicates stay out
 * of the client barrel until something here needs them.
 */
export { THREAD_REF_KIND_IDS, threadRefLabel, threadRefUrl } from '../../../server/lib/threadRefKinds.js';
