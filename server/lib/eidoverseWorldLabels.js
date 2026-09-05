/**
 * Human-readable labels for the entities PortOS projects into Eidoverse.
 *
 * A projected building renders, but a model file cannot say what it stands for.
 * `buildEidoverseLabel` turns one already-built `comp.portos` payload into the
 * renderer-generic `comp.label` component (eidoverse-worlds#5), so the initial
 * projection, ordinary updates, and stale-resource retention all derive the
 * same text from the same place instead of each inventing its own.
 *
 * Every string here is generated from PortOS's own vocabulary — district and
 * kind names, coarse status, freshness — plus an opaque hashed resource ref.
 * Raw private records never supply names; explicit user-authored aliases are
 * the sole opt-in exception to generic names in the append-only world log, and a label describes what an object
 * represents rather than the decorative asset standing in for it.
 */

export const EIDOVERSE_LABEL_COMPONENT_TYPE = 'label';
export const EIDOVERSE_LABEL_VISIBILITIES = Object.freeze(['always', 'nearby', 'inspect']);
export const EIDOVERSE_LABEL_ALIAS_KEY = /^(?:app|agent|task|feature|peer|health|productivity|activity|goal|memory|storage|jira|operations)-[0-9a-f]{12}$/;

/** Only explicit display aliases belong here; never infer one from a record. */
export function normalizeEidoverseLabelAliases(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, alias]) => EIDOVERSE_LABEL_ALIAS_KEY.test(key) && typeof alias === 'string')
    .slice(0, 128)
    .map(([key, alias]) => [key, safeWorldText(alias, '', 72)])
    .filter(([, alias]) => alias));
}

/** Feature versions, independent of the checkout SHA and world-design version. */
export function eidoverseLabelCapabilities(version) {
  return Object.fromEntries(['objectLabels', 'portosNavigation', 'labelPreferences']
    .map((key) => [key, version?.capabilities?.[key] === 1 ? 1 : null]));
}

const MAX_NAME_CHARS = 72;
const MAX_DESCRIPTION_CHARS = 240;
// Omit a fixed offset: the optional renderer anchors labels to actual geometry.

/**
 * The one sanitizer for text PortOS writes into a world: control characters
 * out, trimmed, hard length cap. Shared with the projector so a component field
 * and the label built from it can never disagree about what is safe.
 */
export function safeWorldText(value, fallback = '', max = 160) {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean ? clean.slice(0, max) : fallback;
}

// What a projected indicator stands for, in category terms only. These are
// PortOS's own words for its own feature areas — never a record's own name.
const RESOURCE_MEANING = Object.freeze({
  apps: 'an app this install manages',
  agents: 'a Chief of Staff agent run',
  tasks: 'a scheduled or queued task',
  features: 'an optional instance feature',
  peers: 'a federated PortOS peer',
  health: 'the install-wide health rollup',
  productivity: 'the productivity queue rollup',
  activity: 'a recent activity pulse',
  goals: 'a tracked goal',
  memory: 'a memory-store aggregate',
  storage: 'a datastore rollup',
  jira: 'a current-work rollup',
  operations: 'the operations rollup',
});

const FRESHNESS_PHRASE = Object.freeze({
  current: 'data is current',
  stale: 'data is stale because its source is unavailable',
});

/** Opaque disambiguator so two indicators of one kind are tellable apart. */
function resourceRef(resourceKey) {
  const hash = safeWorldText(resourceKey, '', 64).split('-').pop() || '';
  return /^[0-9a-f]{6,}$/.test(hash) ? hash.slice(0, 6) : '';
}

function label({ name, description, visibility, offset }) {
  const safeName = safeWorldText(name, '', MAX_NAME_CHARS);
  if (!safeName) return null;
  const safeDescription = safeWorldText(description, '', MAX_DESCRIPTION_CHARS);
  return {
    name: safeName,
    ...(safeDescription ? { description: safeDescription } : {}),
    visibility,
    ...(offset ? { offset: [...offset] } : {}),
  };
}

function districtLabel(component) {
  const enabled = Array.isArray(component.enabledSources) ? component.enabledSources : [];
  return label({
    name: component.label,
    description: `${[
      `PortOS ${safeWorldText(component.direction, 'central', 40).toLowerCase()} district`,
      `landmark: ${safeWorldText(component.landmark, 'district marker', 60)}`,
      enabled.length ? `projecting ${enabled.join(', ')}` : 'no sources enabled',
    ].join('. ')}.`,
    visibility: 'always',
  });
}

function pathNodeLabel(component) {
  const route = safeWorldText(component.label, 'district walkway', MAX_NAME_CHARS);
  return label({
    name: route,
    description: `Walkway marker ${component.node} on the ${route} route.`,
    // Path markers are numerous and tiny; a floating plaque on each would bury
    // the districts they lead to, so they answer only when inspected.
    visibility: 'inspect',
  });
}

function worldMetaLabel(component) {
  return label({
    name: component.meta?.title,
    description: 'This world is projected by PortOS. Every landmark and indicator in it is generated from aggregate signals, never from record contents.',
    visibility: 'always',
  });
}

function signalLabel(component) {
  const ref = resourceRef(component.resourceKey);
  const kindLabel = safeWorldText(component.label, 'PortOS signal', 48);
  const meaning = RESOURCE_MEANING[component.resource] || 'a PortOS signal';
  const freshness = FRESHNESS_PHRASE[component.freshness]
    || `data is ${safeWorldText(component.freshness, 'unknown', 24)}`;
  return label({
    name: ref ? `${kindLabel} ${ref}` : kindLabel,
    description: `${[
      `In ${safeWorldText(component.districtLabel, 'the PortOS Nexus', 64)}: ${meaning}`,
      'aggregate counts only, no record names',
      `status is ${safeWorldText(component.status, 'unknown', 24)} and ${freshness}`,
    ].join('. ')}.`,
    visibility: 'nearby',
  });
}

const LABEL_BUILDERS = Object.freeze({
  district: districtLabel,
  'path-node': pathNodeLabel,
  'world-meta': worldMetaLabel,
});

/**
 * Build the `comp.label` payload for a PortOS-owned entity from the
 * `comp.portos` component already computed for it. Returns `null` for anything
 * PortOS does not own, so a caller can never label somebody else's entity.
 */
export function buildEidoverseLabel(component, alias) {
  if (!component || component.managedBy !== 'portos') return null;
  const result = (LABEL_BUILDERS[component.kind] || signalLabel)(component);
  const name = EIDOVERSE_LABEL_ALIAS_KEY.test(component.resourceKey || '')
    ? safeWorldText(alias, '', MAX_NAME_CHARS)
    : '';
  return result && name ? { ...result, name } : result;
}
