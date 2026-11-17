/**
 * Re-export of `server/lib/threadRefKinds.js` — the Brain THREAD ref vocabulary and `(kind, id)` →
 * label/URL route table (a *thread* is a tracked topic or commitment, never a message thread).
 *
 * Named exports only — `threadRefLabel`/`threadRefUrl` (what the client renders with) and
 * `THREAD_REF_KIND_IDS` / `EXTERNAL_THREAD_REF_KINDS` (what the Threads tab's ref picker enumerates
 * and how `ThreadRefChip` picks `<a>` over `<Link>`). `components/catalog/CatalogUniversePanel.jsx`
 * renders the catalog ingredient's inbound-ref chips through `threadRefUrl` here instead of its own
 * local switch, so the repo has exactly one kind→route table.
 */

/**
 * Thread ref vocabulary + route table.
 *
 * Re-export of `server/lib/threadRefKinds.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift (the
 * "One pure module, one definition" convention in this directory's README).
 *
 * A Brain *thread* is a tracked topic or commitment, not a message thread.
 *
 * Named exports only: the two the client renders with, the kind id list the
 * Threads tab's ref picker enumerates, and the external set the shared ref chip
 * uses to pick `<a>` over `<Link>`. The server-side predicates stay out
 * of the client until something here needs them.
 */
export { THREAD_REF_KIND_IDS, EXTERNAL_THREAD_REF_KINDS, threadRefLabel, threadRefUrl } from '../../../server/lib/threadRefKinds.js';
