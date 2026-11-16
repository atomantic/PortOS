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

/**
 * How the Services view groups a definition (#8014). The instance's selected
 * plan stays a separate fact (the plan pill): a definition that offers both
 * free and paid is "Free + paid" whichever plan this instance declared, and a
 * local or subscription service is classified by family so an account-backed
 * row is never filed under free just because its plan string says so.
 * `other` keeps a missing definition or a shape these rules cannot name visible.
 */
export const SERVICE_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'free-only', label: 'Free only' }),
  Object.freeze({ id: 'paid-only', label: 'Paid only' }),
  Object.freeze({ id: 'free-and-paid', label: 'Free + paid' }),
  Object.freeze({ id: 'local', label: 'Local' }),
  Object.freeze({ id: 'subscriptions', label: 'Subscriptions' }),
  Object.freeze({ id: 'other', label: 'Other/legacy' }),
]);

export const serviceCategoryById = (id) => SERVICE_CATEGORIES.find((category) => category.id === id) || SERVICE_CATEGORIES[SERVICE_CATEGORIES.length - 1];

export function classifyServiceCategory(service) {
  const definition = service?.definition;
  if (!definition || typeof definition !== 'object') return 'other';
  if (definition.family === 'local') return 'local';
  if (definition.family === 'subscription') return 'subscriptions';
  const plans = Array.isArray(definition.plans) ? definition.plans : null;
  if (!plans) return 'other';
  const hasFree = plans.includes('free');
  const hasPaid = plans.includes('paid');
  if (hasFree && hasPaid) return 'free-and-paid';
  if (hasPaid) return 'paid-only';
  if (hasFree) return 'free-only';
  if (plans.includes('subscription')) return 'subscriptions';
  return 'other';
}

/** Case-insensitive search over the service's own label/slug and its definition. */
export function serviceMatchesQuery(service, query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle) return true;
  const definition = service?.definition;
  const haystack = [service?.label, service?.slug, service?.id, definition?.label, definition?.id, definition?.family]
    .filter((part) => part != null && String(part).length > 0)
    .join('\n')
    .toLocaleLowerCase();
  return haystack.includes(needle);
}

// Ready first, then the states a user can still fix, then switched off and
// unknown. Anything this build does not rank sorts after those, and name then
// slug break every tie so equal rows cannot swap between renders.
const READINESS_SORT_RANK = Object.freeze({
  ready: 0,
  'needs-credential': 1,
  'needs-endpoint': 2,
  disabled: 3,
  'unknown-definition': 4,
});

const serviceSortName = (service) => String(service?.label || service?.slug || service?.id || '').toLocaleLowerCase();
const serviceSortSlug = (service) => String(service?.slug || service?.id || '').toLocaleLowerCase();

const compareServiceName = (a, b) => serviceSortName(a).localeCompare(serviceSortName(b))
  || serviceSortSlug(a).localeCompare(serviceSortSlug(b));

/**
 * `name` is A→Z. `readiness` puts what can run first. `presets` puts the
 * busiest instance first. Name, then slug, is the tie-break for every mode
 * (including `name` itself, where the slug splits two equal labels).
 */
export function sortServices(services, sort, presetCountOf = () => 0) {
  const list = Array.isArray(services) ? [...services] : [];
  list.sort((a, b) => {
    if (sort === 'readiness') {
      const rankA = READINESS_SORT_RANK[a?.readiness] ?? Number.MAX_SAFE_INTEGER;
      const rankB = READINESS_SORT_RANK[b?.readiness] ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
    } else if (sort === 'presets') {
      const countA = Number(presetCountOf(a)) || 0;
      const countB = Number(presetCountOf(b)) || 0;
      if (countA !== countB) return countB - countA;
    }
    return compareServiceName(a, b);
  });
  return list;
}

/**
 * Whether a service card may open the compose flow. The button stays visible
 * either way; `label` is its accessible name, including why a click would not
 * start a preset. Readiness other than `ready` (switched off, missing key or
 * endpoint, no definition) is not composable — opening the composer must not
 * be the thing that discovers that.
 */
export function servicePresetAction(service) {
  const name = service?.label || service?.slug || service?.id || 'this service';
  if (!service?.definition) {
    return { enabled: false, label: `Cannot create a preset from ${name}: it has no definition to compose from` };
  }
  if (service.enabled === false || service.readiness === 'disabled') {
    return { enabled: false, label: `Cannot create a preset from ${name}: it is switched off` };
  }
  if (service.readiness !== 'ready') {
    return { enabled: false, label: `Cannot create a preset from ${name}: it ${serviceReadinessCopy(service.readiness).reason}` };
  }
  return { enabled: true, label: `Create preset from ${name}` };
}
