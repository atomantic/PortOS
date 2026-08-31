/**
 * PortOS-owned Eidoverse world integration.
 *
 * Eidoverse owns the append-only world log and its derived snapshot. PortOS
 * owns the install-local identity/configuration that decides who enters the
 * world and how PortOS resources are projected into it. The projection is
 * deterministic and uses the Eidoverse world protocol; it never edits the
 * external checkout or calls an AI provider.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { atomicWrite, dataPath, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { ServerError } from '../lib/errorHandler.js';
import { canonicalStringify } from '../lib/objects.js';
import { getSelf, ensureSelf } from './instances.js';
import { getInstanceFeatures } from './instanceFeatures.js';
import { getEidoverseStatus, EIDOVERSE_PORT } from './eidoverse.js';
import {
  EIDOVERSE_ASSET_SLOTS_BY_DISTRICT,
  EIDOVERSE_ASSET_RECIPE_VERSION,
  EIDOVERSE_WORLD_DESIGN_VERSION,
  EIDOVERSE_WORLD_STATE_SCHEMA_VERSION,
  extractEidoverseDesignOverrides,
  inspectEidoverseAssetResolutionLocks,
  isValidEidoverseAssetOverridePath,
  migrateEidoverseWorldState,
  resolveEidoverseAssetRecipe,
  resolveEidoverseDesign,
} from '../lib/eidoverseWorldDesign.js';
import {
  buildProjectionPlan,
  DEFAULT_EIDOVERSE_PROJECTION_RECIPE,
  EIDOVERSE_PROJECTION_KINDS,
} from './eidoverseWorldProjection.js';
import {
  collectEidoverseWorldSources,
  projectedJiraTickets,
  projectedStorage,
} from './eidoverseWorldSources.js';

export { buildProjectionPlan, DEFAULT_EIDOVERSE_PROJECTION_RECIPE, projectedJiraTickets, projectedStorage };

const DATA_DIR = dataPath('eidoverse');
const STATE_FILE = join(DATA_DIR, 'portos-world.json');
const WORLD_NAME_RE = /^[a-z0-9_-]{1,64}$/i;
const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COMPONENT_TYPE_RE = /^[A-Za-z0-9._:-]{1,32}$/;
const ASSET_PATH_RE = /^(?:eidoverse|store)\//i;
const COMPONENT_TYPE = 'portos';
const DEFAULT_WORLD = 'portos';
const DEFAULT_HUMAN_AVATAR = 'eidoverse/assets/vrms/claude.vrm';
const DEFAULT_COS_ID = 'portos-cos';
const DEFAULT_COS_AVATAR = 'eidoverse/assets/vrms/claude_suit.vrm';
// Eidoverse admits 12 authored verbs per four seconds. Stay just below that
// public protocol limit so large first-run reconciliations remain reliable.
const PROJECTION_VERB_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 5 : 350;
const RETIRED_OWNER_MAX_ATTEMPTS = 3;
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
const worldLock = createMutex();
let cosPresence = null;

const clone = (value) => structuredClone(value);

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException(String(signal?.reason || 'The Eidoverse operation was canceled.'), 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function abortableDelay(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function safeText(value, fallback = '', max = 160) {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean ? clean.slice(0, max) : fallback;
}

function validWorldName(value, fallback = DEFAULT_WORLD) {
  const clean = safeText(value, '').toLowerCase();
  return WORLD_NAME_RE.test(clean) ? clean : fallback;
}

function validIdentity(value, fallback) {
  const clean = safeText(value, '').slice(0, 64);
  if (!clean || /^(world|\*)$/i.test(clean) || /^bhv:/i.test(clean)) return fallback;
  return clean;
}

function validRole(value) {
  return WORLD_ROLES.has(value) ? value : null;
}

function validEntityId(value) {
  const clean = safeText(value, '').slice(0, 64);
  if (!ENTITY_ID_RE.test(clean)) {
    throw new ServerError('Eidoverse entity ids must contain only letters, numbers, hyphens, and underscores.', {
      status: 400,
      code: 'EIDOVERSE_ARGUMENT_INVALID',
    });
  }
  return clean;
}

function validAssetPath(value) {
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

function vector3(value, field) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((part) => typeof part !== 'number' || !Number.isFinite(part))) {
    throw new ServerError(`${field} must be a finite [x, y, z] vector.`, {
      status: 400,
      code: 'EIDOVERSE_ARGUMENT_INVALID',
    });
  }
  return value.map(Number);
}

function safeNumber(value, field, { min = -Infinity, max = Infinity, fallback = undefined } = {}) {
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

async function loadState() {
  return normalizeState(await readJSONFile(STATE_FILE, clone(DEFAULT_STATE), { strict: true }));
}

async function mutateState(mutator) {
  return stateLock(async () => {
    const state = await loadState();
    const result = await mutator(state);
    await ensureDir(DATA_DIR);
    await atomicWrite(STATE_FILE, state);
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

function configFromState(state, presence = cosPresence) {
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

function applyConfigDefaults(state, fallback) {
  let changed = false;
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

async function readEidoverseWorldConfig(self) {
  const state = await loadState();
  applyConfigDefaults(state, fallbackIdentity(self));
  return configFromState(state);
}

export async function ensureEidoverseWorldConfig() {
  const self = await ensureSelf();
  const fallback = fallbackIdentity(self);
  return mutateState((state) => {
    applyConfigDefaults(state, fallback);
    return configFromState(state);
  });
}

export async function updateEidoverseWorldConfig(patch) {
  return worldLock(async () => {
    const self = await ensureSelf();
    const fallback = fallbackIdentity(self);
    const fullReset = patch.reset?.scope === 'all';
    const updated = await mutateState((state) => {
      const previousPresenceConfig = {
        world: state.world,
        humanName: state.human.name,
        humanAvatar: state.human.avatar,
        cosId: state.cos.id,
        cosAvatar: state.cos.avatar,
        cosEnabled: state.cos.enabled,
      };
      let designChanged = false;
      if (patch.world !== undefined) state.world = validWorldName(patch.world);
      if (Object.hasOwn(patch, 'humanName')) {
        state.human.name = patch.humanName
          ? validIdentity(patch.humanName, fallback.name)
          : fallback.name;
        state.human.source = patch.humanName ? 'configured' : fallback.source;
      }
      if (Object.hasOwn(patch, 'humanAvatar')) state.human.avatar = patch.humanAvatar || DEFAULT_HUMAN_AVATAR;
      if (patch.cosId !== undefined) state.cos.id = validIdentity(patch.cosId, DEFAULT_COS_ID);
      if (Object.hasOwn(patch, 'cosAvatar')) state.cos.avatar = patch.cosAvatar || DEFAULT_COS_AVATAR;
      if (patch.cosEnabled !== undefined) state.cos.enabled = patch.cosEnabled;
      if (fullReset) {
        state.userOverrides = {};
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
      if (designChanged) {
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
      const worldChanged = previousPresenceConfig.world !== state.world;
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
      return { previousPresenceConfig, config: configFromState(state) };
    });
    const currentPresenceConfig = {
      world: updated.config.world,
      humanName: updated.config.human.name,
      humanAvatar: updated.config.human.avatar,
      cosId: updated.config.cos.id,
      cosAvatar: updated.config.cos.avatar,
      cosEnabled: updated.config.cos.enabled,
    };
    if (fullReset || Object.keys(currentPresenceConfig).some((key) => (
      updated.previousPresenceConfig[key] !== currentPresenceConfig[key]
    ))) {
      await closeCosPresenceInternal();
    }
    return readEidoverseWorldConfig(self);
  });
}

function resolveWorldWsUrl() {
  const configured = typeof process.env.EIDOVERSE_WS_URL === 'string' ? process.env.EIDOVERSE_WS_URL.trim() : '';
  return configured || `ws://127.0.0.1:${EIDOVERSE_PORT}/ws`;
}

function resolveWorldHttpUrl() {
  const configured = typeof process.env.EIDOVERSE_HTTP_URL === 'string' ? process.env.EIDOVERSE_HTTP_URL.trim() : '';
  if (configured) return configured;
  const url = new URL(resolveWorldWsUrl());
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function asConnectionError(error, fallback = 'Eidoverse Worlds is unavailable.') {
  if (error instanceof ServerError) return error;
  return new ServerError(`${fallback} ${error?.message || ''}`.trim(), {
    status: 503,
    code: 'EIDOVERSE_WORLD_UNAVAILABLE',
  });
}

function createWorldConnection({ world, id, avatar, agent = true, onClosed = null }) {
  const socket = new WebSocket(resolveWorldWsUrl());
  let closed = false;
  let failure = null;
  let openSettled = false;
  let snapshotSettled = false;
  let snapshotValue = null;
  let closeTimer = null;
  let openTimer = null;
  let snapshotTimer = null;
  let closeResolver = null;
  let messageTail = Promise.resolve();
  const pendingVerbs = [];

  const cleanupPending = (pending) => {
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.onAbort);
  };

  let resolveOpen;
  let rejectOpen;
  const openPromise = new Promise((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });

  let resolveSnapshot;
  let rejectSnapshot;
  const snapshotPromise = new Promise((resolve, reject) => {
    resolveSnapshot = resolve;
    rejectSnapshot = reject;
  });

  const settleOpen = (error = null) => {
    if (openSettled) return;
    openSettled = true;
    if (error) rejectOpen(error);
    else resolveOpen();
  };

  const settleSnapshot = (value, error = null) => {
    if (snapshotSettled) return;
    snapshotSettled = true;
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
    if (error) rejectSnapshot(error);
    else {
      snapshotValue = value;
      resolveSnapshot(value);
    }
  };

  const rejectPending = (error) => {
    while (pendingVerbs.length) {
      const pending = pendingVerbs.shift();
      cleanupPending(pending);
      pending.reject(error);
    }
  };

  const fail = (error, fallback) => {
    const normalized = asConnectionError(error, fallback);
    failure ||= normalized;
    settleOpen(failure);
    settleSnapshot(null, failure);
    rejectPending(failure);
    return failure;
  };

  const finishClose = () => {
    clearTimeout(closeTimer);
    closeTimer = null;
    if (closeResolver) {
      const resolve = closeResolver;
      closeResolver = null;
      resolve();
    }
  };

  const handleMessage = (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (message?.type === 'snapshot') {
      settleSnapshot(message);
      return;
    }
    if (message?.type === 'error') {
      fail(new ServerError(String(message.error || 'Eidoverse rejected the request.'), {
        status: 409,
        code: 'EIDOVERSE_WORLD_VERB_REJECTED',
      }));
      return;
    }
    if (message?.type !== 'log' || !message.entry || !pendingVerbs.length) return;
    const pending = pendingVerbs[0];
    if (message.entry.actor !== id || message.entry.verb !== pending.verb) return;
    pendingVerbs.shift();
    cleanupPending(pending);
    pending.resolve(message.entry);
  };

  const subscribe = socket.on.bind(socket);

  subscribe('open', () => {
    clearTimeout(openTimer);
    settleOpen();
    snapshotTimer = setTimeout(() => {
      fail(new Error('snapshot timeout'), 'Eidoverse Worlds did not send a snapshot in time.');
      socket.terminate();
    }, 10000);
    const join = {
      type: 'join',
      world,
      id,
      agent,
      avatar,
    };
    socket.send(JSON.stringify(join), (error) => {
      if (error) fail(error, 'Eidoverse Worlds rejected the join connection.');
    });
  });

  subscribe('message', (raw) => {
    messageTail = messageTail
      .then(() => handleMessage(raw))
      .catch((error) => {
        console.error(`❌ Eidoverse world message handling failed: ${error.message}`);
      });
  });

  subscribe('error', (error) => {
    fail(error, 'Eidoverse Worlds could not be reached.');
  });

  subscribe('close', () => {
    closed = true;
    clearTimeout(openTimer);
    if (!failure) fail(new Error('the world connection closed'), 'Eidoverse World connection closed.');
    finishClose();
    onClosed?.();
  });

  openTimer = setTimeout(() => {
    fail(new Error('connection timeout'), 'Eidoverse Worlds did not accept the connection in time.');
    socket.terminate();
  }, 8000);

  const waitForSnapshot = async ({ signal } = {}) => {
    await waitWithSignal(openPromise, signal);
    return waitWithSignal(snapshotPromise, signal);
  };

  const sendVerb = async (verb, args, { signal } = {}) => {
    await waitWithSignal(openPromise, signal);
    throwIfAborted(signal);
    if (closed || socket.readyState !== WebSocket.OPEN) throw failure || asConnectionError(new Error('socket is not open'));
    return new Promise((resolve, reject) => {
      const pending = {
        verb,
        resolve,
        reject,
        signal,
        onAbort: null,
        timer: setTimeout(() => {
          const index = pendingVerbs.indexOf(pending);
          if (index >= 0) pendingVerbs.splice(index, 1);
          cleanupPending(pending);
          reject(new ServerError(`Eidoverse did not acknowledge the ${verb} operation.`, {
            status: 504,
            code: 'EIDOVERSE_WORLD_ACK_TIMEOUT',
          }));
          socket.terminate();
        }, 10000),
      };
      if (signal) {
        pending.onAbort = () => {
          const index = pendingVerbs.indexOf(pending);
          if (index >= 0) pendingVerbs.splice(index, 1);
          cleanupPending(pending);
          reject(abortError(signal));
          socket.terminate();
        };
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      pendingVerbs.push(pending);
      if (signal?.aborted) {
        pending.onAbort();
        return;
      }
      socket.send(JSON.stringify({ type: 'verb', verb, args }), (error) => {
        if (!error) return;
        const index = pendingVerbs.indexOf(pending);
        if (index >= 0) pendingVerbs.splice(index, 1);
        cleanupPending(pending);
        reject(asConnectionError(error, 'Eidoverse Worlds could not receive the operation.'));
        socket.terminate();
      });
    });
  };

  const sendPose = (pose) => {
    if (closed || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: 'pose', pose }));
    return true;
  };

  const close = () => {
    if (closed || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      closeResolver = resolve;
      closeTimer = setTimeout(() => {
        socket.terminate();
        finishClose();
      }, 1500);
      socket.close();
    });
  };

  return Object.freeze({
    id,
    world,
    waitForSnapshot,
    sendVerb,
    sendPose,
    close,
    isOpen: () => !closed && socket.readyState === WebSocket.OPEN,
    getSnapshot: () => snapshotValue,
  });
}

function presenceSummary(presence = cosPresence) {
  return {
    connected: Boolean(presence?.connection?.isOpen()),
    id: presence?.connection?.id || null,
    world: presence?.connection?.world || null,
    role: presence?.snapshot?.yourRights?.role || null,
    gen: presence?.snapshot?.yourRights?.gen === true,
    joinedAt: presence?.joinedAt || null,
  };
}

async function assertInstalled() {
  const setup = await getEidoverseStatus();
  if (setup.installed) return setup;
  throw new ServerError('Install and start Eidoverse Worlds before using the PortOS world projection.', {
    status: 409,
    code: 'EIDOVERSE_NOT_INSTALLED',
  });
}

async function closeCosPresenceInternal() {
  const current = cosPresence;
  cosPresence = null;
  if (current?.connection) await current.connection.close();
}

function roleFromSnapshot(snapshot, id) {
  const role = snapshot?.state?.roles?.[id];
  return validRole(typeof role === 'string' ? role : role?.role);
}

async function rememberObservedRoles({ humanRole, cosRole }) {
  return mutateState((state) => {
    if (humanRole !== undefined) state.human.role = validRole(humanRole);
    if (cosRole !== undefined) state.cos.role = validRole(cosRole);
    return state;
  });
}

async function forgetRetiredOwners(targets) {
  if (!targets.length) return;
  const revoked = new Set(targets.map((entry) => `${entry.world}\0${entry.id}`));
  await mutateState((current) => {
    current.ownership.retired = current.ownership.retired.filter((entry) => (
      !revoked.has(`${entry.world}\0${entry.id}`)
    ));
    return current;
  });
}

async function recordRetiredOwnerCleanupFailures(failures) {
  if (!failures.length) {
    const state = await loadState();
    if (!state.reconciliation.retiredOwnerCleanup && !state.migrationReport?.retiredOwnerCleanup) return;
    await mutateState((current) => {
      delete current.reconciliation.retiredOwnerCleanup;
      if (current.migrationReport) delete current.migrationReport.retiredOwnerCleanup;
      return current;
    });
    return;
  }
  const failuresByOwner = new Map(failures.map(({ target, error }) => [
    `${target.world}\0${target.id}`,
    { target, error },
  ]));
  const report = await mutateState((state) => {
    let retryingCount = 0;
    let droppedCount = 0;
    state.ownership.retired = state.ownership.retired.flatMap((entry) => {
      const failure = failuresByOwner.get(`${entry.world}\0${entry.id}`);
      if (!failure) return [entry];
      const attempts = (entry.attempts || failure.target.attempts || 0) + 1;
      if (attempts >= RETIRED_OWNER_MAX_ATTEMPTS) {
        droppedCount += 1;
        return [];
      }
      retryingCount += 1;
      return [{ ...entry, attempts }];
    });
    const nextReport = {
      status: 'partial',
      failedCount: failuresByOwner.size,
      retryingCount,
      droppedCount,
      maxAttempts: RETIRED_OWNER_MAX_ATTEMPTS,
      codes: [...new Set([...failuresByOwner.values()].map(({ error }) => (
        safeText(error?.code, 'EIDOVERSE_OWNER_HANDOFF_FAILED', 80)
      )))].slice(0, 8),
      at: new Date().toISOString(),
    };
    state.reconciliation.retiredOwnerCleanup = nextReport;
    if (state.migrationReport) state.migrationReport.retiredOwnerCleanup = clone(nextReport);
    return nextReport;
  });
  console.warn(`⚠️ Eidoverse skipped ${report.failedCount} retired-owner cleanup operation(s); projection will continue`);
}

async function demoteRetiredOwners(connection, targets, {
  signal,
  pacing = createVerbPacing(),
} = {}) {
  const ordered = [...targets].sort((left, right) => (
    Number(left.id === connection.id) - Number(right.id === connection.id)
  ));
  const failures = [];
  const succeeded = [];
  for (const target of ordered) {
    await sendPacedVerb(connection, 'grant', { id: target.id, role: 'visitor' }, { signal, pacing }).then(
      () => succeeded.push(target),
      (error) => {
        if (signal?.aborted) throw error;
        failures.push({ target, error });
      },
    );
  }
  await forgetRetiredOwners(succeeded);
  return failures;
}

async function revokeRetiredOwners(connection, config, {
  signal,
  pacing = createVerbPacing(),
} = {}) {
  const state = await loadState();
  const targets = state.ownership.retired.filter((entry) => (
    entry.world !== config.world
    || (entry.id !== config.human.id && entry.id !== config.cos.id)
  ));
  if (!targets.length) {
    await recordRetiredOwnerCleanupFailures([]);
    return [];
  }
  const failures = [];

  const currentWorldTargets = targets.filter((entry) => entry.world === config.world);
  if (currentWorldTargets.length) {
    failures.push(...await demoteRetiredOwners(connection, currentWorldTargets, { signal, pacing }));
  }

  const priorWorldGroups = new Map();
  for (const target of targets.filter((entry) => entry.world !== config.world)) {
    const actorId = target.actorId || config.cos.id;
    const actorAvatar = target.actorAvatar || config.cos.avatar;
    const key = `${target.world}\0${actorId}\0${actorAvatar}`;
    const group = priorWorldGroups.get(key) || {
      world: target.world,
      actorId,
      actorAvatar,
      targets: [],
    };
    group.targets.push(target);
    priorWorldGroups.set(key, group);
  }

  for (const group of priorWorldGroups.values()) {
    throwIfAborted(signal);
    const priorConnection = createWorldConnection({
      world: group.world,
      id: group.actorId,
      avatar: group.actorAvatar,
      agent: true,
    });
    await priorConnection.waitForSnapshot({ signal }).then(async (snapshot) => {
      const actorRole = snapshot?.yourRights?.role || roleFromSnapshot(snapshot, group.actorId);
      if (actorRole !== 'owner') {
        const error = new ServerError('PortOS could not retire a previous Eidoverse owner identity.', {
          status: 409,
          code: 'EIDOVERSE_OWNER_HANDOFF_FAILED',
        });
        failures.push(...group.targets.map((target) => ({ target, error })));
        return;
      }
      failures.push(...await demoteRetiredOwners(priorConnection, group.targets, { signal }));
    }, async (error) => {
      if (signal?.aborted) throw error;
      const connectionError = asConnectionError(error, 'PortOS could not inspect a previous Eidoverse world.');
      failures.push(...group.targets.map((target) => ({ target, error: connectionError })));
    }).finally(() => priorConnection.close());
  }

  await recordRetiredOwnerCleanupFailures(failures);
  return targets;
}

/**
 * Join as the configured human before the CoS connection. This makes the
 * install's known human identity the first embodied joiner when a world is
 * created, so the world grants that identity ownership rather than allowing a
 * scheduled CoS projection to claim ownership by accident. If the human is an
 * owner, persist the CoS owner role through Eidoverse's own grant verb. The
 * projection manages terrain, sky, and role handoff, which are owner-only in
 * Eidoverse; this authority is separately default-off in PortOS.
 * The connection is intentionally short-lived; the browser performs the live
 * user session with the same durable id from the URL query parameters.
 */
async function seedHumanRoleAndCosGrant(config, { signal } = {}) {
  throwIfAborted(signal);
  const pacing = createVerbPacing();
  let connection;
  connection = createWorldConnection({
    world: config.world,
    id: config.human.id,
    avatar: config.human.avatar,
    agent: false,
  });
  return connection.waitForSnapshot({ signal }).then(async (snapshot) => {
    const humanRole = snapshot?.yourRights?.role || roleFromSnapshot(snapshot, config.human.id);
    let cosRole = roleFromSnapshot(snapshot, config.cos.id);
    if (config.human.id !== config.cos.id
      && humanRole === 'owner'
      && cosRole !== 'owner') {
      await sendPacedVerb(connection, 'grant', { id: config.cos.id, role: 'owner' }, { signal, pacing });
      cosRole = 'owner';
    }
    return { humanRole, cosRole };
  }).then((roles) => connection.close().then(async () => {
    await rememberObservedRoles(roles);
    return roles;
  }), (error) => connection.close().then(() => { throw error; }));
}

async function ensureCosPresenceInternal({ fresh = false, signal } = {}) {
  throwIfAborted(signal);
  const config = await ensureEidoverseWorldConfig();
  throwIfAborted(signal);
  if (!config.cos.enabled) {
    throw new ServerError('The PortOS CoS presence is disabled in the Eidoverse world configuration.', {
      status: 409,
      code: 'EIDOVERSE_COS_DISABLED',
    });
  }
  if (fresh || (cosPresence && !cosPresence.connection.isOpen())) await closeCosPresenceInternal();
  if (cosPresence?.connection.isOpen()) return cosPresence;

  await seedHumanRoleAndCosGrant(config, { signal });

  let connection;
  const pacing = createVerbPacing();
  connection = createWorldConnection({
    world: config.world,
    id: config.cos.id,
    avatar: config.cos.avatar,
    agent: true,
    onClosed: () => {
      if (cosPresence?.connection === connection) cosPresence = null;
    },
  });
  return connection.waitForSnapshot({ signal }).then(async (snapshot) => {
    const cosRole = snapshot?.yourRights?.role || roleFromSnapshot(snapshot, config.cos.id);
    let humanRole = roleFromSnapshot(snapshot, config.human.id);
    if (config.human.id !== config.cos.id && cosRole === 'owner' && humanRole !== 'owner') {
      await sendPacedVerb(connection, 'grant', { id: config.human.id, role: 'owner' }, { signal, pacing });
      humanRole = 'owner';
    }
    if (cosRole === 'owner') await revokeRetiredOwners(connection, config, { signal, pacing });
    return rememberObservedRoles({ humanRole, cosRole }).then(() => {
      cosPresence = {
        connection,
        snapshot,
        joinedAt: new Date().toISOString(),
        pacing,
      };
      return cosPresence;
    });
  }).catch((error) => connection.close().then(() => { throw error; }));
}

export async function ensureEidoverseWorldPresence() {
  return worldLock(async () => {
    await assertInstalled();
    const presence = await ensureCosPresenceInternal();
    return presenceSummary(presence);
  });
}

const libraryUrl = (path, query = null) => {
  const url = new URL(path, resolveWorldHttpUrl());
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
  return url;
};

async function fetchLibraryJson(path, query, { signal } = {}) {
  const response = await waitWithSignal(fetch(libraryUrl(path, query), { signal }), signal).catch((error) => {
    throw new ServerError(`Eidoverse asset library is unavailable: ${error.message}`, {
      status: 503,
      code: 'EIDOVERSE_ASSET_LIBRARY_UNAVAILABLE',
    });
  });
  if (!response.ok) {
    throw new ServerError(`Eidoverse asset library returned HTTP ${response.status}.`, {
      status: 503,
      code: 'EIDOVERSE_ASSET_LIBRARY_UNAVAILABLE',
    });
  }
  return response.json();
}

async function preflightEidoverseProtocol({ signal } = {}) {
  const response = await waitWithSignal(fetch(libraryUrl('/version'), { signal }), signal).catch((error) => {
    throw new ServerError(`Eidoverse Worlds is not reachable yet: ${error.message}`, {
      status: 503,
      code: 'EIDOVERSE_WORLD_UNAVAILABLE',
    });
  });
  if (response.status >= 500) {
    throw new ServerError(`Eidoverse Worlds is temporarily unavailable (HTTP ${response.status}). Retry after its managed runtime finishes starting.`, {
      status: 503,
      code: 'EIDOVERSE_WORLD_UNAVAILABLE',
    });
  }
  if (!response.ok) {
    throw new ServerError('This Eidoverse Worlds runtime is too old for PortOS World Design V2. Update its managed app from Apps, then retry.', {
      status: 409,
      code: 'EIDOVERSE_PROTOCOL_INCOMPATIBLE',
      context: { remediation: '/apps', required: 'world-design-v2' },
    });
  }
  const version = await response.json().catch(() => null);
  if (!version || typeof version.sha !== 'string' || typeof version.commitTime !== 'string') {
    throw new ServerError('Eidoverse Worlds did not report the protocol build identity required by PortOS World Design V2. Update its managed app from Apps, then retry.', {
      status: 409,
      code: 'EIDOVERSE_PROTOCOL_INCOMPATIBLE',
      context: { remediation: '/apps', required: 'world-design-v2' },
    });
  }
  return {
    sha: safeText(version.sha, 'unknown', 80),
    commitTime: safeText(version.commitTime, 'unknown', 80),
  };
}

async function verifyLibraryAsset(path, { signal } = {}) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const response = await waitWithSignal(fetch(libraryUrl(`/library/${encoded}`), {
    method: 'HEAD',
    signal,
  }), signal).catch((error) => {
    throw new ServerError(`Eidoverse could not verify ${path}: ${error.message}`, {
      status: 409,
      code: 'EIDOVERSE_ASSET_PREFLIGHT_FAILED',
    });
  });
  if (!response.ok) {
    throw new ServerError(`Eidoverse could not load the resolved library asset ${path}.`, {
      status: 409,
      code: 'EIDOVERSE_ASSET_PREFLIGHT_FAILED',
    });
  }
}

async function unavailableLibraryAssets(paths, { signal, verifiedPaths = new Set() } = {}) {
  const candidates = [...new Set(paths)].filter((path) => path && !verifiedPaths.has(path));
  const checks = await Promise.all(candidates.map((path) => (
    verifyLibraryAsset(path, { signal }).then(
      () => {
        verifiedPaths.add(path);
        return null;
      },
      () => {
        throwIfAborted(signal);
        return path;
      },
    )
  )));
  return new Set(checks.filter(Boolean));
}

async function persistAssetLock(resolutions, runtimeVersion) {
  return mutateState((state) => {
    state.assetResolutions = resolutions;
    state.assetRecipeVersion = EIDOVERSE_ASSET_RECIPE_VERSION;
    state.recipe = resolveEidoverseDesign(state.userOverrides, state.assetResolutions);
    state.reconciliation = {
      ...state.reconciliation,
      status: 'applying',
      checkpoint: 'asset-preflight-complete',
      error: null,
      errorCode: null,
      errorContext: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      planFingerprint: null,
      operationCount: 0,
      appliedOperations: 0,
      compensationStatus: null,
      runtimeVersion,
    };
    return configFromState(state);
  });
}

async function resolveAndLockAssets(config, { signal } = {}) {
  const runtimeVersion = await preflightEidoverseProtocol({ signal });
  const existing = config.design?.assetResolutions || {};
  const overrides = config.design?.userOverrides?.assets || {};
  const explicitOverrides = Object.values(overrides);
  if (explicitOverrides.some((path) => !isValidEidoverseAssetOverridePath(path))) {
    throw new ServerError('A preserved Eidoverse asset override is invalid. Reset the affected asset slot, then retry.', {
      status: 409,
      code: 'EIDOVERSE_ASSET_OVERRIDE_INVALID',
    });
  }
  const lockInspection = inspectEidoverseAssetResolutionLocks({ existing, overrides });
  const verifiedPaths = new Set();
  const unavailablePaths = await unavailableLibraryAssets([
    ...Object.values(lockInspection.resolutions).map(({ path }) => path),
    ...explicitOverrides,
  ], { signal, verifiedPaths });
  const unavailableOverrideSlots = Object.entries(overrides)
    .filter(([, path]) => unavailablePaths.has(path))
    .map(([slot]) => slot);
  if (unavailableOverrideSlots.length) {
    throw new ServerError(`Eidoverse could not load the local asset override for: ${unavailableOverrideSlots.join(', ')}. Clear or replace the override, then retry.`, {
      status: 409,
      code: 'EIDOVERSE_ASSET_OVERRIDE_UNAVAILABLE',
      context: { missing: unavailableOverrideSlots },
    });
  }
  if (lockInspection.current && unavailablePaths.size === 0) {
    return persistAssetLock(lockInspection.resolutions, runtimeVersion);
  }

  const files = await fetchLibraryJson('/library-list', { dir: 'eidoverse/assets/models' }, { signal });
  if (!Array.isArray(files)) {
    throw new ServerError('Eidoverse returned an invalid model-library catalog.', {
      status: 503,
      code: 'EIDOVERSE_ASSET_LIBRARY_INVALID',
    });
  }

  const recipe = config.recipe.assetRecipe;
  const resolvedAt = new Date().toISOString();
  const searchResults = {};
  const resolveAvailable = () => resolveEidoverseAssetRecipe({
    files: files.filter((candidate) => !unavailablePaths.has(candidate?.path || candidate)),
    searchResults: Object.fromEntries(Object.entries(searchResults).map(([query, candidates]) => [
      query,
      candidates.filter((candidate) => !unavailablePaths.has(candidate?.path)),
    ])),
    existing: Object.fromEntries(Object.entries(existing).filter(([, lock]) => (
      !unavailablePaths.has(typeof lock === 'string' ? lock : lock?.path)
    ))),
    overrides,
    resolvedAt,
  });
  const unresolvedError = (missing) => new ServerError(`Eidoverse is missing required PortOS world assets: ${missing.join(', ')}.`, {
    status: 409,
    code: 'EIDOVERSE_ASSET_RECIPE_UNRESOLVED',
    context: { missing, assetRecipeVersion: EIDOVERSE_ASSET_RECIPE_VERSION },
  });
  const resolveVerified = async (attempt = 0) => {
    const result = resolveAvailable();
    if (result.missing.length) {
      const unresolvedSlots = result.missing.map((slotName) => recipe.slots[slotName]).filter(Boolean);
      const queries = [...new Set(unresolvedSlots
        .flatMap((slot) => slot.fallbackQueries)
        .filter((query) => query && !Object.hasOwn(searchResults, query)))];
      if (queries.length === 0) throw unresolvedError(result.missing);
      const searchPairs = await Promise.all(queries.map(async (query) => {
        const candidates = await fetchLibraryJson('/library-models', { q: query }, { signal });
        if (!Array.isArray(candidates)) {
          throw new ServerError('Eidoverse returned invalid model search results.', {
            status: 503,
            code: 'EIDOVERSE_ASSET_LIBRARY_INVALID',
          });
        }
        return [query, candidates];
      }));
      Object.assign(searchResults, Object.fromEntries(searchPairs));
      return resolveVerified(attempt + 1);
    }
    const failedPaths = await unavailableLibraryAssets(
      Object.values(result.resolutions).map(({ path }) => path),
      { signal, verifiedPaths },
    );
    if (failedPaths.size === 0) return result;
    for (const path of failedPaths) unavailablePaths.add(path);
    if (attempt >= files.length + Object.keys(recipe.slots).length) {
      throw unresolvedError(Object.keys(recipe.slots));
    }
    return resolveVerified(attempt + 1);
  };
  const result = await resolveVerified();

  return persistAssetLock(result.resolutions, runtimeVersion);
}

function createVerbPacing() {
  return { lastVerbSentAt: null };
}

async function sendPacedVerb(connection, verb, args, {
  signal,
  pacing = createVerbPacing(),
} = {}) {
  throwIfAborted(signal);
  if (pacing.lastVerbSentAt !== null) {
    const wait = PROJECTION_VERB_INTERVAL_MS - (Date.now() - pacing.lastVerbSentAt);
    if (wait > 0) await abortableDelay(wait, signal);
  }
  await connection.sendVerb(verb, args, { signal });
  pacing.lastVerbSentAt = Date.now();
}

async function sendOperations(connection, operations, {
  signal,
  onApplied,
  pacing = createVerbPacing(),
} = {}) {
  for (const operation of operations) {
    await sendPacedVerb(connection, operation.verb, operation.args, { signal, pacing });
    onApplied?.(operation);
  }
}

async function recordReconciliationCheckpoint(patch) {
  return mutateState((state) => {
    state.reconciliation = { ...state.reconciliation, ...patch };
    return clone(state.reconciliation);
  });
}

function restoreEntityOperations(id, entity) {
  if (!entity) return [];
  if (entity.kind === 'light') {
    return [{ layer: 'compensation', verb: 'light', args: {
      id,
      pos: entity.pos,
      color: entity.color,
      intensity: entity.intensity,
      range: entity.range,
      ...(entity.keep ? { keep: true } : {}),
      ...(entity.day === false ? { day: false } : {}),
    } }];
  }
  if (!entity.lib) return [];
  const operations = [{ layer: 'compensation', verb: 'spawn', args: {
    id,
    lib: entity.lib,
    pos: entity.pos || [0, 0, 0],
    yaw: entity.yaw || 0,
    ...(entity.scale !== undefined ? { scale: entity.scale } : {}),
    ...(entity.collide ? { collide: entity.collide } : {}),
  } }];
  for (const [type, data] of Object.entries(entity.comp || {})) {
    // Legacy PortOS components may predate the privacy-safe WorldSignal shape.
    // They are visually inert, so do not duplicate their old contents into a
    // new append-only log during rollback.
    if (type === COMPONENT_TYPE && !(
      data?.managedBy === 'portos'
      && data?.designVersion === EIDOVERSE_WORLD_DESIGN_VERSION
      && data?.disclosure === 'aggregate'
    )) continue;
    operations.push({ layer: 'compensation', verb: 'comp', args: { id, type, data } });
  }
  return operations;
}

function inverseOperationsFor(operation, currentState) {
  const id = operation.args?.id;
  const existing = id ? currentState?.entities?.[id] : null;
  switch (operation.verb) {
    case 'spawn':
      return [{ layer: 'compensation', verb: 'remove', args: { id } }];
    case 'place':
      return existing ? [{ layer: 'compensation', verb: 'place', args: {
        id,
        pos: existing.pos || [0, 0, 0],
        yaw: existing.yaw || 0,
        ...(existing.scale !== undefined ? { scale: existing.scale } : {}),
      } }] : [];
    case 'comp':
      return [{ layer: 'compensation', verb: 'comp', args: {
        id,
        type: operation.args.type,
        data: existing?.comp?.[operation.args.type] ?? null,
      } }];
    case 'remove':
      return restoreEntityOperations(id, existing);
    case 'light':
      return existing
        ? restoreEntityOperations(id, existing)
        : [{ layer: 'compensation', verb: 'remove', args: { id } }];
    case 'terrain':
      return [{
        layer: 'compensation',
        verb: 'terrain',
        args: currentState?.terrain || {
          seed: 'portos-legacy-neutral', size: 128, segments: 2, amplitude: 0, flatRadius: 128,
          layers: [{ color: '#142338', repeat: 1 }],
        },
      }];
    case 'sky':
      return [{
        layer: 'compensation',
        verb: 'sky',
        args: currentState?.sky || {
          system: 'skymesh', hours: 0, azimuth: 0, sun: 0, ambient: 0.15,
          fill: 0, exposure: 0.35, fog: 1, clouds: 'none', weather: 'clear',
        },
      }];
    case 'grass':
      return [{
        layer: 'compensation',
        verb: 'grass',
        args: currentState?.grass || { clear: true },
      }];
    default:
      return [];
  }
}

function compensationOperations(applied, currentState) {
  return [...applied].reverse().flatMap((operation) => inverseOperationsFor(operation, currentState));
}

// Infrastructure and live signals are proven first so a V2 update cannot make
// its new atmosphere authoritative without the semantic world beneath it. The
// ambient layer follows the environment, then reconciliation retires only old
// PortOS-managed ids.
const PROJECTION_UPDATE_STAGES = ['infrastructure', 'live', 'environment', 'ambient', 'reconciliation'];
const PROJECTION_FRESH_STAGES = ['environment', 'infrastructure', 'live', 'ambient', 'reconciliation'];

async function applyProjectionPlan(presence, plan, { signal, freshInstall = false } = {}) {
  const applied = [];
  const planFingerprint = shortHash(canonicalStringify({
    designVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
    operations: plan.operations,
  }));
  await recordReconciliationCheckpoint({
    status: 'applying',
    checkpoint: 'plan-ready',
    planFingerprint,
    operationCount: plan.operations.length,
    appliedOperations: 0,
    compensationStatus: null,
  });

  const stageOrder = freshInstall ? PROJECTION_FRESH_STAGES : PROJECTION_UPDATE_STAGES;
  const stages = stageOrder.map((stage) => [
    stage,
    plan.operations.filter((operation) => operation.layer === stage),
  ]);
  const pacing = presence.pacing || createVerbPacing();
  const execution = stages.reduce((promise, [stage, operations]) => promise.then(async () => {
    if (operations.length === 0) return;
    await recordReconciliationCheckpoint({ checkpoint: `applying-${stage}` });
    await sendOperations(presence.connection, operations, {
      signal,
      pacing,
      onApplied: (operation) => applied.push(operation),
    });
    await recordReconciliationCheckpoint({
      checkpoint: `${stage}-complete`,
      appliedOperations: applied.length,
    });
  }), Promise.resolve());

  return execution.catch(async (error) => {
    const rollback = compensationOperations(applied, presence.snapshot?.state || {});
    await recordReconciliationCheckpoint({
      status: 'compensating',
      checkpoint: 'compensation-started',
      appliedOperations: applied.length,
      compensationStatus: 'running',
    });
    const compensation = ensureCosPresenceInternal({ fresh: true })
      .then((recoveryPresence) => sendOperations(recoveryPresence.connection, rollback, {
        pacing: recoveryPresence.pacing,
      }));
    return compensation.then(
      async () => {
        await recordReconciliationCheckpoint({
          status: 'pending',
          checkpoint: 'compensation-complete',
          compensationStatus: 'complete',
        });
        error.compensationStatus = 'complete';
        throw error;
      },
      async (compensationError) => {
        await recordReconciliationCheckpoint({
          status: 'pending',
          checkpoint: 'compensation-failed',
          compensationStatus: 'failed',
          compensationError: safeText(compensationError?.message, 'Rollback failed', 500),
        });
        error.compensationStatus = 'failed';
        error.compensationError = compensationError;
        throw error;
      },
    );
  });
}

function reconciliationErrorContext(error) {
  if (['EIDOVERSE_ASSET_RECIPE_UNRESOLVED', 'EIDOVERSE_ASSET_OVERRIDE_UNAVAILABLE'].includes(error?.code)) {
    return {
      missing: Array.isArray(error.context?.missing)
        ? error.context.missing.filter((slot) => typeof slot === 'string').slice(0, 16)
        : [],
      assetRecipeVersion: EIDOVERSE_ASSET_RECIPE_VERSION,
    };
  }
  if (error?.code === 'EIDOVERSE_PROTOCOL_INCOMPATIBLE') {
    return { remediation: '/apps', required: 'world-design-v2' };
  }
  return null;
}

async function recordProjection({ success, summary = null, error = null }) {
  const now = new Date().toISOString();
  return mutateState((state) => {
    state.projection = {
      ...state.projection,
      lastRunAt: now,
      ...(success ? { lastSuccessAt: now, lastError: null, lastSummary: summary } : {
        lastError: safeText(error?.message || error, 'Projection failed', 500),
      }),
    };
    if (success) {
      state.lastAppliedDesignVersion = EIDOVERSE_WORLD_DESIGN_VERSION;
      state.pendingDesignVersion = null;
      state.reconciliation = {
        ...state.reconciliation,
        status: 'complete',
        checkpoint: 'projection-committed',
        error: null,
        errorCode: null,
        errorContext: null,
        completedAt: now,
        appliedOperations: summary?.operationCount ?? state.reconciliation.operationCount,
        compensationStatus: null,
        compensationError: null,
      };
      if (state.migrationReport?.status === 'ready') state.migrationReport.status = 'applied';
    } else {
      state.pendingDesignVersion = EIDOVERSE_WORLD_DESIGN_VERSION;
      state.reconciliation = {
        ...state.reconciliation,
        status: 'failed',
        checkpoint: state.reconciliation?.checkpoint || 'projection-started',
        error: safeText(error?.message || error, 'Projection failed', 500),
        errorCode: safeText(error?.code, '', 80) || null,
        errorContext: reconciliationErrorContext(error),
        completedAt: now,
      };
    }
    return state.projection;
  });
}

export async function projectEidoverseWorld({ signal } = {}) {
  const run = async () => {
    throwIfAborted(signal);
    await assertInstalled();
    const config = await ensureEidoverseWorldConfig();
    const lockedConfig = await resolveAndLockAssets(config, { signal });
    const presence = await ensureCosPresenceInternal({ fresh: true, signal });
    const source = await collectEidoverseWorldSources({ signal });
    throwIfAborted(signal);
    const plan = buildProjectionPlan({
      source,
      recipe: lockedConfig.recipe,
      currentState: presence.snapshot?.state || {},
    });
    await applyProjectionPlan(presence, plan, {
      signal,
      freshInstall: lockedConfig.design.lastAppliedVersion === null,
    });
    const summary = {
      world: lockedConfig.world,
      cosId: lockedConfig.cos.id,
      assetRecipeVersion: lockedConfig.design.assetRecipeVersion,
      assetCatalogFingerprint: Object.values(lockedConfig.design.assetResolutions)[0]?.catalogFingerprint || null,
      ...plan.summary,
    };
    const projection = await recordProjection({ success: true, summary });
    const appliedConfig = configFromState(await loadState());
    return {
      success: true,
      summary,
      projection,
      presence: presenceSummary(presence),
      design: appliedConfig.design,
      recipe: appliedConfig.recipe,
    };
  };

  return worldLock(() => run().catch(async (error) => {
    await recordProjection({ success: false, error });
    throw error;
  }));
}

/**
 * Boot-time, non-AI reconciliation for an update-prepared design. It never
 * starts or installs the external runtime: if Eidoverse is not already online,
 * the pending checkpoint remains visible for the page to remediate later.
 */
async function recoverInterruptedProjection() {
  const state = await loadState();
  if (!['applying', 'compensating'].includes(state.reconciliation.status)) {
    return { recovered: false, state };
  }
  const interruptedStatus = state.reconciliation.status;
  const recoveredState = await mutateState((current) => {
    current.pendingDesignVersion = EIDOVERSE_WORLD_DESIGN_VERSION;
    current.reconciliation = {
      ...current.reconciliation,
      status: 'failed',
      checkpoint: 'interrupted',
      error: 'The previous Eidoverse projection stopped before it completed. Retry the world update.',
      errorCode: 'EIDOVERSE_PROJECTION_INTERRUPTED',
      errorContext: null,
      completedAt: new Date().toISOString(),
      ...(interruptedStatus === 'compensating' ? { compensationStatus: 'interrupted' } : {}),
    };
    return clone(current);
  });
  return { recovered: true, state: recoveredState };
}

export async function reconcilePendingEidoverseWorld() {
  const recovery = await recoverInterruptedProjection();
  if (recovery.recovered) return { reconciled: false, reason: 'interrupted' };
  const { features } = await getInstanceFeatures();
  if (features.find(({ id }) => id === 'eidoverse')?.enabled !== true) {
    return { reconciled: false, reason: 'feature-disabled' };
  }
  const setup = await getEidoverseStatus();
  const state = recovery.state;
  if (state.pendingDesignVersion !== EIDOVERSE_WORLD_DESIGN_VERSION
    || (state.lastAppliedDesignVersion === null && !state.migrationReport)) {
    return { reconciled: false, reason: 'current' };
  }
  if (!setup.installed) return { reconciled: false, reason: 'not-installed' };
  if (setup.runtimeStatus !== 'online') return { reconciled: false, reason: 'runtime-offline' };
  const result = await projectEidoverseWorld();
  return { reconciled: true, result };
}

function objectArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ServerError('Eidoverse operation args must be an object.', {
      status: 400,
      code: 'EIDOVERSE_ARGUMENT_INVALID',
    });
  }
  if (JSON.stringify(args).length > 8192) {
    throw new ServerError('Eidoverse operation args must be at most 8KB.', {
      status: 400,
      code: 'EIDOVERSE_ARGUMENT_INVALID',
    });
  }
  return args;
}

function normalizeAugmentOperation(operation) {
  const args = objectArgs(operation.args);
  switch (operation.verb) {
    case 'spawn': {
      const normalized = {
        id: validEntityId(args.id),
        lib: validAssetPath(args.lib),
        pos: args.pos === undefined ? [0, 0, 0] : vector3(args.pos, 'spawn.pos'),
        yaw: safeNumber(args.yaw, 'spawn.yaw', { fallback: 0 }),
        scale: safeNumber(args.scale, 'spawn.scale', { min: 0.01, max: 20, fallback: 1 }),
      };
      if (args.collide !== undefined) {
        if (!['box', 'exact'].includes(args.collide)) {
          throw new ServerError('spawn.collide must be box or exact.', { status: 400, code: 'EIDOVERSE_ARGUMENT_INVALID' });
        }
        normalized.collide = args.collide;
      }
      return { verb: operation.verb, args: normalized };
    }
    case 'place': {
      const normalized = { id: validEntityId(args.id) };
      if (args.pos !== undefined) normalized.pos = vector3(args.pos, 'place.pos');
      if (args.yaw !== undefined) normalized.yaw = safeNumber(args.yaw, 'place.yaw');
      if (args.scale !== undefined) normalized.scale = safeNumber(args.scale, 'place.scale', { min: 0.01, max: 20 });
      if (Object.keys(normalized).length === 1) {
        throw new ServerError('place needs pos, yaw, or scale.', { status: 400, code: 'EIDOVERSE_ARGUMENT_INVALID' });
      }
      return { verb: operation.verb, args: normalized };
    }
    case 'remove':
      return { verb: operation.verb, args: { id: validEntityId(args.id) } };
    case 'comp': {
      const id = validEntityId(args.id);
      const type = safeText(args.type, '').slice(0, 32);
      if (!COMPONENT_TYPE_RE.test(type)) {
        throw new ServerError('comp.type is invalid.', { status: 400, code: 'EIDOVERSE_ARGUMENT_INVALID' });
      }
      const data = args.data === undefined ? null : args.data;
      if (JSON.stringify(data).length > 8192) {
        throw new ServerError('comp.data must be at most 8KB.', { status: 400, code: 'EIDOVERSE_ARGUMENT_INVALID' });
      }
      return { verb: operation.verb, args: { id, type, data } };
    }
    case 'light':
      return {
        verb: operation.verb,
        args: {
          id: validEntityId(args.id),
          pos: args.pos === undefined ? [0, 1, 0] : vector3(args.pos, 'light.pos'),
          color: safeNumber(args.color, 'light.color', { min: 0, max: 0xffffff, fallback: 0xffd9a0 }),
          intensity: safeNumber(args.intensity, 'light.intensity', { min: 0, max: 100, fallback: 16 }),
          range: safeNumber(args.range, 'light.range', { min: 0.1, max: 100, fallback: 10 }),
        },
      };
    case 'grant': {
      const id = validEntityId(args.id);
      const normalized = { id };
      if (args.role !== undefined) {
        if (!['owner', 'builder', 'visitor'].includes(args.role)) {
          throw new ServerError('grant.role must be owner, builder, or visitor.', { status: 400, code: 'EIDOVERSE_ARGUMENT_INVALID' });
        }
        normalized.role = args.role;
      }
      if (args.gen !== undefined) {
        if (typeof args.gen !== 'boolean') {
          throw new ServerError('grant.gen must be boolean.', { status: 400, code: 'EIDOVERSE_ARGUMENT_INVALID' });
        }
        normalized.gen = args.gen;
      }
      if (!Object.hasOwn(normalized, 'role') && !Object.hasOwn(normalized, 'gen')) {
        throw new ServerError('grant needs role or gen.', { status: 400, code: 'EIDOVERSE_ARGUMENT_INVALID' });
      }
      return { verb: operation.verb, args: normalized };
    }
    case 'terrain':
    case 'grass':
    case 'sky':
      return { verb: operation.verb, args: JSON.parse(JSON.stringify(args)) };
    default:
      throw new ServerError(`Eidoverse verb is not available through PortOS: ${operation.verb}`, {
        status: 400,
        code: 'EIDOVERSE_ARGUMENT_INVALID',
      });
  }
}

export async function augmentEidoverseWorld(operations, { signal } = {}) {
  return worldLock(async () => {
    throwIfAborted(signal);
    await assertInstalled();
    const presence = await ensureCosPresenceInternal({ signal });
    const normalized = operations.map(normalizeAugmentOperation);
    await sendOperations(presence.connection, normalized, { signal, pacing: presence.pacing });
    return {
      success: true,
      world: presence.connection.world,
      applied: normalized.length,
      presence: presenceSummary(presence),
    };
  });
}

export async function sayInEidoverseWorld(text, { signal } = {}) {
  return worldLock(async () => {
    throwIfAborted(signal);
    await assertInstalled();
    const presence = await ensureCosPresenceInternal({ signal });
    const message = safeText(text, '', 2000);
    if (!message) {
      throw new ServerError('A non-empty Eidoverse message is required.', {
        status: 400,
        code: 'EIDOVERSE_ARGUMENT_INVALID',
      });
    }
    await sendPacedVerb(presence.connection, 'say', { text: message }, {
      signal,
      pacing: presence.pacing,
    });
    return { success: true, world: presence.connection.world, id: presence.connection.id };
  });
}

export async function getEidoverseWorldStatus() {
  const [setup, self] = await Promise.all([getEidoverseStatus(), getSelf()]);
  const config = await readEidoverseWorldConfig(self);
  return {
    ...config,
    identity: config.human,
    presence: presenceSummary(),
    setup: {
      installed: setup.installed,
      runtimeStatus: setup.runtimeStatus,
      appId: setup.appId,
      worldDataReady: setup.worldDataReady,
    },
    instance: {
      id: self?.instanceId || null,
      name: self?.name || null,
    },
    storage: {
      classification: 'file-primary',
      portosConfig: 'data/eidoverse/portos-world.json',
      worldData: 'data/eidoverse/worlds',
      federation: 'machine-local',
      externalRuntime: 'private Eidoverse checkout state',
    },
  };
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

export async function closeEidoverseWorldConnections() {
  return worldLock(() => closeCosPresenceInternal());
}

export const __resetEidoverseWorldForTests = closeEidoverseWorldConnections;
