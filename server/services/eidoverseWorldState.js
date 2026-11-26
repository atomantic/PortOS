/** Install-local Eidoverse world configuration, validation, and serialized persistence. */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createMutex } from '../lib/asyncMutex.js';
import { ServerError } from '../lib/errorHandler.js';
import { atomicWrite, dataPath, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import { normalizeEidoverseLabelAliases } from '../lib/eidoverseWorldLabels.js';
import {
  EIDOVERSE_ASSET_SLOTS_BY_DISTRICT,
  EIDOVERSE_ASSET_RECIPE_VERSION,
  EIDOVERSE_WORLD_DESIGN_VERSION,
  EIDOVERSE_WORLD_STATE_SCHEMA_VERSION,
  extractEidoverseDesignOverrides,
  migrateEidoverseWorldState,
  resolveEidoverseDesign,
} from '../lib/eidoverseWorldDesign.js';
import { eidoverseHostId } from '../lib/eidoverseWorldSignals.js';
import { eidoverseWorldEvents } from './eidoverseWorldEvents.js';
import { DEFAULT_EIDOVERSE_PROJECTION_RECIPE, EIDOVERSE_PROJECTION_KINDS } from './eidoverseWorldProjection.js';
import { ensureSelf, getInstanceId } from './instanceIdentity.js';
import { getCurrentVersion } from './updateChecker.js';

const DATA_DIR = dataPath('eidoverse');
const STATE_FILE = join(DATA_DIR, 'portos-world.json');
const WORLD_NAME_RE = /^[a-z0-9_-]{1,64}$/i;
const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ASSET_PATH_RE = /^(?:eidoverse|store)\//i;
const DEFAULT_WORLD = 'portos';
export const DEFAULT_HUMAN_AVATAR = 'eidoverse/assets/vrms/claude.vrm';
const DEFAULT_COS_ID = 'portos-cos';
const DEFAULT_COS_AVATAR = 'eidoverse/assets/vrms/claude_suit.vrm';
export const RETIRED_OWNER_MAX_ATTEMPTS = 3;
const WORLD_ROLES = new Set(['owner', 'builder', 'visitor']);

const DEFAULT_STATE = {
  schemaVersion: EIDOVERSE_WORLD_STATE_SCHEMA_VERSION,
  world: DEFAULT_WORLD,
  human: {
    name: null,
    avatar: DEFAULT_HUMAN_AVATAR,
    source: null,
    role: null,
  },
  cos: {
    id: DEFAULT_COS_ID,
    avatar: DEFAULT_COS_AVATAR,
    enabled: true,
    role: null,
  },
  ownership: {
    retired: [],
  },
  selectedDesignVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
  lastAppliedDesignVersion: null,
  pendingDesignVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
  userOverrides: {},
  labelAliases: {},
  assetRecipeVersion: EIDOVERSE_ASSET_RECIPE_VERSION,
  assetResolutions: {},
  migrationReport: null,
  reconciliation: {
    status: 'pending',
    checkpoint: 'new-install',
    error: null,
    errorCode: null,
    errorContext: null,
    startedAt: null,
    completedAt: null,
    planFingerprint: null,
    operationCount: 0,
    appliedOperations: 0,
    compensationStatus: null,
  },
  recipe: DEFAULT_EIDOVERSE_PROJECTION_RECIPE,
  projection: {
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastSummary: null,
  },
};

const stateLock = createMutex();

export const clone = (value) => structuredClone(value);
export function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

export function safeText(value, fallback = '', max = 160) {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean ? clean.slice(0, max) : fallback;
}

function validWorldName(value, fallback = DEFAULT_WORLD) {
  const clean = safeText(value, '').toLowerCase();
  return WORLD_NAME_RE.test(clean) ? clean : fallback;
}

export function validIdentity(value, fallback) {
  const clean = safeText(value, '').slice(0, 64);
  if (!clean || /^(world|\*)$/i.test(clean) || /^bhv:/i.test(clean)) return fallback;
  return clean;
}

export function validRole(value) {
  return WORLD_ROLES.has(value) ? value : null;
}

export function validEntityId(value) {
  const clean = safeText(value, '', Infinity);
  if (!ENTITY_ID_RE.test(clean)) {
    throw new ServerError('Eidoverse entity ids must be 1–64 characters and contain only letters, numbers, hyphens, and underscores.', {
      status: 400,
      code: 'EIDOVERSE_ARGUMENT_INVALID',
    });
  }
  return clean;
}

export function validAssetPath(value) {
  const clean = safeText(value, '').replaceAll('\\', '/');
  if (!isSafeAssetPath(clean)) {
    throw new ServerError('Eidoverse assets must use a relative eidoverse library or store path.', {
      status: 400,
      code: 'EIDOVERSE_ARGUMENT_INVALID',
    });
  }
  return clean;
}

function isSafeAssetPath(value) {
  return Boolean(value)
    && !value.startsWith('/')
    && !value.includes('..')
    && ASSET_PATH_RE.test(value);
}

export function vector3(value, field) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((part) => typeof part !== 'number' || !Number.isFinite(part))) {
    throw new ServerError(`${field} must be a finite [x, y, z] vector.`, {
      status: 400,
      code: 'EIDOVERSE_ARGUMENT_INVALID',
    });
  }
  return value.map(Number);
}

export function safeNumber(value, field, { min = -Infinity, max = Infinity, fallback = undefined } = {}) {
  if (value === undefined && fallback !== undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new ServerError(`${field} must be a finite number between ${min} and ${max}.`, {
      status: 400,
      code: 'EIDOVERSE_ARGUMENT_INVALID',
    });
  }
  return number;
}

function normalizeRetiredOwners(value) {
  if (!Array.isArray(value)) return [];
  const entries = new Map();
  for (const candidate of value) {
    const world = validWorldName(candidate?.world, '');
    const id = validIdentity(candidate?.id, '');
    if (!world || !id) continue;
    const key = `${world}\0${id}`;
    const actorId = validIdentity(candidate?.actorId, '');
    const normalizedAvatar = safeText(candidate?.actorAvatar, '').replaceAll('\\', '/');
    const attempts = Number.isInteger(candidate?.attempts)
      ? Math.max(0, Math.min(RETIRED_OWNER_MAX_ATTEMPTS - 1, candidate.attempts))
      : 0;
    entries.set(key, {
      world,
      id,
      ...(actorId ? {
        actorId,
        actorAvatar: isSafeAssetPath(normalizedAvatar) ? normalizedAvatar : DEFAULT_COS_AVATAR,
      } : {}),
      ...(attempts > 0 ? { attempts } : {}),
    });
  }
  return [...entries.values()];
}

function rememberRetiredOwner(state, world, id, actor) {
  state.ownership ||= { retired: [] };
  state.ownership.retired = normalizeRetiredOwners([
    ...state.ownership.retired,
    { world, id, actorId: actor?.id, actorAvatar: actor?.avatar },
  ]);
}

function normalizeState(raw) {
  const migration = migrateEidoverseWorldState(raw);
  if (!migration.compatible) {
    const invalid = String(migration.report?.reason || '').startsWith('invalid-');
    throw new ServerError(invalid
      ? 'This Eidoverse world state is invalid. Repair or restore data/eidoverse/portos-world.json before changing it.'
      : 'This Eidoverse world state was written by a newer PortOS design. Update PortOS before changing it.', {
      status: 409,
      code: 'EIDOVERSE_STATE_VERSION_UNSUPPORTED',
      context: {
        reason: migration.report?.reason,
        fromSchemaVersion: migration.report?.fromSchemaVersion,
        supportedSchemaVersion: EIDOVERSE_WORLD_STATE_SCHEMA_VERSION,
      },
    });
  }
  const input = migration.state;
  const userOverrides = input.userOverrides && typeof input.userOverrides === 'object'
    ? input.userOverrides
    : {};
  const assetResolutions = input.assetResolutions && typeof input.assetResolutions === 'object'
    ? input.assetResolutions
    : {};
  return {
    schemaVersion: EIDOVERSE_WORLD_STATE_SCHEMA_VERSION,
    world: validWorldName(input.world),
    human: {
      ...DEFAULT_STATE.human,
      ...(input.human && typeof input.human === 'object' ? input.human : {}),
      role: validRole(input.human?.role),
    },
    cos: {
      ...DEFAULT_STATE.cos,
      ...(input.cos && typeof input.cos === 'object' ? input.cos : {}),
      role: validRole(input.cos?.role),
    },
    ownership: {
      retired: normalizeRetiredOwners(input.ownership?.retired),
    },
    selectedDesignVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
    lastAppliedDesignVersion: Number.isInteger(input.lastAppliedDesignVersion)
      ? input.lastAppliedDesignVersion
      : null,
    pendingDesignVersion: input.pendingDesignVersion === null
      ? null
      : (Number.isInteger(input.pendingDesignVersion)
          ? input.pendingDesignVersion
          : EIDOVERSE_WORLD_DESIGN_VERSION),
    userOverrides: clone(userOverrides),
    labelAliases: normalizeEidoverseLabelAliases(input.labelAliases),
    assetRecipeVersion: EIDOVERSE_ASSET_RECIPE_VERSION,
    assetResolutions: clone(assetResolutions),
    migrationReport: input.migrationReport || migration.report || null,
    reconciliation: {
      ...DEFAULT_STATE.reconciliation,
      ...(input.reconciliation && typeof input.reconciliation === 'object' ? input.reconciliation : {}),
    },
    recipe: resolveEidoverseDesign(userOverrides, assetResolutions),
    projection: {
      ...DEFAULT_STATE.projection,
      ...(input.projection && typeof input.projection === 'object' ? input.projection : {}),
    },
  };
}

export async function loadState() {
  return normalizeState(await readJSONFile(STATE_FILE, clone(DEFAULT_STATE), { strict: true }));
}

/**
 * The install's stored design recipe, read WITHOUT a runtime, presence, or an
 * install check — `loadState()` is a plain file read, and observation-first
 * discovery (#7457) needs the world's shape even when its runtime is stopped.
 * `normalizeState` has already migrated an older stored recipe forward, so a
 * caller resolves this the same way the projection does.
 */
export async function readEidoverseWorldRecipe() {
  return (await loadState()).recipe;
}

export async function mutateState(mutator) {
  return stateLock(async () => {
    const state = await loadState();
    const result = await mutator(state);
    await ensureDir(DATA_DIR);
    await atomicWrite(STATE_FILE, state);
    eidoverseWorldEvents.emit('updated');
    return result;
  });
}

function fallbackIdentity(self) {
  const instanceId = self?.instanceId || 'uninitialized-instance';
  // An instance display name is machine identity and must never become part of
  // Eidoverse's append-only world log by default. Keep the embodied fallback
  // stable without disclosing the raw instance id; users can still opt into an
  // explicit human name from the World Design drawer.
  return { name: `portos-${shortHash(instanceId)}`, source: 'instance-id' };
}

export function configFromState(state, presence) {
  const activePresence = presence?.connection?.isOpen()
    && presence.connection.world === state.world
    && presence.connection.id === state.cos.id
    ? presence
    : null;
  return {
    schemaVersion: state.schemaVersion,
    world: state.world,
    human: {
      id: state.human.name,
      name: state.human.name,
      avatar: state.human.avatar,
      source: state.human.source,
      role: validRole(state.human.role),
    },
    cos: {
      id: state.cos.id,
      avatar: state.cos.avatar,
      enabled: state.cos.enabled,
      connected: Boolean(activePresence),
      role: activePresence
        ? (activePresence.snapshot?.yourRights?.role || roleFromSnapshot(activePresence.snapshot, state.cos.id))
        : validRole(state.cos.role),
      gen: activePresence?.snapshot?.yourRights?.gen === true,
    },
    design: {
      name: state.recipe.name,
      labelAliases: clone(state.labelAliases),
      selectedVersion: state.selectedDesignVersion,
      lastAppliedVersion: state.lastAppliedDesignVersion,
      pendingVersion: state.pendingDesignVersion,
      assetRecipeVersion: state.assetRecipeVersion,
      assetResolutions: clone(state.assetResolutions),
      userOverrides: clone(state.userOverrides),
      migrationReport: clone(state.migrationReport),
      reconciliation: clone(state.reconciliation),
      districts: clone(state.recipe.districts),
      maxEntities: state.recipe.maxEntities,
    },
    recipe: state.recipe,
    projection: state.projection,
  };
}

function applyConfigDefaults(state, fallback, chosenCosId) {
  let changed = false;
  if (chosenCosId && chosenCosId !== state.cos.id) {
    rememberRetiredOwner(state, state.world, state.cos.id, { id: state.cos.id, avatar: state.cos.avatar });
    state.cos.id = chosenCosId;
    state.cos.role = null;
    state.ownership.retired = state.ownership.retired.filter((entry) => !(entry.world === state.world && entry.id === chosenCosId));
    changed = true;
  }
  if (!validIdentity(state.human.name, '')) {
    state.human.name = fallback.name;
    state.human.source = fallback.source;
    changed = true;
  } else if (!state.human.source) {
    state.human.source = 'configured';
    changed = true;
  }
  if (!validIdentity(state.cos.id, '')) {
    state.cos.id = DEFAULT_COS_ID;
    changed = true;
  }
  if (!isSafeAssetPath(state.human.avatar || DEFAULT_HUMAN_AVATAR)) {
    state.human.avatar = DEFAULT_HUMAN_AVATAR;
    changed = true;
  }
  if (!isSafeAssetPath(state.cos.avatar || DEFAULT_COS_AVATAR)) {
    state.cos.avatar = DEFAULT_COS_AVATAR;
    changed = true;
  }
  return changed;
}

export async function readEidoverseWorldConfig(self, getPresence) {
  const state = await loadState();
  applyConfigDefaults(state, fallbackIdentity(self), await resolveSuggestedCosId());
  return configFromState(state, getPresence());
}

export async function ensureEidoverseWorldConfig(getPresence) {
  const self = await ensureSelf();
  const fallback = fallbackIdentity(self);
  const chosenCosId = await resolveSuggestedCosId();
  return mutateState((state) => {
    applyConfigDefaults(state, fallback, chosenCosId);
    return configFromState(state, getPresence());
  });
}

/**
 * Who hosts this world? Answered by the PortOS bridge on `GET /host`, so the
 * upstream Eidoverse checkout stays untouched — and hung on the world's own
 * meta entity, so a fork of the log carries it too.
 *
 * Anyone who can reach the door reads this, so it carries a non-reversible
 * install digest and the operator-chosen world title only — never a hostname,
 * tailnet/MagicDNS name, LAN or public address, OS username, or home path.
 * Config reads only: the bridge must not have to open a world connection.
 */
export async function readEidoverseHostDescriptor() {
  const [state, instanceId, version] = await Promise.all([
    loadState(),
    getInstanceId(),
    getCurrentVersion(),
  ]);
  return {
    id: eidoverseHostId(instanceId),
    kind: 'portos',
    label: safeText(state.recipe?.name, DEFAULT_EIDOVERSE_PROJECTION_RECIPE.name, 120),
    version,
    // The `eido:` resolver/export path is unimplemented upstream, so a visiting
    // client must not assume this host can serve one.
    caps: { eido: false },
  };
}
function presenceConfigFromState({ world, human, cos }) {
  return {
    world,
    humanName: human.name,
    humanAvatar: human.avatar,
    cosId: cos.id,
    cosAvatar: cos.avatar,
    cosEnabled: cos.enabled,
  };
}

export async function updateWorldConfigState(patch) {
  const self = await ensureSelf();
  const fallback = fallbackIdentity(self);
  const chosenCosId = await resolveSuggestedCosId();
  const fullReset = patch.reset?.scope === 'all';
  const presenceConfigChanged = await mutateState((state) => {
    const previousPresenceConfig = presenceConfigFromState(state);
    let designChanged = false;
    if (patch.world !== undefined) state.world = validWorldName(patch.world);
    const worldChanged = previousPresenceConfig.world !== state.world;
    if (Object.hasOwn(patch, 'humanName')) {
      state.human.name = patch.humanName
        ? validIdentity(patch.humanName, fallback.name)
        : fallback.name;
      state.human.source = patch.humanName ? 'configured' : fallback.source;
    }
    if (Object.hasOwn(patch, 'humanAvatar')) state.human.avatar = patch.humanAvatar || DEFAULT_HUMAN_AVATAR;
    if (Object.hasOwn(patch, 'cosId')) {
      state.cos.id = patch.cosId
        ? validIdentity(patch.cosId, DEFAULT_COS_ID)
        : DEFAULT_COS_ID;
    }
    if (chosenCosId) state.cos.id = chosenCosId;
    if (Object.hasOwn(patch, 'cosAvatar')) state.cos.avatar = patch.cosAvatar || DEFAULT_COS_AVATAR;
    if (patch.cosEnabled !== undefined) state.cos.enabled = patch.cosEnabled;
    if (fullReset) {
      state.userOverrides = {};
      state.labelAliases = {};
      state.assetResolutions = {};
      state.ownership.retired = [];
      state.human.role = null;
      state.cos.role = null;
      delete state.reconciliation.retiredOwnerCleanup;
      if (state.migrationReport) delete state.migrationReport.retiredOwnerCleanup;
      designChanged = true;
    } else if (patch.reset?.scope === 'assets') {
      state.assetResolutions = {};
      delete state.userOverrides.assets;
      designChanged = true;
    } else if (patch.reset?.scope === 'district') {
      const district = state.recipe.districts.find(({ id }) => id === patch.reset.districtId);
      if (!district) {
        throw new ServerError('The selected Eidoverse district no longer exists in this world design.', {
          status: 400,
          code: 'EIDOVERSE_DISTRICT_NOT_FOUND',
        });
      }
      const districtKinds = district.sources
        .map((sourceKey) => EIDOVERSE_PROJECTION_KINDS.find((entry) => entry.source === sourceKey)?.kind)
        .filter(Boolean);
      for (const sourceKey of district.sources) {
        delete state.userOverrides.includes?.[sourceKey];
        delete state.userOverrides.limits?.[sourceKey];
      }
      for (const kind of districtKinds) delete state.userOverrides.scale?.[kind];
      state.labelAliases = Object.fromEntries(Object.entries(state.labelAliases)
        .filter(([key]) => !districtKinds.some((kind) => key.startsWith(`${kind}-`))));
      const districtAssetSlots = new Set([
        ...(EIDOVERSE_ASSET_SLOTS_BY_DISTRICT[district.id] || ['district']),
        ...districtKinds,
      ]);
      for (const slot of districtAssetSlots) {
        delete state.userOverrides.assets?.[slot];
        delete state.assetResolutions[slot];
      }
      designChanged = true;
    }
    if (patch.labelAliases !== undefined) {
      state.labelAliases = normalizeEidoverseLabelAliases(patch.labelAliases);
      designChanged = true;
    }
    if (patch.refreshAssets) {
      state.assetResolutions = {};
      designChanged = true;
    }
    if (patch.assetOverrides !== undefined) {
      state.userOverrides.assets = clone(patch.assetOverrides);
      designChanged = true;
    }
    if (patch.recipe !== undefined) {
      const preservedAssetOverrides = state.userOverrides.assets;
      state.userOverrides = patch.recipe.version === 1
        ? migrateEidoverseWorldState({ schemaVersion: 1, recipe: patch.recipe }).state.userOverrides
        : extractEidoverseDesignOverrides(patch.recipe);
      if (preservedAssetOverrides && Object.keys(preservedAssetOverrides).length) {
        state.userOverrides.assets = clone(preservedAssetOverrides);
      }
      designChanged = true;
    }
    if (worldChanged) {
      state.lastAppliedDesignVersion = null;
      state.pendingDesignVersion = state.selectedDesignVersion;
      state.projection = clone(DEFAULT_STATE.projection);
      state.reconciliation = { ...DEFAULT_STATE.reconciliation, checkpoint: 'configuration-saved' };
      // A legacy migration report would let boot reconciliation write to the newly selected world.
      state.migrationReport = null;
    } else if (designChanged) {
      state.pendingDesignVersion = EIDOVERSE_WORLD_DESIGN_VERSION;
      state.reconciliation.status = 'pending';
      state.reconciliation.checkpoint = 'configuration-saved';
      state.reconciliation.error = null;
      state.reconciliation.errorCode = null;
      state.reconciliation.errorContext = null;
      state.reconciliation.planFingerprint = null;
      state.reconciliation.operationCount = 0;
      state.reconciliation.appliedOperations = 0;
      state.reconciliation.compensationStatus = null;
    }
    state.recipe = resolveEidoverseDesign(state.userOverrides, state.assetResolutions);
    const humanChanged = previousPresenceConfig.humanName !== state.human.name;
    const cosChanged = previousPresenceConfig.cosId !== state.cos.id;
    const previousOwner = {
      id: previousPresenceConfig.cosId,
      avatar: previousPresenceConfig.cosAvatar,
    };
    if (!fullReset && humanChanged) {
      rememberRetiredOwner(
        state,
        previousPresenceConfig.world,
        previousPresenceConfig.humanName,
        previousOwner,
      );
    }
    if (!fullReset && cosChanged) {
      rememberRetiredOwner(
        state,
        previousPresenceConfig.world,
        previousPresenceConfig.cosId,
        previousOwner,
      );
    }
    if (worldChanged || humanChanged) state.human.role = null;
    if (worldChanged || cosChanged) state.cos.role = null;
    state.ownership.retired = state.ownership.retired.filter((entry) => !(
      entry.world === state.world
      && (entry.id === state.human.name || entry.id === state.cos.id)
    ));
    const currentPresenceConfig = presenceConfigFromState(state);
    return fullReset || Object.keys(currentPresenceConfig).some((key) => (
      previousPresenceConfig[key] !== currentPresenceConfig[key]
    ));
  });
  return { self, presenceConfigChanged };
}

export function roleFromSnapshot(snapshot, id) {
  const role = snapshot?.state?.roles?.[id];
  return validRole(typeof role === 'string' ? role : role?.role);
}

export async function resolveSuggestedCosId(currentCosId) {
  try {
    const { readPersistentMindName } = await import('./persistent/persistentMindContext.js');
    const name = await readPersistentMindName();
    if (!name) return null;
    const clean = validIdentity(name, '');
    if (!clean || clean === currentCosId) return null;
    return clean;
  } catch {
    return null;
  }
}

export async function getEidoverseWorldProjectionStatus() {
  const state = await loadState();
  return {
    design: {
      selectedVersion: state.selectedDesignVersion,
      lastAppliedVersion: state.lastAppliedDesignVersion,
      pendingVersion: state.pendingDesignVersion,
      reconciliation: clone(state.reconciliation),
    },
    projection: clone(state.projection),
  };
}
