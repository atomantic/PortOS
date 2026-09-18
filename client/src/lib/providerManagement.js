/**
 * Reading the provider connection graph honestly (#6369 → #7567).
 *
 * What is left of the Backend Connections drawer's helpers after the AI
 * Providers page absorbed that drawer into its Services view: a connection is
 * a service instance, and what every surface shares is how its catalog state
 * and readiness are described and how its transports round-trip a form. Everything about bindings, route overrides and
 * model aliases went with the drawer — a preset names its service outright
 * (`serviceId`), and a preset's own settings live on the preset editor.
 */

/**
 * How to describe a connection's catalog, keeping the three states distinct.
 *
 * `known` with zero models is a real answer from a backend with no models
 * installed; `unknown` is "never asked"; `failed` keeps the models it already
 * had. Collapsing any two of those into "0 models" is the exact bug the catalog
 * state field exists to prevent.
 */
export function catalogSummary(catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  if (catalog?.state === 'failed') {
    return {
      tone: 'error',
      text: models.length > 0
        ? `Last refresh failed — showing ${models.length} previously known model${models.length === 1 ? '' : 's'}`
        : 'Last refresh failed — no models known yet',
      detail: catalog.error || null,
    };
  }
  if (catalog?.state === 'known') {
    return {
      tone: models.length > 0 ? 'ok' : 'warn',
      text: models.length > 0
        ? `${models.length} model${models.length === 1 ? '' : 's'}`
        : 'No models installed on this backend',
      detail: null,
    };
  }
  return { tone: 'muted', text: 'Not refreshed yet', detail: null };
}

/**
 * One phrasing per service `readiness` value (`server/lib/providerServiceInstances.js`),
 * for every surface that names it: the Services card badge (`tone` + `label`),
 * the compose popover's readiness line and the compatibility matrix's blocked
 * reason (`reason`, a predicate that follows the service's name). A value this
 * build does not know reads as itself rather than as "no definition".
 */
export const SERVICE_READINESS_COPY = Object.freeze({
  ready: { tone: 'success', label: 'Ready', reason: 'ready to run' },
  'needs-credential': { tone: 'warning', label: 'Needs a credential', reason: 'needs a credential' },
  'needs-endpoint': { tone: 'warning', label: 'Needs an endpoint', reason: 'needs an endpoint' },
  disabled: { tone: 'muted', label: 'Switched off', reason: 'is switched off' },
  'unknown-definition': { tone: 'muted', label: 'No definition', reason: 'has no definition' },
});

export const serviceReadinessCopy = (readiness) => SERVICE_READINESS_COPY[readiness]
  || { tone: 'muted', label: readiness || 'Unknown', reason: readiness ? `is ${readiness}` : 'has an unknown readiness' };

/** A service's `transports` map as flat text a form edits, and back to the wire shape (blank = not declared). */
export const draftFromTransports = (transports) => Object.fromEntries(
  Object.entries(transports || {}).map(([protocol, value]) => [protocol, value?.baseUrl || '']),
);

export const transportsFromDraft = (draft) => Object.fromEntries(
  Object.entries(draft || {})
    .filter(([, baseUrl]) => String(baseUrl).trim().length > 0)
    .map(([protocol, baseUrl]) => [protocol, { baseUrl: String(baseUrl).trim() }]),
);
