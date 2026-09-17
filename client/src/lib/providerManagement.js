/**
 * Reading the provider connection graph honestly (#6369 → #7567).
 *
 * What is left of the Backend Connections drawer's helpers after the AI
 * Providers page absorbed that drawer into its Services view: a connection is
 * a service instance, and the one reading both surfaces share is how its
 * catalog state is described. Everything about bindings, route overrides and
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
