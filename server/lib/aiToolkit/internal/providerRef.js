/**
 * The composite provider-id grammar (`<harness>.<method>@<service-slug>
 * [+<bootstrap-slug>]`, #7564) as the toolkit needs it: enough to tell a
 * composite reference from a preset record id, so `getProviderById` knows when
 * to hand a lookup to the host's resolver and `runSchema.providerId` accepts
 * either spelling.
 *
 * A DELIBERATE MIRROR of `server/lib/providerRef.js`. This directory is
 * vendored and stays self-contained — no imports out to other PortOS modules
 * (see `aiToolkit/AGENTS.md`) — so the rule is duplicated rather than imported,
 * exactly as `gateways.js` and `harnesses.js` are. `server/lib/providerRef.parity.test.js`
 * fails when the two drift.
 *
 * Imports nothing.
 */

/** A preset record id — the slug `createProvider` assigns. */
export const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** `<harness>.<method>@<service-slug>[+<bootstrap-slug>]`. */
export const COMPOSITE_ID_RE = /^([a-z0-9-]+)\.(cli|tui|api)@([a-z0-9][a-z0-9-]*)(?:\+([a-z0-9][a-z0-9-]*))?$/;

/** Longest reference any selection field accepts. */
export const MAX_PROVIDER_REF_LENGTH = 200;

/** The message a PRESET-ONLY field reports when handed a composite. */
export const PRESET_ONLY_MESSAGE = 'must be a preset provider id (lowercase alphanumeric with hyphens); a composite harness.method@service selection is not accepted here';

/**
 * @param {unknown} id
 * @returns {{kind: 'preset', id: string}
 *   | {kind: 'composite', id: string, harnessId: string, method: string, serviceSlug: string, bootstrapSlug: string|null}
 *   | null}
 */
export function parseProviderRef(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_PROVIDER_REF_LENGTH) return null;
  if (PRESET_ID_RE.test(id)) return { kind: 'preset', id };
  const match = COMPOSITE_ID_RE.exec(id);
  if (!match) return null;
  const [, harnessId, method, serviceSlug, bootstrapSlug = null] = match;
  if (bootstrapSlug && method === 'api') return null;
  return { kind: 'composite', id, harnessId, method, serviceSlug, bootstrapSlug };
}

/** Whether `id` is a well-formed composite reference. */
export const isCompositeProviderId = (id) => parseProviderRef(id)?.kind === 'composite';
