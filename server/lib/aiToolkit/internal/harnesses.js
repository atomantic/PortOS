/**
 * The one translation between the registry's name for a direct API binding
 * (`direct`) and the graph's (`harness_id = NULL`).
 *
 * A DELIBERATE MIRROR of the minimum `server/lib/providerHarnesses.js` the
 * toolkit needs (#7562). This directory is vendored and stays self-contained —
 * no imports out to other PortOS modules (see `aiToolkit/AGENTS.md`) — so the
 * lookups are duplicated rather than imported, exactly as `gateways.js` is.
 * `server/lib/providerHarnesses.parity.test.js` fails when the two drift.
 *
 * Only this translation is mirrored: the id list, bindings, recipes and
 * matchers stay host-side, because the toolkit never materializes a route — it
 * resolves a composite provider id (`harness.method@service`) back to a record
 * the host wrote, and `direct` is the one id with two spellings.
 */

/** The harness id a direct API record resolves to. */
export const DIRECT_HARNESS_ID = 'direct';

/** `null` (the graph's spelling of a direct API binding) → `direct`. */
export const normalizeHarnessId = (harnessId) => harnessId ?? DIRECT_HARNESS_ID;

/** `direct` → `null`, so the graph keeps its nullable column and partial unique index. */
export const graphHarnessId = (harnessId) => (harnessId === DIRECT_HARNESS_ID ? null : harnessId ?? null);
