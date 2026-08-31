/**
 * Versioned, install-portable PortOS world design contract for Eidoverse.
 *
 * PortOS ships only this small recipe. Eidoverse keeps the model library and
 * cached bytes; each PortOS install resolves the recipe once and persists the
 * resulting paths in its machine-local world state.
 */

import { createHash } from 'node:crypto';
import { canonicalStringify, deepMerge } from './objects.js';

export const EIDOVERSE_WORLD_STATE_SCHEMA_VERSION = 2;
export const EIDOVERSE_WORLD_DESIGN_VERSION = 2;
export const EIDOVERSE_ASSET_RECIPE_VERSION = 2;
export const EIDOVERSE_MAX_LIVE_ENTITIES = 48;
export const EIDOVERSE_LIBRARY_MODEL_ROOT = 'eidoverse/assets/models/';
export const EIDOVERSE_MANAGED_PREFIX = 'portos-design-v2-';
export const EIDOVERSE_PROJECTION_PREFIX = `${EIDOVERSE_MANAGED_PREFIX}signal-`;

export const EIDOVERSE_SOURCE_KEYS = Object.freeze([
  'apps',
  'agents',
  'tasks',
  'features',
  'peers',
  'health',
  'productivity',
  'activity',
  'goals',
  'memory',
  'storage',
  'jira',
  'operations',
]);

const MODEL_ROOT = EIDOVERSE_LIBRARY_MODEL_ROOT;

// Frozen forever: migration must compare legacy leaves against the exact V1
// values that shipped, never against a moving approximation of them.
export const EIDOVERSE_WORLD_DESIGN_V1 = Object.freeze({
  version: 1,
  includes: {
    apps: true, agents: true, tasks: true, features: true, peers: true,
    health: true, productivity: true, activity: true, goals: true,
    memory: true, storage: true, jira: true, operations: true,
  },
  limits: {
    apps: 48, agents: 24, tasks: 48, features: 32, peers: 16,
    health: 1, productivity: 1, activity: 24, goals: 32,
    memory: 16, storage: 48, jira: 48, operations: 1,
  },
  layout: { origin: [-24, 0, -24], spacing: 7, laneGap: 6, columns: 8 },
  scale: {
    app: 1, agent: 1, task: 0.8, feature: 1, peer: 1.2, health: 1.2,
    productivity: 1.2, activity: 0.55, goal: 1.1, memory: 0.9,
    storage: 0.8, jira: 0.75, operations: 1.3,
  },
  assets: {
    app: `${MODEL_ROOT}computer_servers_rack_with_fans_on_back_row_of_four_4_columns.glb`,
    agent: `${MODEL_ROOT}scifi_quad_small_drone_blue.glb`,
    task: `${MODEL_ROOT}scifi_cyberpunk_intermodal_shipping_container_crate_blue.glb`,
    feature: `${MODEL_ROOT}inanna_tech_cyber_scifi_sphere_orb.glb`,
    peer: `${MODEL_ROOT}modern_sedan_car_blue_vehicle_generic.glb`,
    health: `${MODEL_ROOT}inanna_tech_cyber_scifi_sumerian_retrofuturist_vehicle_car_light.glb`,
    productivity: `${MODEL_ROOT}inanna_tech_cyber_scifi_sumerian_retrofuturist_vehicle_car_light.glb`,
    activity: `${MODEL_ROOT}inanna_tech_cyber_scifi_sphere_orb.glb`,
    goal: `${MODEL_ROOT}inanna_tech_cyber_scifi_sphere_orb.glb`,
    memory: `${MODEL_ROOT}inanna_tech_cyber_scifi_sphere_orb.glb`,
    storage: `${MODEL_ROOT}computer_servers_rack_with_fans_on_back_row_of_four_4_columns.glb`,
    jira: `${MODEL_ROOT}scifi_cyberpunk_intermodal_shipping_container_crate_blue.glb`,
    operations: `${MODEL_ROOT}inanna_tech_cyber_scifi_sumerian_retrofuturist_vehicle_car_light.glb`,
  },
  terrain: {
    seed: 'portos', size: 128, segments: 64, amplitude: 1.8, flatRadius: 28,
    layers: [{ color: '#142338', repeat: 18 }, { color: '#1c3b43', repeat: 10 }],
  },
});

const assetSlot = ({ preferredPaths, fallbackQueries, requiredTokens, excludedTokens = [], maxBytes, fallback }) => ({
  preferredPaths,
  fallbackQueries,
  requiredTokens,
  excludedTokens,
  maxBytes,
  format: 'glb',
  animation: 'optional',
  sourcePolicy: 'library-only',
  fallback,
});

// Paths are preferences, not bundled payloads. Queries allow a future library
// to satisfy the same semantic role even when its filenames evolve.
export const EIDOVERSE_ASSET_RECIPE_V2 = Object.freeze({
  version: EIDOVERSE_ASSET_RECIPE_VERSION,
  slots: {
    nexus: assetSlot({
      preferredPaths: [`${MODEL_ROOT}scifi_perimeter_watchtower_standalone_or_with_wall_middle_four_way.glb`],
      fallbackQueries: ['scifi tower', 'technology tower'],
      requiredTokens: ['tower'], excludedTokens: ['car', 'vehicle', 'rubble'], maxBytes: 24_000_000,
      fallback: `${MODEL_ROOT}inanna_tech_cyber_scifi_sphere_orb.glb`,
    }),
    app: assetSlot({
      preferredPaths: [`${MODEL_ROOT}single_loose_computer_server.glb`],
      fallbackQueries: ['computer server', 'technology console'],
      requiredTokens: ['server'], excludedTokens: ['car', 'vehicle'], maxBytes: 32_000_000,
      fallback: `${MODEL_ROOT}inanna_tech_cyber_scifi_sphere_orb.glb`,
    }),
    agent: assetSlot({
      preferredPaths: [`${MODEL_ROOT}scifi_quad_small_drone_blue.glb`],
      fallbackQueries: ['scifi drone', 'robot drone'],
      requiredTokens: ['drone'], excludedTokens: ['car', 'vehicle'], maxBytes: 24_000_000,
      fallback: `${MODEL_ROOT}inanna_tech_cyber_scifi_sphere_orb.glb`,
    }),
    task: assetSlot({
      preferredPaths: [`${MODEL_ROOT}scifi_cyberpunk_intermodal_shipping_container_crate_blue.glb`],
      fallbackQueries: ['scifi crate', 'data container'],
      requiredTokens: ['crate'], excludedTokens: ['car', 'vehicle'], maxBytes: 16_000_000,
      fallback: `${MODEL_ROOT}inanna_tech_cyber_scifi_sphere_orb.glb`,
    }),
    goal: assetSlot({
      preferredPaths: [`${MODEL_ROOT}inanna_tech_cyber_scifi_sphere_orb.glb`],
      fallbackQueries: ['scifi orb', 'beacon'],
      requiredTokens: ['orb'], excludedTokens: ['car', 'vehicle'], maxBytes: 12_000_000,
      fallback: `${MODEL_ROOT}inanna_tech_cyber_scifi_sphere_orb.glb`,
    }),
    memory: assetSlot({
      preferredPaths: [`${MODEL_ROOT}cyborg_brain_cybernetic_implant_neuralink_cyberbrain_organ.glb`],
      fallbackQueries: ['cyber brain', 'memory tree'],
      requiredTokens: ['brain'], excludedTokens: ['car', 'vehicle'], maxBytes: 56_000_000,
      fallback: `${MODEL_ROOT}stylized_yucca_joshua_tree_desert_cactus_plant.glb`,
    }),
    storage: assetSlot({
      preferredPaths: [`${MODEL_ROOT}scif_cyberpunk_crt_retro_computer_monitor_screen_keyboard_tower.glb`],
      fallbackQueries: ['computer mainframe', 'data terminal'],
      requiredTokens: ['computer'], excludedTokens: ['car', 'vehicle'], maxBytes: 44_000_000,
      fallback: `${MODEL_ROOT}single_loose_computer_server.glb`,
    }),
    peer: assetSlot({
      preferredPaths: [`${MODEL_ROOT}scifi_perimeter_wall_gate.glb`],
      fallbackQueries: ['scifi gate', 'portal arch'],
      requiredTokens: ['gate'], excludedTokens: ['car', 'vehicle'], maxBytes: 24_000_000,
      fallback: `${MODEL_ROOT}scifi_perimeter_watchtower_standalone_or_with_wall_middle_four_way.glb`,
    }),
    activity: assetSlot({
      preferredPaths: [`${MODEL_ROOT}streetlight_lamp_light_street_blade_runner_cyberpunk.glb`],
      fallbackQueries: ['cyberpunk streetlight', 'light marker'],
      requiredTokens: ['light'], excludedTokens: ['car', 'vehicle', 'rubble'], maxBytes: 16_000_000,
      fallback: `${MODEL_ROOT}inanna_tech_cyber_scifi_sphere_orb.glb`,
    }),
    district: assetSlot({
      preferredPaths: [`${MODEL_ROOT}scifi_perimeter_wall_pillar.glb`],
      fallbackQueries: ['scifi pillar', 'technology marker'],
      requiredTokens: ['pillar'], excludedTokens: ['car', 'vehicle'], maxBytes: 20_000_000,
      fallback: `${MODEL_ROOT}inanna_tech_cyber_scifi_sphere_orb.glb`,
    }),
  },
});

export const EIDOVERSE_DISTRICTS_V2 = Object.freeze([
  { id: 'nexus', label: 'PortOS Nexus', direction: 'Center', landmark: 'status spire', anchor: [0, 0, 0], sources: ['health', 'operations', 'features'], accent: '#ffb86b' },
  { id: 'apps', label: 'App Terraces', direction: 'Northwest', landmark: 'service pylons', anchor: [-30, 0, -18], sources: ['apps'], accent: '#65d9ff' },
  { id: 'agents', label: 'Agent Foundry', direction: 'North', landmark: 'drone foundry', anchor: [0, 0, -34], sources: ['agents', 'tasks'], accent: '#a78bfa' },
  { id: 'goals', label: 'Goal Observatory', direction: 'Northeast', landmark: 'orbital beacon', anchor: [30, 0, -18], sources: ['goals', 'jira'], accent: '#f7d774' },
  { id: 'memory', label: 'Memory Grove', direction: 'Southeast', landmark: 'neural lanterns', anchor: [32, 0, 17], sources: ['memory'], accent: '#72e6a6' },
  { id: 'data', label: 'Data Vault', direction: 'South', landmark: 'vault servers', anchor: [0, 0, 34], sources: ['storage'], accent: '#55c2ff' },
  { id: 'federation', label: 'Federation Harbor', direction: 'Southwest', landmark: 'portal gate', anchor: [-32, 0, 17], sources: ['peers'], accent: '#66f0d0' },
  { id: 'activity', label: 'Activity River', direction: 'Inner south', landmark: 'light river', anchor: [0, 0, 14], sources: ['activity', 'productivity'], accent: '#ff78b7' },
]);

export const EIDOVERSE_ASSET_SLOTS_BY_DISTRICT = Object.freeze({
  // Include retired V1 kind keys as well as V2 semantic slots. A scoped reset
  // must clear hidden preserved overrides that can still win assetPathFor().
  nexus: ['nexus', 'health', 'operations', 'feature', 'district'],
  apps: ['app'],
  agents: ['agent', 'task'],
  goals: ['goal', 'jira'],
  memory: ['memory'],
  data: ['storage'],
  federation: ['peer'],
  activity: ['activity', 'productivity'],
});

export const EIDOVERSE_PATHS_V2 = Object.freeze(EIDOVERSE_DISTRICTS_V2
  .filter(({ id }) => id !== 'nexus')
  .map((district) => ({
    id: `nexus-${district.id}`,
    label: `Nexus to ${district.label}`,
    toDistrictId: district.id,
    nodes: [0.27, 0.52, 0.77].map((amount) => [
      Number((district.anchor[0] * amount).toFixed(2)),
      0.08,
      Number((district.anchor[2] * amount).toFixed(2)),
    ]),
  })));

export const EIDOVERSE_WORLD_DESIGN_V2 = Object.freeze({
  version: EIDOVERSE_WORLD_DESIGN_VERSION,
  name: 'Luminous Systems Garden',
  maxEntities: EIDOVERSE_MAX_LIVE_ENTITIES,
  includes: Object.fromEntries(EIDOVERSE_SOURCE_KEYS.map((key) => [key, true])),
  limits: {
    apps: 8, agents: 6, tasks: 6, features: 4, peers: 4,
    health: 1, productivity: 1, activity: 3, goals: 4,
    memory: 3, storage: 4, jira: 3, operations: 1,
  },
  scale: {
    app: 0.55, agent: 0.55, task: 0.48, feature: 0.5, peer: 0.7,
    health: 0.8, productivity: 0.75, activity: 0.52, goal: 0.6,
    memory: 0.42, storage: 0.48, jira: 0.5, operations: 0.9,
  },
  districts: EIDOVERSE_DISTRICTS_V2,
  paths: EIDOVERSE_PATHS_V2,
  environment: {
    terrain: {
      seed: 'portos-systems-garden-v2', size: 180, segments: 96,
      amplitude: 1.4, flatRadius: 48,
      layers: [{ color: '#0d1629', repeat: 22 }, { color: '#152942', repeat: 13 }],
    },
    sky: {
      system: 'skymesh', hours: 7.2, azimuth: 145, sun: 1.35,
      ambient: 1.2, fill: 1.1, exposure: 1.08, fog: 0.42,
      clouds: 'cirrus', weather: 'clear',
    },
    grass: {
      species: 'grass', width: 154, depth: 144, center: [0, 0],
      height: 0.22, color: 'gray-green', density: 0.45,
    },
    lights: [
      { id: `${EIDOVERSE_MANAGED_PREFIX}light-nexus`, pos: [0, 8, 1], color: 0x65d9ff, intensity: 22, range: 28, keep: true, day: true },
      { id: `${EIDOVERSE_MANAGED_PREFIX}light-east`, pos: [25, 7, 4], color: 0x72e6a6, intensity: 15, range: 23, keep: true, day: true },
      { id: `${EIDOVERSE_MANAGED_PREFIX}light-west`, pos: [-25, 7, 4], color: 0x65d9ff, intensity: 15, range: 23, keep: true, day: true },
    ],
  },
  assetRecipe: EIDOVERSE_ASSET_RECIPE_V2,
  assets: {},
});

const EIDOVERSE_V2_DEFAULT_CHANGES = Object.freeze([
  { area: 'Composition', from: 'uniform resource lanes', to: 'eight semantic districts and circulation paths' },
  { area: 'Atmosphere', from: 'terrain only', to: 'warm dawn sky, authored light, restrained fog, and sparse grass' },
  { area: 'Assets', from: 'resource-kind model paths', to: 'portable semantic slots with install-local locks' },
  { area: 'Signals', from: 'independent high source caps', to: 'bounded aggregate signals under one 48-entity budget' },
]);

export const EIDOVERSE_WORLD_DESIGNS = Object.freeze({
  1: EIDOVERSE_WORLD_DESIGN_V1,
  2: EIDOVERSE_WORLD_DESIGN_V2,
});

function freezeWorldContract(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeWorldContract(child);
    Object.freeze(value);
  }
  return value;
}

// Object.freeze is shallow. Recursively lock every registry leaf so a route or
// test cannot accidentally mutate the migration baseline for later installs.
freezeWorldContract(EIDOVERSE_WORLD_DESIGN_V1);
freezeWorldContract(EIDOVERSE_ASSET_RECIPE_V2);
freezeWorldContract(EIDOVERSE_DISTRICTS_V2);
freezeWorldContract(EIDOVERSE_ASSET_SLOTS_BY_DISTRICT);
freezeWorldContract(EIDOVERSE_PATHS_V2);
freezeWorldContract(EIDOVERSE_WORLD_DESIGN_V2);
freezeWorldContract(EIDOVERSE_WORLD_DESIGNS);

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => structuredClone(value);
const equal = (left, right) => canonicalStringify(left) === canonicalStringify(right);

const mergeDesign = (base, patch) => clone(deepMerge(clone(base), clone(patch)));

function diffLeaves(value, baseline) {
  if (equal(value, baseline)) return undefined;
  if (!isObject(value) || !isObject(baseline)) return clone(value);
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const diff = diffLeaves(child, baseline[key]);
    if (diff !== undefined) output[key] = diff;
  }
  return Object.keys(output).length ? output : undefined;
}

export function resolveEidoverseDesign(userOverrides = {}, assetResolutions = {}) {
  const resolved = mergeDesign(EIDOVERSE_WORLD_DESIGN_V2, userOverrides);
  resolved.version = EIDOVERSE_WORLD_DESIGN_VERSION;
  resolved.assetRecipe = clone(EIDOVERSE_ASSET_RECIPE_V2);
  resolved.assets = { ...(resolved.assets || {}) };
  for (const [slot, resolution] of Object.entries(assetResolutions || {})) {
    const path = typeof resolution === 'string' ? resolution : resolution?.path;
    if (path) resolved.assets[slot] = path;
  }
  return resolved;
}

export function extractEidoverseDesignOverrides(recipe) {
  if (!isObject(recipe)) return {};
  const candidate = {};
  // `recipe.assets` contains the materialized per-install resolution lock in
  // status responses. It is not a user override merely because the client
  // round-tripped the effective recipe; explicit overrides use the dedicated
  // `assetOverrides` config field.
  for (const section of ['name', 'maxEntities', 'includes', 'limits', 'scale', 'districts', 'paths', 'environment']) {
    if (recipe[section] !== undefined) candidate[section] = clone(recipe[section]);
  }
  return diffLeaves(mergeDesign(EIDOVERSE_WORLD_DESIGN_V2, candidate), EIDOVERSE_WORLD_DESIGN_V2) || {};
}

const validLibraryPath = (path) => typeof path === 'string'
  && path.startsWith(EIDOVERSE_LIBRARY_MODEL_ROOT)
  && !path.includes('..')
  && path.toLowerCase().endsWith('.glb');

export const isValidEidoverseAssetOverridePath = (path) => validLibraryPath(path) || (
  typeof path === 'string'
  && /^store\/[A-Za-z0-9._/-]+$/.test(path)
  && !path.includes('..')
);

function v1OverridesForV2(legacyRecipe) {
  const legacy = mergeDesign(EIDOVERSE_WORLD_DESIGN_V1, legacyRecipe || {});
  const v1Diff = diffLeaves(legacy, EIDOVERSE_WORLD_DESIGN_V1) || {};
  const overrides = {};
  for (const section of ['includes', 'scale']) {
    if (v1Diff[section]) overrides[section] = clone(v1Diff[section]);
  }
  const unsupportedLimits = {};
  if (isObject(v1Diff.limits)) {
    const preservedLimits = {};
    for (const [source, value] of Object.entries(v1Diff.limits)) {
      const v2Limit = EIDOVERSE_WORLD_DESIGN_V2.limits[source];
      if (!Number.isInteger(value) || value < 0 || !Number.isInteger(v2Limit) || value > v2Limit) {
        unsupportedLimits[source] = clone(value);
        continue;
      }
      preservedLimits[source] = value;
    }
    if (Object.keys(preservedLimits).length) overrides.limits = preservedLimits;
  } else if (v1Diff.limits !== undefined) {
    unsupportedLimits.value = clone(v1Diff.limits);
  }
  if (v1Diff.terrain) overrides.environment = { terrain: clone(v1Diff.terrain) };
  let unportableAssets;
  if (isObject(v1Diff.assets)) {
    const entries = Object.entries(v1Diff.assets);
    const portable = entries.filter(([, path]) => isValidEidoverseAssetOverridePath(path));
    if (portable.length) {
      overrides.assets = Object.fromEntries(portable.map(([key, path]) => [key, clone(path)]));
    }
    const rejected = entries.filter(([, path]) => !isValidEidoverseAssetOverridePath(path));
    if (rejected.length) {
      unportableAssets = Object.fromEntries(rejected.map(([key, path]) => [key, clone(path)]));
    }
  } else if (v1Diff.assets !== undefined) {
    unportableAssets = clone(v1Diff.assets);
  }
  // V1's lane geometry and any unknown legacy extension have no safe semantic
  // translation to districts. Preserve their exact values in the report
  // instead of silently distorting the V2 garden or losing customization.
  const unsupportedOverrides = Object.fromEntries(Object.entries(v1Diff)
    .filter(([section]) => !['includes', 'limits', 'scale', 'terrain', 'assets'].includes(section))
    .map(([section, value]) => [section, clone(value)]));
  if (Object.keys(unsupportedLimits).length) unsupportedOverrides.limits = unsupportedLimits;
  if (unportableAssets !== undefined) unsupportedOverrides.assets = unportableAssets;
  return { overrides, unsupportedOverrides };
}

export function migrateEidoverseWorldState(raw, { now = new Date().toISOString() } = {}) {
  if (raw !== null && raw !== undefined && !isObject(raw)) {
    return {
      compatible: false,
      state: raw,
      report: {
        status: 'blocked', fromSchemaVersion: null,
        toSchemaVersion: EIDOVERSE_WORLD_STATE_SCHEMA_VERSION,
        reason: 'invalid-state-shape', at: now,
      },
    };
  }
  const input = isObject(raw) ? clone(raw) : {};
  const inputSchema = Number(input.schemaVersion ?? 1);
  if (!Number.isInteger(inputSchema) || inputSchema < 1) {
    return {
      compatible: false,
      state: input,
      report: {
        status: 'blocked', fromSchemaVersion: input.schemaVersion ?? null,
        toSchemaVersion: EIDOVERSE_WORLD_STATE_SCHEMA_VERSION,
        reason: 'invalid-state-schema', at: now,
      },
    };
  }
  if (inputSchema > EIDOVERSE_WORLD_STATE_SCHEMA_VERSION) {
    return {
      compatible: false,
      state: input,
      report: {
        status: 'blocked', fromSchemaVersion: inputSchema,
        toSchemaVersion: EIDOVERSE_WORLD_STATE_SCHEMA_VERSION,
        reason: 'newer-state-schema', at: now,
      },
    };
  }
  const inputDesignVersions = [
    input.selectedDesignVersion,
    input.lastAppliedDesignVersion,
    input.pendingDesignVersion,
    input.recipe?.version,
  ].filter((value) => value !== null && value !== undefined).map(Number);
  if (inputDesignVersions.some((version) => !Number.isInteger(version) || version < 1)) {
    return {
      compatible: false,
      state: input,
      report: {
        status: 'blocked', fromSchemaVersion: inputSchema,
        toSchemaVersion: EIDOVERSE_WORLD_STATE_SCHEMA_VERSION,
        reason: 'invalid-design-version', at: now,
      },
    };
  }
  if (inputDesignVersions.some((version) => version > EIDOVERSE_WORLD_DESIGN_VERSION)) {
    return {
      compatible: false,
      state: input,
      report: {
        status: 'blocked', fromSchemaVersion: inputSchema,
        toSchemaVersion: EIDOVERSE_WORLD_STATE_SCHEMA_VERSION,
        reason: 'newer-design-version', at: now,
      },
    };
  }
  const inputAssetRecipeVersion = input.assetRecipeVersion === null || input.assetRecipeVersion === undefined
    ? null
    : Number(input.assetRecipeVersion);
  if (inputAssetRecipeVersion !== null
    && (!Number.isInteger(inputAssetRecipeVersion) || inputAssetRecipeVersion < 1)) {
    return {
      compatible: false,
      state: input,
      report: {
        status: 'blocked', fromSchemaVersion: inputSchema,
        toSchemaVersion: EIDOVERSE_WORLD_STATE_SCHEMA_VERSION,
        reason: 'invalid-asset-recipe-version', at: now,
      },
    };
  }
  if (inputAssetRecipeVersion > EIDOVERSE_ASSET_RECIPE_VERSION) {
    return {
      compatible: false,
      state: input,
      report: {
        status: 'blocked', fromSchemaVersion: inputSchema,
        toSchemaVersion: EIDOVERSE_WORLD_STATE_SCHEMA_VERSION,
        reason: 'newer-asset-recipe-version', at: now,
      },
    };
  }

  const removedMachineDerivedIdentity = input.human?.source === 'instance-name';
  if (removedMachineDerivedIdentity) {
    const retiredWorld = typeof input.world === 'string' && input.world.trim()
      ? input.world.trim()
      : 'portos';
    const retiredIdentity = typeof input.human?.name === 'string'
      ? input.human.name.trim()
      : '';
    if (retiredIdentity) {
      const ownership = isObject(input.ownership) ? input.ownership : {};
      const existingRetired = Array.isArray(ownership.retired) ? ownership.retired : [];
      input.ownership = {
        ...ownership,
        retired: [
          ...existingRetired.filter((entry) => !(
            entry?.world === retiredWorld && entry?.id === retiredIdentity
          )),
          {
            world: retiredWorld,
            id: retiredIdentity,
            ...(typeof input.cos?.id === 'string' && input.cos.id.trim() ? {
              actorId: input.cos.id.trim(),
              ...(typeof input.cos?.avatar === 'string' ? { actorAvatar: input.cos.avatar } : {}),
            } : {}),
          },
        ],
      };
    }
    input.human = {
      ...input.human,
      name: null,
      source: null,
      role: null,
    };
  }

  if (inputSchema === EIDOVERSE_WORLD_STATE_SCHEMA_VERSION) {
    const userOverrides = isObject(input.userOverrides)
      ? input.userOverrides
      : extractEidoverseDesignOverrides(input.recipe);
    const assetResolutions = isObject(input.assetResolutions) ? input.assetResolutions : {};
    const report = removedMachineDerivedIdentity
      ? {
        ...(input.migrationReport || {}),
        status: input.migrationReport?.status || 'applied',
        removedMachineDerivedIdentity: true,
        at: input.migrationReport?.at || now,
      }
      : (input.migrationReport || null);
    return {
      compatible: true,
      state: {
        ...input,
        schemaVersion: EIDOVERSE_WORLD_STATE_SCHEMA_VERSION,
        selectedDesignVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
        assetRecipeVersion: EIDOVERSE_ASSET_RECIPE_VERSION,
        userOverrides,
        assetResolutions,
        migrationReport: report,
        recipe: resolveEidoverseDesign(userOverrides, assetResolutions),
      },
      report,
    };
  }

  const { overrides, unsupportedOverrides } = v1OverridesForV2(input.recipe);
  const customizedLeaves = Object.keys(overrides).flatMap((section) =>
    Object.keys(overrides[section] || {}).map((key) => `${section}.${key}`));
  const report = {
    status: 'ready', fromSchemaVersion: inputSchema,
    fromDesignVersion: 1, toSchemaVersion: EIDOVERSE_WORLD_STATE_SCHEMA_VERSION,
    toDesignVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
    inheritedDefaultLeaves: true,
    adoptedDefaultChanges: clone(EIDOVERSE_V2_DEFAULT_CHANGES),
    preservedOverrides: customizedLeaves,
    unsupportedOverrides,
    removedMachineDerivedIdentity,
    // Retain the named field used by the V2 UI and early migration previews.
    ignoredLegacyLayout: unsupportedOverrides.layout || null,
    at: now,
  };
  return {
    compatible: true,
    state: {
      ...input,
      schemaVersion: EIDOVERSE_WORLD_STATE_SCHEMA_VERSION,
      selectedDesignVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
      lastAppliedDesignVersion: 1,
      pendingDesignVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
      userOverrides: overrides,
      assetRecipeVersion: EIDOVERSE_ASSET_RECIPE_VERSION,
      assetResolutions: {},
      migrationReport: report,
      reconciliation: {
        status: 'pending', checkpoint: 'migration-complete', error: null,
        startedAt: null, completedAt: null,
      },
      recipe: resolveEidoverseDesign(overrides),
    },
    report,
  };
}

const tokenized = (value) => String(value || '')
  .toLowerCase()
  .replace(/\.[a-z0-9]+$/i, '')
  .split(/[^a-z0-9]+/)
  .filter(Boolean);

const contractFingerprint = (value) => createHash('sha256')
  .update(canonicalStringify(value))
  .digest('hex')
  .slice(0, 16);

function candidateScore(candidate, slot, preferredIndex, searchRank, allowCatalogFallback) {
  const tokens = tokenized(candidate.path);
  const hasSemanticToken = (needle) => tokens.some((token) => token === needle || token.includes(needle));
  if (slot.excludedTokens.some((needle) => tokens.includes(needle))) return null;
  if (candidate.size !== null && candidate.size > slot.maxBytes) return null;
  const preferred = preferredIndex.get(candidate.path);
  const searched = searchRank.get(candidate.path);
  const fallback = candidate.path === slot.fallback;
  if (preferred === undefined && searched === undefined && !allowCatalogFallback) return null;
  const queryTokens = slot.fallbackQueries.flatMap(tokenized);
  const queryMatches = queryTokens.filter((token) => tokens.some((candidateToken) => (
    candidateToken === token || candidateToken.includes(token)
  ))).length;
  const requiredMatches = slot.requiredTokens.filter(hasSemanticToken).length;
  return (preferred === undefined ? 0 : 1_000_000 - preferred * 10_000)
    + (searched === undefined ? 0 : 200_000 - searched * 100)
    + (fallback ? 100_000 : 0)
    + requiredMatches * 1_000
    + queryMatches * 10
    - (candidate.size === null ? 10_000 : 0)
    - Number(candidate.size || 0) / 1_000_000;
}

function addCatalogCandidate(catalog, candidate) {
  const path = typeof candidate === 'string' ? candidate : candidate?.path;
  if (!validLibraryPath(path)) return;
  const rawSize = typeof candidate === 'string' ? null : candidate?.size;
  const numericSize = Number(rawSize);
  const size = rawSize !== null && rawSize !== undefined && rawSize !== ''
    && Number.isFinite(numericSize) && numericSize >= 0
    ? numericSize
    : null;
  const prior = catalog.get(path);
  if (!prior
    || (prior.size === null && size !== null)
    || (prior.size !== null && size !== null && size < prior.size)) {
    catalog.set(path, { path, size });
  }
}

/**
 * Inspect a persisted V2 lock without touching the Eidoverse catalog.
 *
 * A projection can reuse a complete lock after verifying its selected paths;
 * only changed recipe slots, changed overrides, or incomplete metadata need a
 * catalog/search pass.
 */
export function inspectEidoverseAssetResolutionLocks({ existing = {}, overrides = {} } = {}) {
  const resolutions = {};
  const invalidated = [];
  for (const [slotName, slot] of Object.entries(EIDOVERSE_ASSET_RECIPE_V2.slots)) {
    const lock = isObject(existing[slotName]) ? existing[slotName] : null;
    const overridePath = overrides[slotName];
    const hasOverride = isValidEidoverseAssetOverridePath(overridePath);
    const expectedPathIsValid = hasOverride
      ? lock?.path === overridePath
      : validLibraryPath(lock?.path);
    const current = expectedPathIsValid
      && lock.slot === slotName
      && lock.recipeFingerprint === contractFingerprint(slot)
      && lock.userOverride === hasOverride;
    if (!current) {
      invalidated.push(slotName);
      continue;
    }
    resolutions[slotName] = {
      ...clone(lock),
      designVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
      assetRecipeVersion: EIDOVERSE_ASSET_RECIPE_VERSION,
    };
  }
  return { current: invalidated.length === 0, invalidated, resolutions };
}

/** Resolve every semantic slot deterministically from an Eidoverse catalog. */
export function resolveEidoverseAssetRecipe({
  files = [],
  searchResults = {},
  existing = {},
  overrides = {},
  resolvedAt = null,
} = {}) {
  const catalog = new Map();
  for (const candidate of files) addCatalogCandidate(catalog, candidate);
  for (const values of Object.values(searchResults || {})) {
    for (const candidate of Array.isArray(values) ? values : []) addCatalogCandidate(catalog, candidate);
  }

  const fingerprint = createHash('sha256')
    .update([...catalog.values()].sort((a, b) => a.path.localeCompare(b.path)).map(({ path, size }) => `${path}:${size ?? 'unknown'}`).join('\n'))
    .digest('hex').slice(0, 16);
  const resolutions = {};
  const missing = [];
  for (const [slotName, slot] of Object.entries(EIDOVERSE_ASSET_RECIPE_V2.slots)) {
    const recipeFingerprint = contractFingerprint(slot);
    const overridePath = overrides[slotName];
    const locked = isObject(existing[slotName]) ? existing[slotName] : { path: existing[slotName] };
    const lockedPath = locked.path;
    const baseResolution = (path, strategy, userOverride, prior = null, bytes = null) => ({
      designVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
      assetRecipeVersion: EIDOVERSE_ASSET_RECIPE_VERSION,
      slot: slotName,
      path,
      catalogFingerprint: prior?.catalogFingerprint || fingerprint,
      recipeFingerprint,
      bytes: prior?.bytes ?? bytes,
      strategy,
      // `source` is retained for the V2 UI and pre-metadata lock readers.
      source: strategy,
      resolvedAt: prior?.resolvedAt || resolvedAt,
      shippedDefault: !userOverride,
      userOverride,
    });
    if (isValidEidoverseAssetOverridePath(overridePath)) {
      if (lockedPath === overridePath
        && locked.userOverride === true
        && locked.recipeFingerprint === recipeFingerprint) {
        resolutions[slotName] = baseResolution(overridePath, 'user-override', true, locked, catalog.get(overridePath)?.size ?? null);
      } else {
        resolutions[slotName] = baseResolution(overridePath, 'user-override', true, null, catalog.get(overridePath)?.size ?? null);
      }
      continue;
    }
    const lockMatchesRecipe = locked.recipeFingerprint === undefined
      || locked.recipeFingerprint === recipeFingerprint;
    if (validLibraryPath(lockedPath)
      && catalog.has(lockedPath)
      && locked.userOverride !== true
      && lockMatchesRecipe) {
      const strategy = locked.strategy || locked.source || 'lock';
      resolutions[slotName] = baseResolution(lockedPath, strategy, false, locked, catalog.get(lockedPath)?.size ?? null);
      continue;
    }
    const preferredIndex = new Map(slot.preferredPaths.map((path, index) => [path, index]));
    const searchRank = new Map();
    slot.fallbackQueries.forEach((query, queryIndex) => {
      const candidates = Array.isArray(searchResults[query]) ? searchResults[query] : [];
      candidates.forEach((candidate, resultIndex) => {
        const path = typeof candidate === 'string' ? candidate : candidate?.path;
        if (!validLibraryPath(path)) return;
        const rank = queryIndex * 1000 + resultIndex;
        if (!searchRank.has(path) || rank < searchRank.get(path)) {
          searchRank.set(path, rank);
        }
      });
    });
    const searchWasAttempted = slot.fallbackQueries.some((query) => Object.hasOwn(searchResults, query));
    const ranked = [...catalog.values()]
      .map((candidate) => ({
        candidate,
        score: candidateScore(candidate, slot, preferredIndex, searchRank, searchWasAttempted),
      }))
      .filter(({ score }) => score !== null)
      .sort((a, b) => b.score - a.score || a.candidate.path.localeCompare(b.candidate.path));
    const fallbackCandidate = catalog.get(slot.fallback);
    const fallbackTokens = fallbackCandidate ? tokenized(fallbackCandidate.path) : [];
    const fallbackAllowed = fallbackCandidate
      && (fallbackCandidate.size === null || fallbackCandidate.size <= slot.maxBytes)
      && !slot.excludedTokens.some((needle) => fallbackTokens.includes(needle));
    const chosen = ranked[0]?.candidate || (searchWasAttempted && fallbackAllowed ? fallbackCandidate : null);
    if (!chosen) {
      missing.push(slotName);
      continue;
    }
    const strategy = preferredIndex.has(chosen.path)
      ? 'preferred'
      : (searchRank.has(chosen.path)
          ? 'query'
          : (chosen.path === slot.fallback ? 'fallback' : 'catalog-fallback'));
    resolutions[slotName] = baseResolution(chosen.path, strategy, false, null, chosen.size);
  }
  return { resolutions, missing, catalogFingerprint: fingerprint };
}

export function stableEidoverseUnit(value) {
  const hash = createHash('sha256').update(String(value)).digest();
  return hash.readUInt32BE(0) / 0xffffffff;
}
