/**
 * Pure layered plan for projecting bounded PortOS signals into Eidoverse.
 *
 * No I/O happens here: identical design, source, and snapshot inputs produce
 * identical environment, infrastructure, live, ambient, and cleanup verbs.
 */

import { createHash } from 'node:crypto';
import { canonicalStringify } from '../lib/objects.js';
import {
  EIDOVERSE_DISTRICTS_V2,
  EIDOVERSE_MANAGED_PREFIX,
  EIDOVERSE_MAX_LIVE_ENTITIES,
  EIDOVERSE_META_ENTITY_ID,
  EIDOVERSE_PROJECTION_PREFIX,
  EIDOVERSE_WORLD_DESIGN_V1,
  EIDOVERSE_WORLD_DESIGN_V2,
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
const COMPONENT_ROUTE_BY_KIND = Object.freeze({
  app: '/apps', agent: '/cos/agents', task: '/cos/tasks', feature: '/settings/features',
  peer: '/instances', health: '/cos/health', productivity: '/cos/productivity',
  activity: '/cos/productivity', goal: '/goals/list', memory: '/brain/memory',
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
const META_ENTITY_POS = Object.freeze([2.4, 0.08, 2.4]);
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

export const DEFAULT_EIDOVERSE_PROJECTION_RECIPE = EIDOVERSE_WORLD_DESIGN_V2;

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
  if (key === 'health') return source.health !== null && source.health !== undefined;
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

function entityPosition(sourceId, sourceKey, districts) {
  const district = districtForSource(districts, sourceKey);
  if (district.id === 'activity') {
    const along = (stableEidoverseUnit(`${district.id}:${sourceId}:along`) * 2 - 1) * 9;
    const bend = Math.sin(along / 4.5) * 1.8;
    return [
      Number((district.anchor[0] + along).toFixed(2)),
      district.anchor[1] + 0.2,
      Number((district.anchor[2] + bend).toFixed(2)),
    ];
  }
  const angle = stableEidoverseUnit(`${district.id}:${sourceId}:angle`) * Math.PI * 2;
  const radius = 5.5 + stableEidoverseUnit(`${district.id}:${sourceId}:radius`) * 7.5;
  return [
    Number((district.anchor[0] + Math.cos(angle) * radius).toFixed(2)),
    district.anchor[1],
    Number((district.anchor[2] + Math.sin(angle) * radius).toFixed(2)),
  ];
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
    route: COMPONENT_ROUTE_BY_KIND[kind] || '/eidoverse',
    districtId: district.id,
    districtLabel: district.label,
    label: COMPONENT_LABEL_BY_KIND[kind] || 'PortOS signal',
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
function labelOperation({ prior, id, component, layer }) {
  const label = buildEidoverseLabel(component);
  if (equal(prior ?? null, label)) return null;
  return { layer, verb: 'comp', args: { id, type: EIDOVERSE_LABEL_COMPONENT_TYPE, data: label } };
}

function upsertModel({
  operations,
  stateEntities,
  desiredIds,
  id,
  lib,
  pos,
  yaw = 0,
  scale = 1,
  collide = 'box',
  component,
  motion = null,
  layer = 'live',
  motionLayer = 'ambient',
}) {
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
  if (!equal(priorComponents?.[COMPONENT_TYPE], component)) {
    operations.push({ layer, verb: 'comp', args: { id, type: COMPONENT_TYPE, data: component } });
    if (existing) updated += 1;
  }
  const labelOp = labelOperation({ prior: priorComponents?.[EIDOVERSE_LABEL_COMPONENT_TYPE], id, component, layer });
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

/**
 * Build the deterministic world operations without opening a socket. This is
 * intentionally exported so recipe changes can be tested without a live
 * Eidoverse process and so future renderers can reuse the same projection.
 */
export function buildProjectionPlan({ source = {}, recipe = DEFAULT_EIDOVERSE_PROJECTION_RECIPE, currentState = {}, meta = null }) {
  const effectiveRecipe = mergeRecipe(recipe);
  const stateEntities = currentState?.entities && typeof currentState.entities === 'object'
    ? currentState.entities
    : {};
  const operations = [];
  const desiredIds = new Set();
  const sourceAvailability = {};
  let created = 0;
  let updated = 0;
  let removed = 0;

  const environment = effectiveRecipe.environment;
  const districts = Array.isArray(effectiveRecipe.districts) && effectiveRecipe.districts.length
    ? effectiveRecipe.districts
    : EIDOVERSE_DISTRICTS_V2;
  sourceAvailability.environment = true;
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
        removed += 1;
      }
      operations.push({ layer, verb: 'light', args: light });
      created += 1;
    } else if (!containsConfiguredLight(existing, light)) {
      operations.push({ layer, verb: 'light', args: light });
      updated += 1;
    }
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
    const delta = upsertModel({
      operations,
      stateEntities,
      desiredIds,
      id,
      lib: assetPathFor(effectiveRecipe, district.id === 'nexus' ? 'operations' : null, districtSlot),
      pos: district.anchor,
      yaw: stableEidoverseUnit(`${district.id}:yaw`) * Math.PI * 2,
      scale: Number((districtScale * (1 + Math.min(affordances.length, 3) * 0.035)).toFixed(3)),
      component,
      motion: ['agents', 'goals', 'memory'].includes(district.id)
        ? {
          type: 'bob',
          amp: district.id === 'goals' ? 0.28 : 0.16,
          period: district.id === 'memory' ? 5.5 : 4.2,
          phase: Number((stableEidoverseUnit(`${district.id}:motion`) * Math.PI * 2).toFixed(4)),
        }
        : null,
      layer: 'infrastructure',
    });
    created += delta.created;
    updated += delta.updated;
    removed += delta.removed;
  }

  let pathNodeCount = 0;
  for (const path of effectiveRecipe.paths || []) {
    path.nodes.forEach((pos, index) => {
      const id = `${EIDOVERSE_MANAGED_PREFIX}path-${path.id}-${index + 1}`;
      const delta = upsertModel({
        operations,
        stateEntities,
        desiredIds,
        id,
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
      created += delta.created;
      updated += delta.updated;
      removed += delta.removed;
      pathNodeCount += 1;
    });
  }

  // The world's own title, its host, and the design it was built from. Placed
  // in the managed set so reconciliation keeps it and a world reset sweeps it
  // away with every other `portos-design-v2-` entity.
  let metaEntityCount = 0;
  if (meta) {
    const delta = upsertModel({
      operations,
      stateEntities,
      desiredIds,
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
    created += delta.created;
    updated += delta.updated;
    removed += delta.removed;
    metaEntityCount = 1;
  }

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
      .filter(Boolean)
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
  const selectedSignals = allocateRoundRobin(signalBuckets, liveEntityLimit);
  const retainedStaleCandidates = staleBuckets.flatMap(({ key }) => selectedSignals.get(key) || []);
  const retainedStaleIds = new Set(retainedStaleCandidates.map(({ id }) => id));
  const overBudgetStaleIds = new Set(staleCandidates
    .filter(({ id }) => !retainedStaleIds.has(id))
    .map(({ id }) => id));
  let liveEntityCount = retainedStaleIds.size;
  const districtCounts = Object.fromEntries(districts.map(({ id }) => [id, 0]));
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

  for (const { kind, source: sourceKey, slot } of EIDOVERSE_PROJECTION_KINDS) {
    const available = sourceAvailable(source, sourceKey);
    if (!effectiveRecipe.includes[`${sourceKey}`]) {
      continue;
    }
    if (!available) {
      for (const [id, existing] of Object.entries(stateEntities)) {
        if (!id.startsWith(`${PROJECTION_ID_PREFIX}${kind}-`)) continue;
        if (!retainedStaleIds.has(id)) continue;
        desiredIds.add(id);
        const priorComponent = existing?.comp?.[COMPONENT_TYPE] || {};
        const priorMetrics = priorComponent.metrics || {};
        const district = districtForSource(districts, sourceKey);
        const resourceKey = priorComponent.managedBy === 'portos'
          && priorComponent.kind === kind
          && typeof priorComponent.resourceKey === 'string'
          ? priorComponent.resourceKey
          : `${kind}-${id.slice(`${PROJECTION_ID_PREFIX}${kind}-`.length)}`;
        const staleComponent = {
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
        if (!equal(existing?.comp?.[COMPONENT_TYPE], staleComponent)) {
          operations.push({ layer: 'live', verb: 'comp', args: { id, type: COMPONENT_TYPE, data: staleComponent } });
          updated += 1;
        }
        const staleLabelOp = labelOperation({
          prior: existing?.comp?.[EIDOVERSE_LABEL_COMPONENT_TYPE],
          id,
          component: staleComponent,
          layer: 'live',
        });
        if (staleLabelOp) {
          operations.push(staleLabelOp);
          updated += 1;
        }
        const staleMotion = {
          type: 'bob', amp: 0.12, period: 6,
          phase: Number((stableEidoverseUnit(`${id}:stale`) * Math.PI * 2).toFixed(4)),
        };
        if (!equal(existing?.comp?.motion ?? null, staleMotion)) {
          operations.push({ layer: 'ambient', verb: 'comp', args: { id, type: 'motion', data: staleMotion } });
          updated += 1;
        }
      }
      continue;
    }
    if (!slot) continue;
    for (const signal of selectedSignals.get(kind) || []) {
      const id = projectionEntityId(kind, signal.id);
      const pos = entityPosition(signal.id, sourceKey, districts);
      if (kind === 'goal' && typeof signal.metrics.progress === 'number') {
        pos[1] += 1.5 + Math.max(0, Math.min(100, signal.metrics.progress)) * 0.055;
      }
      const scaleVariation = 0.92 + stableEidoverseUnit(`${signal.id}:scale`) * 0.16;
      const statusScale = signal.severity === 'error' ? 1.22 : (signal.severity === 'attention' ? 1.1 : 1);
      if (signal.severity === 'error') pos[1] += 1.6;
      else if (signal.severity === 'attention') pos[1] += 0.7;
      const shouldMove = signal.severity !== 'normal' || ['agent', 'activity', 'goal', 'jira', 'memory'].includes(kind);
      const delta = upsertModel({
        operations,
        stateEntities,
        desiredIds,
        id,
        lib: assetPathFor(effectiveRecipe, kind, slot),
        pos,
        yaw: stableEidoverseUnit(`${signal.id}:yaw`) * Math.PI * 2,
        scale: Number(((effectiveRecipe.scale[kind] || 1) * scaleVariation * statusScale).toFixed(3)),
        component: signal,
        motion: shouldMove ? {
          type: 'bob',
          amp: signal.severity === 'error' ? 0.5 : (signal.severity === 'attention' ? 0.3 : 0.14),
          period: signal.severity === 'error' ? 1.7 : (signal.severity === 'attention' ? 2.8 : 4.5),
          phase: Number((stableEidoverseUnit(`${signal.id}:motion`) * Math.PI * 2).toFixed(4)),
        } : null,
        layer: 'live',
      });
      created += delta.created;
      updated += delta.updated;
      removed += delta.removed;
      liveEntityCount += 1;
      districtCounts[signal.districtId] += 1;
    }
  }

  for (const id of Object.keys(stateEntities)) {
    const isCurrentManaged = id.startsWith(EIDOVERSE_MANAGED_PREFIX);
    const isLegacyManaged = id.startsWith(LEGACY_PROJECTION_ID_PREFIX);
    if ((!isCurrentManaged && !isLegacyManaged) || desiredIds.has(id)) continue;
    const kind = signalKindFromEntityId(id);
    if (kind && unavailableKinds.has(kind) && !overBudgetStaleIds.has(id)) continue;
    operations.push({ layer: 'reconciliation', verb: 'remove', args: { id } });
    removed += 1;
  }

  return {
    operations,
    summary: {
      created,
      updated,
      removed,
      operationCount: operations.length,
      designVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
      liveEntityCount,
      maxLiveEntities: liveEntityLimit,
      infrastructureCount: districts.length + pathNodeCount + metaEntityCount,
      districtCounts,
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
