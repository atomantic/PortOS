/**
 * Pure layered plan for projecting bounded PortOS signals into Eidoverse.
 *
 * No I/O happens here: identical design, source, and snapshot inputs produce
 * identical environment, infrastructure, live, ambient, and cleanup verbs.
 */

import { eidoverseCityRoofHeight, eidoverseCityTravelPod, eidoverseCityArchitecture, eidoverseCityFurniture, eidoverseCitySignalPosition, eidoverseModelPlacement, eidoverseDistrictPoint, eidoverseDistrictYaw, eidoverseDesktopHeight } from '../lib/eidoverseCityLayout.js';
import { createHash } from 'node:crypto';
import { canonicalStringify } from '../lib/objects.js';
import {
  EIDOVERSE_DISTRICTS_V2,
  EIDOVERSE_SCALAR_SOURCE_KEYS,
  EIDOVERSE_MANAGED_PREFIX,
  EIDOVERSE_MAX_LIVE_ENTITIES,
  EIDOVERSE_META_ENTITY_ID,
  EIDOVERSE_PROJECTION_PREFIX,
  EIDOVERSE_WORLD_DESIGN_V1,
  EIDOVERSE_WORLD_DESIGN_V3,
  EIDOVERSE_WORLD_DESIGN_VERSION,
  extractEidoverseDesignOverrides,
  migrateEidoverseWorldState,
  resolveEidoverseDesign,
  stableEidoverseUnit,
} from '../lib/eidoverseWorldDesign.js';
import {
  buildEidoverseLabel,
  EIDOVERSE_LABEL_COMPONENT_TYPE,
  safeWorldText,
} from '../lib/eidoverseWorldLabels.js';

const LEGACY_PROJECTION_ID_PREFIX = 'portos-projection-';
const PROJECTION_ID_PREFIX = EIDOVERSE_PROJECTION_PREFIX;
const COMPONENT_TYPE = 'portos';
const COMPONENT_RESOURCE_BY_KIND = Object.freeze({
  app: 'apps', agent: 'agents', task: 'tasks', feature: 'features', peer: 'peers',
  health: 'health', productivity: 'productivity', activity: 'activity', goal: 'goals',
  memory: 'memory', storage: 'storage', jira: 'jira', operations: 'operations',
});
export const COMPONENT_ROUTE_BY_KIND = Object.freeze({
  app: '/apps', agent: '/cos/agents', task: '/cos/tasks', feature: '/settings/features',
  peer: '/instances', health: '/cos/health', productivity: '/cos/agents',
  activity: '/cos/agents', goal: '/goals/list', memory: '/brain/memory',
  storage: '/settings/database', jira: '/goals/list', operations: '/cos/health',
});
const COMPONENT_LABEL_BY_KIND = Object.freeze({
  app: 'Managed app', agent: 'Active agent', task: 'Active task', feature: 'District feature',
  peer: 'Federated peer', health: 'PortOS health', productivity: 'Productivity summary',
  activity: 'Activity pulse', goal: 'Active goal', memory: 'Memory aggregate',
  storage: 'Data landmark', jira: 'Current work summary', operations: 'PortOS operations',
});
const DISTRICT_ASSET_SLOT = Object.freeze({
  nexus: 'nexus',
  apps: 'app',
  agents: 'agent',
  goals: 'goal',
  memory: 'memory',
  data: 'storage',
  federation: 'peer',
  activity: 'activity',
});
// Just off the nexus and clear of every nexus->district path lane, whose first
// node sits at 27% of the district anchor.
const META_ENTITY_POS = Object.freeze([-2.4, 0.08, 2.4]);
const DISTRICT_SCALE = Object.freeze({
  nexus: 1.15,
  apps: 1.1,
  agents: 1.15,
  goals: 1.35,
  memory: 0.48,
  data: 0.55,
  federation: 0.78,
  activity: 0.72,
});

export const DEFAULT_EIDOVERSE_PROJECTION_RECIPE = EIDOVERSE_WORLD_DESIGN_V3;

const shortHash = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12);

function mergeRecipe(recipe) {
  if (recipe?.version === 1) {
    return migrateEidoverseWorldState({ schemaVersion: 1, recipe }).state.recipe;
  }
  return resolveEidoverseDesign(extractEidoverseDesignOverrides(recipe), recipe?.assets || {});
}

export const EIDOVERSE_PROJECTION_KINDS = Object.freeze([
  { kind: 'app', source: 'apps', slot: 'app' },
  { kind: 'agent', source: 'agents', slot: 'agent' },
  { kind: 'task', source: 'tasks', slot: 'task' },
  { kind: 'feature', source: 'features', slot: null },
  { kind: 'peer', source: 'peers', slot: 'peer' },
  { kind: 'health', source: 'health', slot: 'activity' },
  { kind: 'productivity', source: 'productivity', slot: 'activity' },
  { kind: 'activity', source: 'activity', slot: 'activity' },
  { kind: 'goal', source: 'goals', slot: 'goal' },
  { kind: 'memory', source: 'memory', slot: 'memory' },
  { kind: 'storage', source: 'storage', slot: 'storage' },
  { kind: 'jira', source: 'jira', slot: 'goal' },
  { kind: 'operations', source: 'operations', slot: 'activity' },
]);

function sourceAvailable(source, key) {
  if (EIDOVERSE_SCALAR_SOURCE_KEYS.includes(key)) return source[key] !== null && source[key] !== undefined;
  return Array.isArray(source[key]);
}

function allocateRoundRobin(buckets, limit) {
  const selected = new Map(buckets.map(({ key }) => [key, []]));
  let count = 0;
  for (let offset = 0; count < limit; offset += 1) {
    let progressed = false;
    for (const { key, values } of buckets) {
      if (count >= limit) break;
      if (offset >= values.length) continue;
      selected.get(key).push(values[offset]);
      count += 1;
      progressed = true;
    }
    if (!progressed) break;
  }
  return selected;
}

function projectionEntityId(kind, sourceId) {
  return `${PROJECTION_ID_PREFIX}${kind}-${shortHash(`${kind}:${sourceId}`)}`;
}

function signalKindFromEntityId(id) {
  if (id.startsWith(PROJECTION_ID_PREFIX)) {
    return id.slice(PROJECTION_ID_PREFIX.length).split('-')[0];
  }
  return null;
}

function districtForSource(districts, sourceKey) {
  return districts.find(({ sources }) => sources.includes(sourceKey))
    || districts[0]
    || EIDOVERSE_DISTRICTS_V2[0];
}


function worldSignal(kind, sourceKey, item, districts) {
  const district = districtForSource(districts, sourceKey);
  const sourceIdentity = safeWorldText(item?.id, '', 160) || canonicalStringify(item);
  const resourceKey = `${kind}-${shortHash(`${kind}:${sourceIdentity}`)}`;
  const metrics = {};
  for (const [key, value] of Object.entries(item || {}).slice(0, 20)) {
    if (['id', 'label', 'status'].includes(key) || value === undefined) continue;
    if (typeof value === 'number' && Number.isFinite(value)) metrics[key] = value;
    else if (typeof value === 'boolean' || value === null) metrics[key] = value;
    else if (Array.isArray(value)) metrics[`${key}Count`] = value.length;
    else if (value && typeof value === 'object') {
      for (const [nestedKey, nestedValue] of Object.entries(value).slice(0, 8)) {
        if (typeof nestedValue === 'number' && Number.isFinite(nestedValue)) metrics[`${key}.${nestedKey}`] = nestedValue;
        else if (typeof nestedValue === 'boolean') metrics[`${key}.${nestedKey}`] = nestedValue;
      }
    }
  }
  const rawStatus = String(item?.status || '').toLowerCase();
  const errorStatus = /error|failed|unhealthy|offline|crash|blocked/.test(rawStatus);
  const attentionStatus = rawStatus === 'attention'
    || /paused|stopped|pending|unknown|not.started/.test(rawStatus)
    || Object.entries(metrics).some(([key, value]) => (
      /fail|error|alert/i.test(key) && typeof value === 'number' && value > 0
    ));
  const activeStatus = /active|running|online|healthy|success/.test(rawStatus);
  const status = errorStatus ? 'error' : (attentionStatus ? 'attention' : (activeStatus ? 'active' : 'steady'));
  const severity = status === 'error' ? 'error' : (status === 'attention' ? 'attention' : 'normal');
  return {
    schemaVersion: 1,
    managedBy: 'portos',
    designVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
    id: resourceKey,
    resourceKey,
    kind,
    resource: COMPONENT_RESOURCE_BY_KIND[kind] || kind,
    route: kind === 'peer' && item.travelAvailable ? '/eidoverse' : (COMPONENT_ROUTE_BY_KIND[kind] || '/eidoverse'),
    ...(kind === 'peer' && item.travelAvailable ? { travelPeerId: sourceIdentity, action: 'visit' } : {}),
    districtId: district.id,
    districtLabel: district.label,
    label: kind === 'peer' && item.travelAvailable ? 'Teleport pod' : (COMPONENT_LABEL_BY_KIND[kind] || 'PortOS signal'),
    status,
    severity,
    freshness: 'current',
    disclosure: 'aggregate',
    visualCue: severity === 'error'
      ? { shape: 'spike', motion: 'urgent-bob' }
      : (severity === 'attention' ? { shape: 'diamond', motion: 'pulse' } : { shape: 'ring', motion: 'steady' }),
    metrics,
  };
}

function assetPathFor(recipe, kind, slot) {
  return recipe.assets?.[kind]
    || recipe.assets?.[slot]
    || recipe.assetRecipe?.slots?.[slot]?.fallback
    || EIDOVERSE_WORLD_DESIGN_V1.assets[kind]
    || EIDOVERSE_WORLD_DESIGN_V1.assets.feature;
}

function containsConfiguredValue(current, desired) {
  if (Array.isArray(desired)) return equal(current, desired);
  if (desired && typeof desired === 'object') {
    return Boolean(current) && Object.entries(desired).every(([key, value]) => containsConfiguredValue(current[key], value));
  }
  return current === desired;
}

function containsConfiguredLight(current, desired) {
  if (!current || current.kind !== 'light') return false;
  const { id: _id, ...configuration } = desired;
  return containsConfiguredValue({
    ...current,
    keep: current.keep === true,
    // Eidoverse folds the protocol default (`day: true`) by omitting it.
    day: current.day !== false,
  }, configuration);
}

function nexusStatusLight(light, source, existing) {
  if (source.health === null || source.health === undefined) {
    return existing?.kind === 'light'
      ? {
        ...light,
        color: Number.isInteger(existing.color) ? existing.color : light.color,
        intensity: typeof existing.intensity === 'number' ? existing.intensity : light.intensity,
      }
      : light;
  }
  if (source.health.status === 'error') return { ...light, color: 0xff4d6d, intensity: 28 };
  if (source.health.status === 'attention') return { ...light, color: 0xffb86b, intensity: 25 };
  if (source.health.status === 'healthy' || source.health.status === 'active') {
    return { ...light, color: 0x65d9ff, intensity: 22 };
  }
  return { ...light, color: 0xa78bfa, intensity: 20 };
}

/**
 * The single place a `comp.label` verb is minted. Initial projection, ordinary
 * updates, and stale-resource retention all route through here, so a rendered
 * plaque can never drift from the `comp.portos` payload it describes. Returns
 * `null` when the entity already carries exactly this label, which is what
 * keeps a no-op projection from emitting label verbs.
 */
function labelOperation({ prior, id, component, layer, lib, labelContext }) {
  const { aliases, objects, recipe, assetResolutions } = labelContext;
  if (['architecture', 'furniture'].includes(component.kind)) return null;
  const label = buildEidoverseLabel(component, aliases[component.resourceKey]);
  const kind = component.kind === 'district'
    ? (component.districtId === 'nexus' ? 'operations' : null)
    : component.kind;
  const semanticSlot = component.kind === 'district'
    ? (DISTRICT_ASSET_SLOT[component.districtId] || 'district')
    : (EIDOVERSE_PROJECTION_KINDS.find((entry) => entry.kind === kind)?.slot || 'district');
  const slot = recipe.assets?.[kind] ? kind : semanticSlot;
  const resolution = assetResolutions[slot];
  objects.push({
    id, kind: component.kind,
    districtId: component.districtId || component.toDistrictId || 'nexus',
    resourceKey: component.resourceKey || null,
    route: component.route,
    ...(component.travelPeerId ? { travelPeerId: component.travelPeerId } : {}),
    ...label,
    asset: {
      path: lib,
      slot,
      // A stale retained model can differ from today's lock. Never describe
      // it as preferred/overridden using provenance for a different path.
      reason: resolution?.path === lib
        ? (resolution.userOverride ? 'user-override' : (resolution.strategy || resolution.source || 'lock'))
        : 'unresolved',
    },
  });
  if (equal(prior ?? null, label)) return null;
  return { layer, verb: 'comp', args: { id, type: EIDOVERSE_LABEL_COMPONENT_TYPE, data: label } };
}

function upsertModel({
  operations,
  labelContext,
  stateEntities,
  desiredIds,
  id,
  lib,
  pos,
  yaw = 0,
  scale = 1,
  modelSize = 2,
  normalizeModel = true,
  collide = 'box',
  component,
  motion = null,
  structure = null,
  layer = 'live',
  motionLayer = 'ambient',
}) {
  const measuredAsset = Object.values(labelContext.assetResolutions).find((asset) => asset?.path === lib);
  if (!structure && normalizeModel) ({ pos, yaw, scale } = eidoverseModelPlacement({ bounds: measuredAsset?.bounds, pos, yaw, scale, size: modelSize }));
  const existing = stateEntities[id];
  desiredIds.add(id);
  let created = 0;
  let updated = 0;
  let removed = 0;
  const respawned = !existing || existing.lib !== lib;
  if (respawned) {
    if (existing) {
      operations.push({ layer, verb: 'remove', args: { id } });
      removed += 1;
    }
    operations.push({ layer, verb: 'spawn', args: {
      id, lib, pos, yaw, scale,
      ...(collide ? { collide } : {}),
    } });
    created += 1;
  } else if (!containsConfiguredValue({
    ...existing,
    yaw: existing.yaw ?? 0,
    scale: existing.scale ?? 1,
  }, { pos, yaw, scale })) {
    operations.push({ layer, verb: 'place', args: { id, pos, yaw, scale } });
    updated += 1;
  }
  const priorComponents = respawned ? undefined : existing.comp;
  if (!equal(priorComponents?.structure ?? null, structure)) {
    operations.push({ layer, verb: 'comp', args: { id, type: 'structure', data: structure } });
    if (existing) updated += 1;
  }
  if (!equal(priorComponents?.[COMPONENT_TYPE], component)) {
    operations.push({ layer, verb: 'comp', args: { id, type: COMPONENT_TYPE, data: component } });
    if (existing) updated += 1;
  }
  const labelOp = labelOperation({ prior: priorComponents?.[EIDOVERSE_LABEL_COMPONENT_TYPE], id, component, layer, lib, labelContext });
  if (labelOp) {
    operations.push(labelOp);
    if (existing) updated += 1;
  }
  if (!equal(priorComponents?.motion ?? null, motion)) {
    operations.push({ layer: motionLayer, verb: 'comp', args: { id, type: 'motion', data: motion } });
    if (existing) updated += 1;
  }
  return { created, updated, removed };
}

function equal(valueA, valueB) {
  return canonicalStringify(valueA) === canonicalStringify(valueB);
}

// How a live signal is presented, by severity: how far it floats above its
// anchor, how much larger it renders, and how it bobs. Data, not control flow;
// a severity the table does not name presents as `normal`.
const SEVERITY_PRESENCE = Object.freeze({
  error: Object.freeze({ lift: 1.6, scale: 1.22, motion: Object.freeze({ amp: 0.5, period: 1.7 }) }),
  attention: Object.freeze({ lift: 0.7, scale: 1.1, motion: Object.freeze({ amp: 0.3, period: 2.8 }) }),
  normal: Object.freeze({ lift: 0, scale: 1, motion: Object.freeze({ amp: 0.14, period: 4.5 }) }),
});
// Kinds that keep bobbing while healthy; any other kind bobs only when its
// severity is not `normal`.
const AMBIENT_BOB_KINDS = new Set(['agent', 'activity', 'goal', 'jira', 'memory']);
// A retained stale signal drifts slower and lower than any live one. This is a
// staleness policy, not a severity, so it stays out of SEVERITY_PRESENCE.
const STALE_BOB = Object.freeze({ amp: 0.12, period: 6 });

function bobMotion(seed, { amp, period }) {
  return { type: 'bob', amp, period, phase: Number((stableEidoverseUnit(seed) * Math.PI * 2).toFixed(4)) };
}

function currentEntities(currentState) {
  return currentState?.entities && typeof currentState.entities === 'object'
    ? currentState.entities
    : {};
}

/** `upsertModel` bound to the plan context, folding its delta into the running tally. */
function upsertTallied(ctx, params) {
  const { operations, labelContext, stateEntities, desiredIds } = ctx;
  const delta = upsertModel({ operations, labelContext, stateEntities, desiredIds, ...params });
  ctx.tally.created += delta.created;
  ctx.tally.updated += delta.updated;
  ctx.tally.removed += delta.removed;
  return delta;
}

/**
 * Environment, lights, city surface, architecture, districts, paths and the
 * world-meta entity: everything that exists regardless of live signals.
 */
function projectManagedInfrastructure(ctx, { currentState, meta }) {
  const { source, effectiveRecipe, stateEntities, operations, desiredIds, districts, assetResolutions } = ctx;
  const environment = effectiveRecipe.environment;
  if (!containsConfiguredValue(currentState?.terrain, environment.terrain)) {
    operations.push({ layer: 'environment', verb: 'terrain', args: environment.terrain });
  }
  if (!containsConfiguredValue(currentState?.sky, environment.sky)) {
    operations.push({ layer: 'environment', verb: 'sky', args: environment.sky });
  }
  if (!containsConfiguredValue(currentState?.grass, environment.grass)) {
    operations.push({ layer: 'environment', verb: 'grass', args: environment.grass });
  }

  for (const authoredLight of environment.lights) {
    if (!authoredLight.id.startsWith(EIDOVERSE_MANAGED_PREFIX)) continue;
    const existing = stateEntities[authoredLight.id];
    const light = authoredLight.id === `${EIDOVERSE_MANAGED_PREFIX}light-nexus`
      ? nexusStatusLight(authoredLight, source, existing)
      : authoredLight;
    const layer = authoredLight.id === `${EIDOVERSE_MANAGED_PREFIX}light-nexus` ? 'ambient' : 'environment';
    desiredIds.add(light.id);
    if (!existing || existing.kind !== 'light') {
      if (existing) {
        operations.push({ layer, verb: 'remove', args: { id: light.id } });
        ctx.tally.removed += 1;
      }
      operations.push({ layer, verb: 'light', args: light });
      ctx.tally.created += 1;
    } else if (!containsConfiguredLight(existing, light)) {
      operations.push({ layer, verb: 'light', args: light });
      ctx.tally.updated += 1;
    }
  }

  if (effectiveRecipe.assets.citySurface) {
    upsertTallied(ctx, {
      id: `${EIDOVERSE_MANAGED_PREFIX}city-surface`, lib: effectiveRecipe.assets.citySurface,
      pos: [0, 0, 0], normalizeModel: false, collide: null,
      component: { schemaVersion: 1, managedBy: 'portos', designVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
        kind: 'architecture', districtId: 'nexus' }, layer: 'infrastructure' });
    ctx.cityEntityCount += 1;
  }
  for (const item of [...eidoverseCityArchitecture(districts), ...eidoverseCityFurniture(districts, assetResolutions)]) {
    upsertTallied(ctx, {
      id: `${EIDOVERSE_MANAGED_PREFIX}city-${item.key}`,
      lib: assetPathFor(effectiveRecipe, null, item.slot || 'task'),
      pos: item.pos, yaw: item.yaw || 0, scale: item.scale || 1, modelSize: item.size || 2, collide: item.structure ? null : 'box',
      structure: item.structure || null,
      component: { schemaVersion: 1, managedBy: 'portos', designVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
        kind: item.structure ? 'architecture' : 'furniture', districtId: item.districtId },
      layer: 'infrastructure',
    });
    ctx.cityEntityCount += 1;
  }

  for (const district of districts) {
    const id = `${EIDOVERSE_MANAGED_PREFIX}infra-${district.id}`;
    const enabledSources = district.sources.filter((key) => effectiveRecipe.includes[key]);
    const featureLimit = effectiveRecipe.limits.features ?? Number.POSITIVE_INFINITY;
    const priorAffordances = stateEntities[id]?.comp?.[COMPONENT_TYPE]?.affordances || [];
    const activeFeatureIds = effectiveRecipe.includes.features !== true
      ? []
      : (Array.isArray(source.features)
          ? source.features
            .filter((feature) => feature.enabled)
            .slice(0, featureLimit)
            .map((feature) => feature.id)
          : priorAffordances.slice(0, featureLimit));
    const featureDistricts = {
      jira: ['goals'],
      post: ['activity'],
      datadog: ['apps', 'nexus'],
      eidoverse: ['nexus'],
    };
    const affordances = activeFeatureIds.filter((featureId) => (
      featureDistricts[featureId]?.includes(district.id) || district.id === 'nexus'
    ));
    const component = {
      schemaVersion: 1,
      managedBy: 'portos',
      designVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
      kind: 'district',
      districtId: district.id,
      label: district.label,
      direction: district.direction,
      landmark: district.landmark,
      accent: district.accent,
      sources: district.sources,
      enabledSources,
      affordances,
      route: district.sources.map((sourceKey) => (
        COMPONENT_ROUTE_BY_KIND[EIDOVERSE_PROJECTION_KINDS.find((entry) => entry.source === sourceKey)?.kind]
      )).find(Boolean) || '/eidoverse',
      status: enabledSources.length ? 'active' : 'inactive',
      visualCue: enabledSources.length ? { shape: 'open', motion: 'steady' } : { shape: 'closed', motion: 'still' },
    };
    const districtSlot = DISTRICT_ASSET_SLOT[district.id] ?? 'district';
    const districtScale = DISTRICT_SCALE[district.id] ?? 1;
    upsertTallied(ctx, {
      id,
      lib: assetPathFor(effectiveRecipe, district.id === 'nexus' ? 'operations' : null, districtSlot),
      pos: eidoverseDistrictPoint(district, district.id === 'apps' ? -5 : 0,
        district.id === 'apps' ? eidoverseDesktopHeight(assetResolutions) : eidoverseCityRoofHeight(district) + 0.56 + (['agents', 'goals', 'memory'].includes(district.id) ? 0.3 : 0),
        district.id === 'apps' ? 3 : -8),
      yaw: eidoverseDistrictYaw(district) + (district.id === 'federation' ? Math.PI / 2 : 0),
      modelSize: ({ nexus: 4.5, apps: 0.7, agents: 2.5, goals: 3.2, memory: 2.4, data: 2.8, federation: 5, activity: 3.5 })[district.id] || 2,
      scale: Number((districtScale * (1 + Math.min(affordances.length, 3) * 0.035)).toFixed(3)),
      component,
      motion: ['agents', 'goals', 'memory'].includes(district.id)
        ? bobMotion(`${district.id}:motion`, {
          amp: district.id === 'goals' ? 0.28 : 0.16,
          period: district.id === 'memory' ? 5.5 : 4.2,
        })
        : null,
      layer: 'infrastructure',
    });
  }

  let pathNodeCount = 0;
  for (const path of effectiveRecipe.paths || []) {
    path.nodes.forEach((pos, index) => {
      upsertTallied(ctx, {
        id: `${EIDOVERSE_MANAGED_PREFIX}path-${path.id}-${index + 1}`,
        lib: assetPathFor(effectiveRecipe, null, 'district'),
        pos,
        yaw: 0,
        scale: 0.14,
        collide: null,
        component: {
          schemaVersion: 1,
          managedBy: 'portos',
          designVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
          kind: 'path-node',
          pathId: path.id,
          toDistrictId: path.toDistrictId,
          label: path.label,
          node: index + 1,
          route: '/eidoverse',
          status: 'active',
        },
        layer: 'infrastructure',
      });
      pathNodeCount += 1;
    });
  }

  // The world's own title, its host, and the design it was built from. Placed
  // in the managed set so reconciliation keeps it and a world reset sweeps it
  // away with every other `portos-design-v2-` entity.
  let metaEntityCount = 0;
  if (meta) {
    upsertTallied(ctx, {
      id: EIDOVERSE_META_ENTITY_ID,
      lib: assetPathFor(effectiveRecipe, null, 'district'),
      pos: META_ENTITY_POS,
      yaw: 0,
      scale: 0.2,
      collide: null,
      component: {
        schemaVersion: 1,
        managedBy: 'portos',
        designVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
        kind: 'world-meta',
        label: 'World identity',
        route: '/eidoverse',
        status: 'active',
        // World title and host identity only — never a record, a machine name,
        // an address, or a filesystem path.
        meta: {
          title: safeWorldText(meta.title, effectiveRecipe.name, 120),
          hostId: safeWorldText(meta.hostId, '', 64) || null,
        },
      },
      layer: 'infrastructure',
    });
    metaEntityCount = 1;
  }
  return { pathNodeCount, metaEntityCount };
}

/**
 * Stale and live signal buckets for the shared entity budget. Retained stale
 * entities compete for the same slots as live ones, so both are bucketed
 * together before the round-robin split.
 */
function bucketProjectionSignals(ctx, unavailableKinds) {
  const { source, effectiveRecipe, districts, stateEntities } = ctx;
  const staleCandidates = Object.keys(stateEntities)
    .map((id) => ({ id, kind: signalKindFromEntityId(id) }))
    .filter(({ kind }) => kind && unavailableKinds.has(kind))
    .sort((left, right) => left.id.localeCompare(right.id));
  const staleBuckets = EIDOVERSE_PROJECTION_KINDS
    .filter(({ kind, slot }) => unavailableKinds.has(kind) && slot)
    .map(({ kind, source: sourceKey }) => ({
      key: kind,
      kind,
      sourceKey,
      values: staleCandidates
        .filter((candidate) => candidate.kind === kind)
        .slice(0, effectiveRecipe.limits[sourceKey] ?? staleCandidates.length),
    }));

  const liveBuckets = [];
  for (const { kind, source: sourceKey, slot } of EIDOVERSE_PROJECTION_KINDS) {
    const available = sourceAvailable(source, sourceKey);
    if (!effectiveRecipe.includes[sourceKey] || !available || !slot) continue;
    const values = kind === 'health' ? [source.health] : source[sourceKey];
    const normalized = values
      .filter((item) => item && !(kind === 'peer' && item.travelAvailable))
      .map((item) => worldSignal(kind, sourceKey, item, districts));
    liveBuckets.push({
      key: kind,
      kind,
      sourceKey,
      values: normalized
        .slice(0, effectiveRecipe.limits[sourceKey] ?? normalized.length)
        .sort((left, right) => left.id.localeCompare(right.id)),
    });
  }
  const bucketsByKind = new Map([...staleBuckets, ...liveBuckets].map((bucket) => [bucket.kind, bucket]));
  const signalBuckets = EIDOVERSE_PROJECTION_KINDS
    .map(({ kind }) => bucketsByKind.get(kind))
    .filter(Boolean);
  return { staleCandidates, staleBuckets, signalBuckets };
}

// Travel destinations are infrastructure, not a capped health sample: every
// available peer gets a chamber even when the live signal budget is full.
function placeTravelPods(ctx, districtCounts) {
  const { source, effectiveRecipe, districts } = ctx;
  const travelSignals = effectiveRecipe.includes.peers && Array.isArray(source.peers)
    ? source.peers.filter((peer) => peer?.travelAvailable).map((peer) => worldSignal('peer', 'peers', peer, districts)).sort((a, b) => a.id.localeCompare(b.id))
    : [];
  for (const signal of travelSignals) {
    const district = districtForSource(districts, 'peers');
    upsertTallied(ctx, {
      id: `${EIDOVERSE_MANAGED_PREFIX}travel-${signal.resourceKey}`,
      lib: assetPathFor(effectiveRecipe, 'peer', 'peer'),
      pos: eidoverseCitySignalPosition(district, districtCounts[district.id]),
      yaw: eidoverseDistrictYaw(district), structure: eidoverseCityTravelPod(), collide: null,
      component: signal, layer: 'infrastructure' });
    ctx.cityEntityCount += 1;
    districtCounts[district.id] += 1;
  }
}

/**
 * Split the shared live-entity budget between stale and live signals and seed
 * the per-district slot counters. Travel pods are placed here, before any live
 * signal, because they take their district slots first.
 */
function allocateProjectionSignals(ctx, sourceAvailability) {
  const { source, effectiveRecipe, districts } = ctx;
  const liveEntityLimit = Math.min(
    effectiveRecipe.maxEntities ?? EIDOVERSE_MAX_LIVE_ENTITIES,
    EIDOVERSE_MAX_LIVE_ENTITIES,
  );
  const unavailableKinds = new Set(EIDOVERSE_PROJECTION_KINDS
    .filter(({ source: sourceKey }) => (
      effectiveRecipe.includes[sourceKey] && !sourceAvailable(source, sourceKey)
    ))
    .map(({ kind }) => kind));
  for (const { source: sourceKey } of EIDOVERSE_PROJECTION_KINDS) {
    sourceAvailability[sourceKey] = sourceAvailable(source, sourceKey);
  }
  const { staleCandidates, staleBuckets, signalBuckets } = bucketProjectionSignals(ctx, unavailableKinds);
  const selectedSignals = allocateRoundRobin(signalBuckets, liveEntityLimit);
  const retainedStaleCandidates = staleBuckets.flatMap(({ key }) => selectedSignals.get(key) || []);
  const retainedStaleIds = new Set(retainedStaleCandidates.map(({ id }) => id));
  const overBudgetStaleIds = new Set(staleCandidates
    .filter(({ id }) => !retainedStaleIds.has(id))
    .map(({ id }) => id));
  const districtCounts = Object.fromEntries(districts.map(({ id }) => [id, 0]));
  placeTravelPods(ctx, districtCounts);
  const droppedBySource = {};
  for (const { kind } of retainedStaleCandidates) {
    const sourceKey = EIDOVERSE_PROJECTION_KINDS.find((entry) => entry.kind === kind)?.source;
    if (!sourceKey) continue;
    const district = districtForSource(districts, sourceKey);
    districtCounts[district.id] = (districtCounts[district.id] || 0) + 1;
  }
  for (const { key, sourceKey, values } of signalBuckets) {
    const dropped = values.length - (selectedSignals.get(key)?.length || 0);
    if (dropped > 0) droppedBySource[sourceKey] = (droppedBySource[sourceKey] || 0) + dropped;
  }
  return {
    liveEntityLimit,
    unavailableKinds,
    selectedSignals,
    retainedStaleIds,
    overBudgetStaleIds,
    districtCounts,
    droppedBySource,
    liveEntityCount: retainedStaleIds.size,
  };
}

/** The stale `comp.portos` payload for a retained entity, carrying only its finite metrics. */
function staleSignalComponent({ kind, id, existing, district }) {
  const priorComponent = existing?.comp?.[COMPONENT_TYPE] || {};
  const priorMetrics = priorComponent.metrics || {};
  const resourceKey = priorComponent.managedBy === 'portos'
    && priorComponent.kind === kind
    && typeof priorComponent.resourceKey === 'string'
    ? priorComponent.resourceKey
    : `${kind}-${id.slice(`${PROJECTION_ID_PREFIX}${kind}-`.length)}`;
  return {
    schemaVersion: 1,
    managedBy: 'portos',
    designVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
    id: resourceKey,
    resourceKey,
    kind,
    resource: COMPONENT_RESOURCE_BY_KIND[kind] || kind,
    route: COMPONENT_ROUTE_BY_KIND[kind] || '/eidoverse',
    districtId: district.id,
    districtLabel: district.label,
    label: COMPONENT_LABEL_BY_KIND[kind] || 'PortOS signal',
    status: 'stale',
    severity: 'attention',
    freshness: 'stale',
    disclosure: 'aggregate',
    visualCue: { shape: 'diamond', motion: 'slow-pulse' },
    metrics: Object.fromEntries(Object.entries(priorMetrics).filter(([, value]) => (
      value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
    ))),
  };
}

/**
 * A source that is temporarily unavailable keeps the entities the budget
 * retained: they are marked stale in place and added to `desiredIds` so the
 * reconciliation pass does not remove them.
 */
function refreshUnavailableSignals(ctx, { kind, source: sourceKey }, { retainedStaleIds }) {
  const { stateEntities, operations, desiredIds, labelContext, districts } = ctx;
  const district = districtForSource(districts, sourceKey);
  for (const [id, existing] of Object.entries(stateEntities)) {
    if (!id.startsWith(`${PROJECTION_ID_PREFIX}${kind}-`)) continue;
    if (!retainedStaleIds.has(id)) continue;
    desiredIds.add(id);
    if (kind === 'app') {
      const deskId = `${EIDOVERSE_MANAGED_PREFIX}city-desk-${id.slice(PROJECTION_ID_PREFIX.length)}`;
      if (stateEntities[deskId]) { desiredIds.add(deskId); ctx.cityEntityCount += 1; }
    }
    const staleComponent = staleSignalComponent({ kind, id, existing, district });
    if (!equal(existing?.comp?.[COMPONENT_TYPE], staleComponent)) {
      operations.push({ layer: 'live', verb: 'comp', args: { id, type: COMPONENT_TYPE, data: staleComponent } });
      ctx.tally.updated += 1;
    }
    const staleLabelOp = labelOperation({
      prior: existing?.comp?.[EIDOVERSE_LABEL_COMPONENT_TYPE],
      id,
      component: staleComponent,
      layer: 'live',
      lib: existing.lib,
      labelContext,
    });
    if (staleLabelOp) {
      operations.push(staleLabelOp);
      ctx.tally.updated += 1;
    }
    const staleMotion = kind === 'app' ? null : bobMotion(`${id}:stale`, STALE_BOB);
    if (!equal(existing?.comp?.motion ?? null, staleMotion)) {
      operations.push({ layer: 'ambient', verb: 'comp', args: { id, type: 'motion', data: staleMotion } });
      ctx.tally.updated += 1;
    }
  }
}

function placeAppDesk(ctx, { id, district, pos }) {
  upsertTallied(ctx, {
    id: `${EIDOVERSE_MANAGED_PREFIX}city-desk-${id.slice(PROJECTION_ID_PREFIX.length)}`,
    lib: assetPathFor(ctx.effectiveRecipe, null, 'desk'), pos: [...pos],
    yaw: eidoverseDistrictYaw(district), modelSize: 2.25,
    component: { schemaVersion: 1, managedBy: 'portos', designVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
      kind: 'furniture', districtId: district.id }, layer: 'live' });
  ctx.cityEntityCount += 1;
}

// Goal progress raises the model; severity lifts everything except apps, which
// sit on their desks. Applied in this order so the float sum is stable.
function liftSignalPosition(pos, kind, signal, presence) {
  if (kind === 'goal' && typeof signal.metrics.progress === 'number') {
    pos[1] += 1.5 + Math.max(0, Math.min(100, signal.metrics.progress)) * 0.055;
  }
  if (kind !== 'app') pos[1] += presence.lift;
}

function signalMoves(kind, signal) {
  return kind !== 'app' && (signal.severity !== 'normal' || AMBIENT_BOB_KINDS.has(kind));
}

/** Spawn or update the budgeted live signals of one available source kind. */
function placeLiveSignals(ctx, { kind, source: sourceKey, slot }, allocation) {
  const { effectiveRecipe, districts, assetResolutions } = ctx;
  const { districtCounts } = allocation;
  const isApp = kind === 'app';
  for (const signal of allocation.selectedSignals.get(kind) || []) {
    const id = projectionEntityId(kind, signal.id);
    const district = districtForSource(districts, sourceKey);
    const pos = eidoverseCitySignalPosition(district, districtCounts[district.id], isApp);
    if (isApp) {
      placeAppDesk(ctx, { id, district, pos });
      pos[1] += eidoverseDesktopHeight(assetResolutions) - 0.1;
    }
    const presence = SEVERITY_PRESENCE[signal.severity] ?? SEVERITY_PRESENCE.normal;
    liftSignalPosition(pos, kind, signal, presence);
    const scaleVariation = 0.92 + stableEidoverseUnit(`${signal.id}:scale`) * 0.16;
    upsertTallied(ctx, {
      id,
      lib: assetPathFor(effectiveRecipe, kind, slot),
      pos,
      yaw: eidoverseDistrictYaw(district),
      modelSize: isApp ? 0.7 : 1.5,
      scale: Number(((effectiveRecipe.scale[kind] || 1) * scaleVariation * presence.scale).toFixed(3)),
      component: signal,
      motion: signalMoves(kind, signal) ? bobMotion(`${signal.id}:motion`, presence.motion) : null,
      layer: 'live',
    });
    allocation.liveEntityCount += 1;
    districtCounts[signal.districtId] += 1;
  }
}

/**
 * Remove every managed entity the plan no longer wants. A retained stale
 * entity is wanted (it is in `desiredIds`); an unavailable-kind entity the
 * budget dropped is not, and an unavailable-kind entity that was never
 * budgeted at all is left alone.
 */
function reconcileAbsentEntities(ctx, { unavailableKinds, overBudgetStaleIds }) {
  for (const id of Object.keys(ctx.stateEntities)) {
    const isCurrentManaged = id.startsWith(EIDOVERSE_MANAGED_PREFIX);
    const isLegacyManaged = id.startsWith(LEGACY_PROJECTION_ID_PREFIX);
    if ((!isCurrentManaged && !isLegacyManaged) || ctx.desiredIds.has(id)) continue;
    const kind = signalKindFromEntityId(id);
    if (kind && unavailableKinds.has(kind) && !overBudgetStaleIds.has(id)) continue;
    ctx.operations.push({ layer: 'reconciliation', verb: 'remove', args: { id } });
    ctx.tally.removed += 1;
  }
}

/**
 * Build the deterministic world operations without opening a socket. This is
 * intentionally exported so recipe changes can be tested without a live
 * Eidoverse process and so future renderers can reuse the same projection.
 *
 * The recipe order is load-bearing: `desiredIds` is filled by every earlier
 * step and read by the final removal pass.
 */
export function buildProjectionPlan({ source = {}, recipe = DEFAULT_EIDOVERSE_PROJECTION_RECIPE, currentState = {}, meta = null, labelAliases = {}, assetResolutions = {} }) {
  const effectiveRecipe = mergeRecipe(recipe);
  const objects = [];
  const ctx = {
    source,
    effectiveRecipe,
    assetResolutions,
    labelContext: { aliases: labelAliases, objects, recipe: effectiveRecipe, assetResolutions },
    stateEntities: currentEntities(currentState),
    operations: [],
    desiredIds: new Set(),
    districts: Array.isArray(effectiveRecipe.districts) && effectiveRecipe.districts.length
      ? effectiveRecipe.districts
      : EIDOVERSE_DISTRICTS_V2,
    tally: { created: 0, updated: 0, removed: 0 },
    cityEntityCount: 0,
  };
  const sourceAvailability = { environment: true };

  const { pathNodeCount, metaEntityCount } = projectManagedInfrastructure(ctx, { currentState, meta });
  const allocation = allocateProjectionSignals(ctx, sourceAvailability);
  // One pass per source kind: an unavailable source refreshes what it retains,
  // an available one places its live signals, in kind order.
  for (const entry of EIDOVERSE_PROJECTION_KINDS) {
    if (!effectiveRecipe.includes[entry.source]) continue;
    if (!sourceAvailable(source, entry.source)) refreshUnavailableSignals(ctx, entry, allocation);
    else if (entry.slot) placeLiveSignals(ctx, entry, allocation);
  }
  reconcileAbsentEntities(ctx, allocation);

  const { operations, tally, districts } = ctx;
  const { droppedBySource } = allocation;
  return {
    operations,
    summary: {
      objects,
      created: tally.created,
      updated: tally.updated,
      removed: tally.removed,
      operationCount: operations.length,
      designVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
      liveEntityCount: allocation.liveEntityCount,
      maxLiveEntities: allocation.liveEntityLimit,
      infrastructureCount: districts.length + pathNodeCount + metaEntityCount + ctx.cityEntityCount,
      districtCounts: allocation.districtCounts,
      sourceAvailability,
      truncated: Object.keys(droppedBySource).length > 0,
      droppedBySource,
      sourceCounts: Object.fromEntries(EIDOVERSE_PROJECTION_KINDS.map(({ kind, source: sourceKey }) => [
        sourceKey,
        sourceAvailable(source, sourceKey)
          ? (kind === 'health' ? 1 : source[sourceKey].length)
          : null,
      ])),
    },
  };
}
