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
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { atomicWrite, dataPath, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { ServerError } from '../lib/errorHandler.js';
import { getAllApps, getAppStatuses } from './apps.js';
import { getStatus as getCosStatus, getAgents, getCosTasks, getTodayActivity } from './cos.js';
import { getPendingCounts } from './review.js';
import { getSelf, getPeers, ensureSelf } from './instances.js';
import { getInstanceFeatures } from './instanceFeatures.js';
import * as backup from './backup.js';
import { getCountsByType } from './notifications.js';
import { getCharacter } from './character.js';
import { getLatestMetricValues } from './appleHealthQuery.js';
import { getVoiceConfig } from './voice/config.js';
import { getMemoryStats } from '../lib/memoryStats.js';
import { getGoals, getChronotype } from './identity.js';
import { getActivityCalendar, getVelocityMetrics } from './productivity.js';
import { getBrainGraphOverview } from './brainGraph.js';
import { getInboxLogCounts } from './brainStorage.js';
import { getOpenWorldIntrospection } from './openWorldIntrospection.js';
import { fetchMyCurrentSprintTickets } from './jira.js';
import { getEidoverseStatus, EIDOVERSE_PORT } from './eidoverse.js';

const DATA_DIR = dataPath('eidoverse');
const STATE_FILE = join(DATA_DIR, 'portos-world.json');
const WORLD_NAME_RE = /^[a-z0-9_-]{1,64}$/i;
const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COMPONENT_TYPE_RE = /^[A-Za-z0-9._:-]{1,32}$/;
const ASSET_PATH_RE = /^(?:eidoverse|store)\//i;
const PROJECTION_ID_PREFIX = 'portos-projection-';
const COMPONENT_TYPE = 'portos';
const COMPONENT_RESOURCE_BY_KIND = Object.freeze({
  app: 'apps',
  agent: 'agents',
  task: 'tasks',
  feature: 'features',
  peer: 'peers',
  health: 'health',
  productivity: 'productivity',
  activity: 'activity',
  goal: 'goals',
  memory: 'memory',
  storage: 'storage',
  jira: 'jira',
  operations: 'operations',
});
const DEFAULT_WORLD = 'portos';
const DEFAULT_HUMAN_AVATAR = 'eidoverse/assets/vrms/claude.vrm';
const DEFAULT_COS_ID = 'portos-cos';
const DEFAULT_COS_AVATAR = 'eidoverse/assets/vrms/claude_suit.vrm';
const PROJECTION_VERB_INTERVAL_MS = 350;
const WORLD_ROLES = new Set(['owner', 'builder', 'visitor']);

const MODEL_ROOT = 'eidoverse/assets/models/';
const HEALTH_METRIC_KEYS = ['heart_rate', 'step_count', 'active_energy', 'sleep_analysis'];

export const DEFAULT_EIDOVERSE_PROJECTION_RECIPE = Object.freeze({
  version: 1,
  includes: {
    apps: true,
    agents: true,
    tasks: true,
    features: true,
    peers: true,
    health: true,
    productivity: true,
    activity: true,
    goals: true,
    memory: true,
    storage: true,
    jira: true,
    operations: true,
  },
  limits: {
    apps: 48,
    agents: 24,
    tasks: 48,
    features: 32,
    peers: 16,
    health: 1,
    productivity: 1,
    activity: 24,
    goals: 32,
    memory: 16,
    storage: 48,
    jira: 48,
    operations: 1,
  },
  layout: {
    origin: [-24, 0, -24],
    spacing: 7,
    // Keep the expanded resource lanes compact enough to stay near the
    // authored terrain while still leaving a visible gap between families.
    laneGap: 6,
    columns: 8,
  },
  scale: {
    app: 1,
    agent: 1,
    task: 0.8,
    feature: 1,
    peer: 1.2,
    health: 1.2,
    productivity: 1.2,
    activity: 0.55,
    goal: 1.1,
    memory: 0.9,
    storage: 0.8,
    jira: 0.75,
    operations: 1.3,
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
    seed: 'portos',
    size: 128,
    segments: 64,
    amplitude: 1.8,
    flatRadius: 28,
    layers: [
      { color: '#142338', repeat: 18 },
      { color: '#1c3b43', repeat: 10 },
    ],
  },
});

const DEFAULT_STATE = {
  schemaVersion: 1,
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

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
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

function mergeRecipe(recipe) {
  const input = recipe && typeof recipe === 'object' && !Array.isArray(recipe) ? recipe : {};
  const defaults = DEFAULT_EIDOVERSE_PROJECTION_RECIPE;
  return {
    version: 1,
    includes: { ...defaults.includes, ...(input.includes || {}) },
    limits: { ...defaults.limits, ...(input.limits || {}) },
    layout: { ...defaults.layout, ...(input.layout || {}) },
    scale: { ...defaults.scale, ...(input.scale || {}) },
    assets: { ...defaults.assets, ...(input.assets || {}) },
    terrain: {
      ...defaults.terrain,
      ...(input.terrain || {}),
      layers: Array.isArray(input.terrain?.layers)
        ? input.terrain.layers.map((layer) => ({ ...layer }))
        : defaults.terrain.layers.map((layer) => ({ ...layer })),
    },
  };
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
    entries.set(key, {
      world,
      id,
      ...(actorId ? {
        actorId,
        actorAvatar: isSafeAssetPath(normalizedAvatar) ? normalizedAvatar : DEFAULT_COS_AVATAR,
      } : {}),
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
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    schemaVersion: 1,
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
    recipe: mergeRecipe(input.recipe),
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
  const instanceName = validIdentity(self?.name, '');
  if (instanceName) return { name: instanceName, source: 'instance-name' };
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
    const updated = await mutateState((state) => {
      const previousPresenceConfig = {
        world: state.world,
        humanName: state.human.name,
        humanAvatar: state.human.avatar,
        cosId: state.cos.id,
        cosAvatar: state.cos.avatar,
        cosEnabled: state.cos.enabled,
      };
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
      if (patch.recipe !== undefined) state.recipe = mergeRecipe(patch.recipe);
      const worldChanged = previousPresenceConfig.world !== state.world;
      const humanChanged = previousPresenceConfig.humanName !== state.human.name;
      const cosChanged = previousPresenceConfig.cosId !== state.cos.id;
      const previousOwner = {
        id: previousPresenceConfig.cosId,
        avatar: previousPresenceConfig.cosAvatar,
      };
      if (humanChanged) {
        rememberRetiredOwner(
          state,
          previousPresenceConfig.world,
          previousPresenceConfig.humanName,
          previousOwner,
        );
      }
      if (cosChanged) {
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
    if (Object.keys(currentPresenceConfig).some((key) => (
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

async function demoteRetiredOwners(connection, targets, { signal } = {}) {
  const ordered = [...targets].sort((left, right) => (
    Number(left.id === connection.id) - Number(right.id === connection.id)
  ));
  for (const target of ordered) {
    throwIfAborted(signal);
    await connection.sendVerb('grant', { id: target.id, role: 'visitor' }, { signal });
  }
  await forgetRetiredOwners(targets);
}

async function revokeRetiredOwners(connection, config, { signal } = {}) {
  const state = await loadState();
  const targets = state.ownership.retired.filter((entry) => (
    entry.world !== config.world
    || (entry.id !== config.human.id && entry.id !== config.cos.id)
  ));
  if (!targets.length) return [];

  const currentWorldTargets = targets.filter((entry) => entry.world === config.world);
  if (currentWorldTargets.length) {
    await demoteRetiredOwners(connection, currentWorldTargets, { signal });
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
        throw new ServerError('PortOS could not retire a previous Eidoverse owner identity.', {
          status: 409,
          code: 'EIDOVERSE_OWNER_HANDOFF_FAILED',
        });
      }
      await demoteRetiredOwners(priorConnection, group.targets, { signal });
    }).finally(() => priorConnection.close());
  }

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
      await connection.sendVerb('grant', { id: config.cos.id, role: 'owner' }, { signal });
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
      await connection.sendVerb('grant', { id: config.human.id, role: 'owner' }, { signal });
      humanRole = 'owner';
    }
    if (cosRole === 'owner') await revokeRetiredOwners(connection, config, { signal });
    return rememberObservedRoles({ humanRole, cosRole }).then(() => {
      cosPresence = {
        connection,
        snapshot,
        joinedAt: new Date().toISOString(),
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

async function getDiskUsagePercent() {
  const stats = await statfs('/').catch(() => null);
  if (!stats) return null;
  const total = stats.blocks * stats.bsize;
  if (!(total > 0)) return null;
  return Math.round(((total - stats.bavail * stats.bsize) / total) * 100);
}

function appSummary(apps) {
  if (!Array.isArray(apps)) return null;
  return {
    total: apps.length,
    online: apps.filter((app) => app.overallStatus === 'online').length,
    stopped: apps.filter((app) => app.overallStatus === 'stopped').length,
    notStarted: apps.filter((app) => app.overallStatus === 'not_started').length,
    unknown: apps.filter((app) => app.overallStatus === 'unknown').length,
  };
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeOrNull(value) {
  const number = finiteOrNull(value);
  return number === null ? null : Math.max(0, number);
}

function percentageOrNull(value) {
  const number = finiteOrNull(value);
  return number === null ? null : Math.max(0, Math.min(100, number));
}

function projectedProductivity(todayActivity, velocity, taskState) {
  if (!todayActivity && !velocity) return null;
  const stats = todayActivity?.stats || {};
  const queue = {
    pendingApprovals: Array.isArray(taskState?.awaitingApproval) ? taskState.awaitingApproval.length : null,
    pendingTasks: Array.isArray(taskState?.tasks)
      ? taskState.tasks.filter((task) => !['completed', 'done', 'archived'].includes(String(task?.status || '').toLowerCase())).length
      : null,
  };
  queue.total = [queue.pendingApprovals, queue.pendingTasks].every((value) => value !== null)
    ? queue.pendingApprovals + queue.pendingTasks
    : null;
  return [{
    id: 'summary',
    label: 'Productivity',
    completedToday: nonNegativeOrNull(stats.completed ?? velocity?.today),
    succeededToday: nonNegativeOrNull(stats.succeeded ?? velocity?.todaySuccesses),
    failedToday: nonNegativeOrNull(stats.failed ?? velocity?.todayFailures),
    successRate: percentageOrNull(stats.successRate),
    velocity: finiteOrNull(velocity?.velocity),
    velocityLabel: safeText(velocity?.velocityLabel, ''),
    averagePerDay: nonNegativeOrNull(velocity?.avgPerDay),
    historicalDays: nonNegativeOrNull(velocity?.historicalDays),
    queue,
    running: todayActivity?.isRunning === true,
    paused: todayActivity?.isPaused === true,
  }];
}

function projectedActivity(calendar) {
  if (!calendar || !Array.isArray(calendar.weeks)) return null;
  const days = calendar.weeks
    .flatMap((week) => Array.isArray(week) ? week : [])
    .filter((day) => day && typeof day === 'object' && day.isFuture !== true);
  const today = days.find((day) => day.isToday === true);
  const activeDays = days.filter((day) => (nonNegativeOrNull(day.tasks) || 0) > 0).slice(-99);
  const summary = calendar.summary || {};
  return [
    {
      id: 'summary',
      label: 'Activity calendar',
      weeks: calendar.weeks.length,
      activeDays: nonNegativeOrNull(summary.activeDays),
      totalTasks: nonNegativeOrNull(summary.totalTasks),
      totalSuccesses: nonNegativeOrNull(summary.totalSuccesses),
      successRate: percentageOrNull(summary.successRate),
      maxTasks: nonNegativeOrNull(calendar.maxTasks),
      todayTasks: nonNegativeOrNull(today?.tasks),
    },
    ...activeDays.map((day, index) => ({
      id: safeText(day.date, `day-${index}`),
      label: safeText(day.date, 'Activity day'),
      tasks: nonNegativeOrNull(day.tasks) ?? 0,
      successes: nonNegativeOrNull(day.successes) ?? 0,
      failures: nonNegativeOrNull(day.failures) ?? 0,
      successRate: percentageOrNull(day.successRate),
      isToday: day.isToday === true,
    })),
  ];
}

function projectedGoals(goalsData) {
  if (!Array.isArray(goalsData?.goals)) return null;
  const goals = goalsData.goals;
  const children = new Map(goals.map((goal) => [goal?.id, 0]));
  goals.forEach((goal) => {
    if (goal?.parentId && children.has(goal.parentId)) children.set(goal.parentId, children.get(goal.parentId) + 1);
  });
  return goals.map((goal, index) => {
    const milestones = Array.isArray(goal?.milestones) ? goal.milestones : [];
    const todos = Array.isArray(goal?.todos) ? goal.todos : [];
    return {
      id: safeText(goal?.id, `goal-${index}`),
      label: safeText(goal?.title, 'Goal'),
      status: safeText(goal?.status, 'active'),
      progress: percentageOrNull(goal?.progress) ?? 0,
      goalType: safeText(goal?.goalType, ''),
      targetDate: safeText(goal?.targetDate, ''),
      milestoneTotal: milestones.length,
      milestoneDone: milestones.filter((milestone) => milestone?.completed === true || Boolean(safeText(milestone?.completedAt, ''))).length,
      todoTotal: todos.length,
      todoPending: todos.filter((todo) => !['completed', 'done'].includes(String(todo?.status || '').toLowerCase()) && todo?.completed !== true).length,
      childCount: children.get(goal?.id) || 0,
    };
  });
}

function projectedMemory(graph) {
  if (!graph || !Array.isArray(graph.nodes)) return null;
  const buckets = new Map();
  const categoryById = new Map();
  for (const node of graph.nodes) {
    const category = safeText(node?.category || node?.brainType, 'other').toLowerCase() || 'other';
    categoryById.set(node?.id, category);
    const bucket = buckets.get(category) || { count: 0, importance: 0 };
    bucket.count += 1;
    bucket.importance += Math.max(0, finiteOrNull(node?.importance) ?? 1);
    buckets.set(category, bucket);
  }
  const bridgeCounts = new Map();
  for (const edge of Array.isArray(graph.edges) ? graph.edges : []) {
    const from = categoryById.get(edge?.source);
    const to = categoryById.get(edge?.target);
    if (!from || !to || from === to) continue;
    bridgeCounts.set(from, (bridgeCounts.get(from) || 0) + 1);
    bridgeCounts.set(to, (bridgeCounts.get(to) || 0) + 1);
  }
  return [...buckets.entries()]
    .sort(([a, left], [b, right]) => right.count - left.count || a.localeCompare(b))
    .map(([category, bucket]) => ({
      id: category,
      label: `Memory ${category}`,
      category,
      count: bucket.count,
      importance: bucket.importance,
      bridgeCount: bridgeCounts.get(category) || 0,
      totalMemories: graph.nodes.length,
      totalEdges: Array.isArray(graph.edges) ? graph.edges.length : 0,
      hasEmbeddings: graph.hasEmbeddings === true,
    }));
}

function projectedStorage(introspection) {
  if (!introspection || typeof introspection !== 'object') return null;
  const items = [];
  const db = introspection.db;
  const fsSection = introspection.fs;
  const dbOnline = Array.isArray(db?.tables);
  items.push({
    id: 'database',
    label: 'PostgreSQL',
    area: 'database',
    status: db === null ? 'offline' : (dbOnline ? 'online' : 'unknown'),
    tableCount: dbOnline ? db.tables.length : null,
    sizeBytes: finiteOrNull(db?.sizeBytes),
    migrations: db?.migrations?.applied === undefined ? null : nonNegativeOrNull(db.migrations.applied),
  });
  if (dbOnline) {
    db.tables.forEach((table, index) => items.push({
      id: `db-table-${shortHash(table?.name || index)}`,
      label: safeText(table?.name, 'Database table'),
      area: 'database-table',
      status: 'online',
      rowEstimate: nonNegativeOrNull(table?.rowEstimate),
      sizeBytes: nonNegativeOrNull(table?.totalBytes),
      hasEmbedding: table?.hasEmbedding === true,
    }));
  }
  const fsOnline = Array.isArray(fsSection?.domains);
  items.push({
    id: 'filesystem',
    label: 'PortOS data files',
    area: 'filesystem',
    status: fsSection === null ? 'offline' : (fsOnline ? 'online' : 'unknown'),
    domainCount: fsOnline ? fsSection.domains.length : null,
    sizeBytes: finiteOrNull(fsSection?.totalBytes),
    fileCount: nonNegativeOrNull(fsSection?.totalFiles),
  });
  if (fsOnline) {
    fsSection.domains.forEach((domain, index) => items.push({
      id: `data-domain-${shortHash(domain?.name || index)}`,
      label: safeText(domain?.name, 'Data domain'),
      area: 'data-domain',
      status: 'online',
      sizeBytes: nonNegativeOrNull(domain?.bytes),
      fileCount: nonNegativeOrNull(domain?.files),
    }));
  }
  return items;
}

function projectedOperations({ cosStatus, review, backupState, notifications, character, healthMetrics, voiceConfig, memory, diskPercent, chronotype, inboxCounts }) {
  const values = [cosStatus, review, backupState, notifications, character, healthMetrics, voiceConfig, memory, diskPercent, chronotype, inboxCounts];
  if (!values.some((value) => value !== null && value !== undefined)) return null;
  return [{
    id: 'overview',
    label: 'PortOS operations',
    cos: cosStatus ? {
      running: cosStatus.running === true,
      paused: cosStatus.paused === true,
      activeAgents: nonNegativeOrNull(cosStatus.activeAgents),
      pausedAgents: nonNegativeOrNull(cosStatus.pausedAgents),
      provider: safeText(cosStatus.provider?.name, ''),
    } : null,
    ai: cosStatus ? {
      running: cosStatus.running === true,
      activeAgents: nonNegativeOrNull(cosStatus.activeAgents),
      provider: safeText(cosStatus.provider?.name, ''),
    } : null,
    review: review ? {
      total: nonNegativeOrNull(review.total),
      cos: nonNegativeOrNull(review.cos),
      alerts: nonNegativeOrNull(review.alert),
    } : null,
    backup: backupState ? {
      status: safeText(backupState.status, 'unknown'),
      lastRun: safeText(backupState.lastRun, ''),
      filesChanged: nonNegativeOrNull(backupState.filesChanged),
    } : null,
    notifications: notifications ? {
      total: nonNegativeOrNull(notifications.total),
      unread: nonNegativeOrNull(notifications.unread),
    } : null,
    inbox: inboxCounts ? {
      total: nonNegativeOrNull(inboxCounts.total),
      needsReview: nonNegativeOrNull(inboxCounts.needs_review),
      classifying: nonNegativeOrNull(inboxCounts.classifying),
    } : null,
    character: character ? {
      level: nonNegativeOrNull(character.level),
    } : null,
    chronotype: chronotype ? {
      type: safeText(chronotype.type, ''),
      confidence: percentageOrNull(typeof chronotype.confidence === 'number' ? chronotype.confidence * 100 : chronotype.confidence),
      peakFocusStart: safeText(chronotype.recommendations?.peakFocusStart, ''),
      peakFocusEnd: safeText(chronotype.recommendations?.peakFocusEnd, ''),
      sleepTime: safeText(chronotype.recommendations?.sleepTime, ''),
    } : null,
    voice: voiceConfig ? {
      enabled: voiceConfig.enabled === true,
      sttEngine: safeText(voiceConfig.stt?.engine, ''),
      ttsEngine: safeText(voiceConfig.tts?.engine, ''),
    } : null,
    memory: memory ? {
      usedPercent: memory.total > 0 ? Math.round((memory.used / memory.total) * 100) : null,
      source: safeText(memory.source, 'unknown'),
    } : null,
    healthMetrics: healthMetrics ?? null,
    diskPercent: percentageOrNull(diskPercent),
  }];
}

async function projectedJira(appConfig, featuresState) {
  if (!Array.isArray(featuresState?.features)) return null;
  const jiraFeature = featuresState.features.find((feature) => feature?.id === 'jira');
  if (!jiraFeature) return null;
  if (jiraFeature.enabled !== true) return [];
  if (!Array.isArray(appConfig)) return null;
  const specs = [...new Map(appConfig
    .filter((app) => app?.jira?.enabled && app.jira.instanceId && app.jira.projectKey)
    .map((app) => [`${app.jira.instanceId}/${app.jira.projectKey}`, {
      instanceId: app.jira.instanceId,
      projectKey: app.jira.projectKey,
    }]))
    .values()];
  if (specs.length === 0) return [];
  const batches = await Promise.all(specs.map((spec) => fetchMyCurrentSprintTickets(spec.instanceId, spec.projectKey)
    .then((tickets) => Array.isArray(tickets) ? { tickets, failed: false } : { tickets: [], failed: true })
    .catch(() => ({ tickets: [], failed: true }))));
  if (batches.some((batch) => batch.failed)) return null;
  const byKey = new Map();
  batches.flatMap((batch) => batch.tickets).forEach((ticket, index) => {
    if (!ticket?.key || byKey.has(ticket.key)) return;
    byKey.set(ticket.key, {
      id: safeText(ticket.key, `ticket-${index}`),
      label: safeText(ticket.summary, ticket.key),
      status: safeText(ticket.statusCategory || ticket.status, 'todo'),
      statusCategory: safeText(ticket.statusCategory, ''),
      priority: safeText(ticket.priority, ''),
      issueType: safeText(ticket.issueType, ''),
      storyPoints: nonNegativeOrNull(ticket.storyPoints),
    });
  });
  return [...byKey.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function healthSnapshot({ apps, cosStatus, review, backupState, notifications, character, healthMetrics, voiceConfig, memory, diskPercent }) {
  const health = {
    apps: appSummary(apps),
    cos: cosStatus
      ? {
        running: cosStatus.running === true,
        activeAgents: nonNegativeOrNull(cosStatus.activeAgents),
        pausedAgents: nonNegativeOrNull(cosStatus.pausedAgents),
      }
      : null,
    review: review ? {
      total: nonNegativeOrNull(review.total),
      cos: nonNegativeOrNull(review.cos),
      alerts: nonNegativeOrNull(review.alert),
    } : null,
    backup: backupState ? {
      status: safeText(backupState.status, 'unknown'),
      lastRun: safeText(backupState.lastRun, ''),
      filesChanged: nonNegativeOrNull(backupState.filesChanged),
    } : null,
    memory: memory ? {
      usedPercent: memory.total > 0 ? Math.round((memory.used / memory.total) * 100) : null,
      source: safeText(memory.source, 'unknown'),
    } : null,
    notifications: notifications ? {
      total: nonNegativeOrNull(notifications.total),
      unread: nonNegativeOrNull(notifications.unread),
    } : null,
    character: character ? {
      level: nonNegativeOrNull(character.level),
    } : null,
    metrics: healthMetrics ?? null,
    voice: voiceConfig ? {
      enabled: voiceConfig.enabled === true,
      sttEngine: safeText(voiceConfig.stt?.engine, ''),
      ttsEngine: safeText(voiceConfig.tts?.engine, ''),
    } : null,
    diskPercent: percentageOrNull(diskPercent),
  };
  const available = [apps, cosStatus, review, backupState, notifications, character, healthMetrics, voiceConfig, memory, diskPercent]
    .some((value) => value !== null && value !== undefined);
  return available ? health : null;
}

async function collectProjectionSources({ signal } = {}) {
  throwIfAborted(signal);
  const [apps, appConfig, agents, taskState, cosStatus, review, featuresState, peers, backupState, notifications, character, healthMetrics, voiceConfig, memory, diskPercent, todayActivity, velocity, activityCalendar, goalsData, chronotype, memoryGraph, inboxCounts, introspection] = await waitWithSignal(Promise.all([
    getAppStatuses().catch(() => null),
    getAllApps({ includeArchived: false }).catch(() => null),
    getAgents().catch(() => null),
    getCosTasks().catch(() => null),
    getCosStatus().catch(() => null),
    getPendingCounts().catch(() => null),
    getInstanceFeatures().catch(() => null),
    getPeers().catch(() => null),
    backup.getState().catch(() => null),
    getCountsByType().catch(() => null),
    getCharacter({ withSkills: false, withMetrics: false }).catch(() => null),
    getLatestMetricValues(HEALTH_METRIC_KEYS).catch(() => null),
    getVoiceConfig().catch(() => null),
    getMemoryStats().catch(() => null),
    getDiskUsagePercent(),
    getTodayActivity().catch(() => null),
    getVelocityMetrics().catch(() => null),
    getActivityCalendar(12).catch(() => null),
    getGoals().catch(() => null),
    getChronotype().catch(() => null),
    getBrainGraphOverview({ limit: 100 }).catch(() => null),
    getInboxLogCounts().catch(() => null),
    getOpenWorldIntrospection().catch(() => null),
  ]), signal);

  const projectedAgents = Array.isArray(agents)
    ? agents
      .filter((agent) => ['running', 'paused'].includes(agent?.status))
      .map((agent) => ({
        id: safeText(agent.id, 'agent'),
        status: safeText(agent.status, 'unknown'),
        taskId: safeText(agent.taskId, ''),
        phase: safeText(agent.metadata?.phase, ''),
        appName: safeText(agent.metadata?.taskAppName, ''),
      }))
    : null;
  const projectedTasks = Array.isArray(taskState?.tasks)
    ? taskState.tasks
      .filter((task) => !['completed', 'done', 'archived'].includes(String(task?.status || '').toLowerCase()))
      .map((task) => ({
        id: safeText(task.id, 'task'),
        label: safeText(task.title || task.name || task.description, 'CoS task').split('\n')[0].slice(0, 140),
        status: safeText(task.status, 'pending'),
        priority: safeText(task.priority, ''),
        type: safeText(task.type, ''),
      }))
    : null;
  const projectedFeatures = Array.isArray(featuresState?.features)
    ? featuresState.features.map((feature) => ({
      id: safeText(feature.id, 'feature'),
      label: safeText(feature.label || feature.id, 'Feature'),
      enabled: feature.enabled === true,
    }))
    : null;
  const projectedPeers = Array.isArray(peers)
    ? peers.map((peer) => ({
      id: safeText(peer.instanceId || peer.id, 'peer'),
      label: safeText(peer.name, 'Federated peer'),
      enabled: peer.enabled !== false,
      fullSync: peer.fullSync === true,
      status: safeText(peer.status, ''),
    }))
    : null;

  const health = healthSnapshot({ apps, cosStatus, review, backupState, notifications, character, healthMetrics, voiceConfig, memory, diskPercent });
  const jira = await waitWithSignal(projectedJira(appConfig, featuresState), signal);

  return {
    apps: Array.isArray(apps)
      ? apps.map((app) => ({
        id: safeText(app.id, 'app'),
        label: safeText(app.name, 'Managed app'),
        status: safeText(app.overallStatus, 'unknown'),
        type: safeText(app.type, ''),
        managed: app.managed === true,
      }))
      : null,
    agents: projectedAgents,
    tasks: projectedTasks,
    features: projectedFeatures,
    peers: projectedPeers,
    health,
    productivity: projectedProductivity(todayActivity, velocity, taskState),
    activity: projectedActivity(activityCalendar),
    goals: projectedGoals(goalsData),
    memory: projectedMemory(memoryGraph),
    storage: projectedStorage(introspection),
    jira,
    operations: projectedOperations({ cosStatus, review, backupState, notifications, character, healthMetrics, voiceConfig, memory, diskPercent, chronotype, inboxCounts }),
  };
}

const PROJECTION_KINDS = [
  { kind: 'app', source: 'apps' },
  { kind: 'agent', source: 'agents' },
  { kind: 'task', source: 'tasks' },
  { kind: 'feature', source: 'features' },
  { kind: 'peer', source: 'peers' },
  { kind: 'health', source: 'health' },
  { kind: 'productivity', source: 'productivity' },
  { kind: 'activity', source: 'activity' },
  { kind: 'goal', source: 'goals' },
  { kind: 'memory', source: 'memory' },
  { kind: 'storage', source: 'storage' },
  { kind: 'jira', source: 'jira' },
  { kind: 'operations', source: 'operations' },
];

function sourceAvailable(source, key) {
  if (key === 'health') return source.health !== null && source.health !== undefined;
  return Array.isArray(source[key]);
}

function projectionEntityId(kind, sourceId, index) {
  return `${PROJECTION_ID_PREFIX}${kind}-${shortHash(`${kind}:${sourceId || index}`)}`;
}

function componentFor(kind, item) {
  if (kind === 'health') return { resource: 'health', label: 'PortOS health', ...item };
  const component = {
    resource: COMPONENT_RESOURCE_BY_KIND[kind] || kind,
    sourceId: safeText(item.id, 'unknown'),
    label: safeText(item.label, kind),
  };
  for (const [key, value] of Object.entries(item)) {
    if (key === 'id' || key === 'label' || value === undefined) continue;
    if (typeof value === 'string') component[key] = safeText(value, '', 300);
    else if (typeof value === 'number' && Number.isFinite(value)) component[key] = value;
    else if (typeof value === 'boolean') component[key] = value;
    else if (value !== null && typeof value === 'object') component[key] = clone(value);
  }
  return component;
}

function entityPosition(index, kind, recipe) {
  const { origin, spacing, laneGap, columns } = recipe.layout;
  const lane = PROJECTION_KINDS.findIndex((entry) => entry.kind === kind);
  const column = index % columns;
  const row = Math.floor(index / columns);
  return [
    origin[0] + column * spacing,
    origin[1],
    origin[2] + lane * laneGap + row * spacing,
  ];
}

function equal(valueA, valueB) {
  return stableStringify(valueA) === stableStringify(valueB);
}

/**
 * Build the deterministic world operations without opening a socket. This is
 * intentionally exported so recipe changes can be tested without a live
 * Eidoverse process and so future renderers can reuse the same projection.
 */
export function buildProjectionPlan({ source = {}, recipe = DEFAULT_EIDOVERSE_PROJECTION_RECIPE, currentState = {} }) {
  const effectiveRecipe = mergeRecipe(recipe);
  const stateEntities = currentState?.entities && typeof currentState.entities === 'object'
    ? currentState.entities
    : {};
  const operations = [];
  const desiredIds = new Set();
  const removableKinds = new Set();
  const sourceAvailability = {};
  let created = 0;
  let updated = 0;
  let removed = 0;

  sourceAvailability.terrain = currentState?.terrain !== undefined;
  if (!equal(currentState?.terrain || null, effectiveRecipe.terrain)) {
    operations.push({ verb: 'terrain', args: effectiveRecipe.terrain });
  }

  for (const { kind, source: sourceKey } of PROJECTION_KINDS) {
    const available = sourceAvailable(source, sourceKey);
    sourceAvailability[sourceKey] = available;
    if (!effectiveRecipe.includes[`${sourceKey}`]) {
      removableKinds.add(kind);
      continue;
    }
    if (!available) continue;
    removableKinds.add(kind);
    const values = kind === 'health' ? [source.health] : source[sourceKey];
    const limited = values.slice(0, effectiveRecipe.limits[sourceKey] ?? values.length);
    limited.forEach((item, index) => {
      const sourceId = kind === 'health' ? 'health' : item.id || `${kind}-${index}`;
      const id = projectionEntityId(kind, sourceId, index);
      const pos = entityPosition(index, kind, effectiveRecipe);
      const spawn = {
        id,
        lib: effectiveRecipe.assets[kind],
        pos,
        yaw: 0,
        scale: effectiveRecipe.scale[kind],
        collide: 'box',
      };
      const existing = stateEntities[id];
      desiredIds.add(id);
      if (!existing || existing.lib !== spawn.lib) {
        if (existing) {
          operations.push({ verb: 'remove', args: { id } });
          removed += 1;
        }
        operations.push({ verb: 'spawn', args: spawn });
        created += 1;
      } else if (!equal({ pos: existing.pos, yaw: existing.yaw, scale: existing.scale }, {
        pos: spawn.pos,
        yaw: spawn.yaw,
        scale: spawn.scale,
      })) {
        operations.push({ verb: 'place', args: { id, pos, yaw: 0, scale: spawn.scale } });
        updated += 1;
      }
      const component = componentFor(kind, item);
      if (!equal(existing?.comp?.[COMPONENT_TYPE], component)) {
        operations.push({ verb: 'comp', args: { id, type: COMPONENT_TYPE, data: component } });
        if (existing) updated += 1;
      }
    });
  }

  for (const id of Object.keys(stateEntities)) {
    if (!id.startsWith(PROJECTION_ID_PREFIX) || desiredIds.has(id)) continue;
    const kind = id.slice(PROJECTION_ID_PREFIX.length).split('-')[0];
    if (!removableKinds.has(kind)) continue;
    operations.push({ verb: 'remove', args: { id } });
    removed += 1;
  }

  return {
    operations,
    summary: {
      created,
      updated,
      removed,
      operationCount: operations.length,
      sourceAvailability,
      sourceCounts: Object.fromEntries(PROJECTION_KINDS.map(({ kind, source: sourceKey }) => [
        sourceKey,
        sourceAvailable(source, sourceKey)
          ? (kind === 'health' ? 1 : source[sourceKey].length)
          : null,
      ])),
    },
  };
}

async function sendOperations(connection, operations, { signal } = {}) {
  for (let index = 0; index < operations.length; index += 1) {
    throwIfAborted(signal);
    if (index > 0) await abortableDelay(PROJECTION_VERB_INTERVAL_MS, signal);
    const operation = operations[index];
    await connection.sendVerb(operation.verb, operation.args, { signal });
  }
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
    return state.projection;
  });
}

export async function projectEidoverseWorld({ signal } = {}) {
  const run = async () => {
    throwIfAborted(signal);
    await assertInstalled();
    const config = await ensureEidoverseWorldConfig();
    const presence = await ensureCosPresenceInternal({ fresh: true, signal });
    const source = await collectProjectionSources({ signal });
    throwIfAborted(signal);
    const plan = buildProjectionPlan({
      source,
      recipe: config.recipe,
      currentState: presence.snapshot?.state || {},
    });
    await sendOperations(presence.connection, plan.operations, { signal });
    const summary = {
      world: config.world,
      cosId: config.cos.id,
      ...plan.summary,
    };
    const projection = await recordProjection({ success: true, summary });
    return {
      success: true,
      summary,
      projection,
      presence: presenceSummary(presence),
    };
  };

  return worldLock(() => run().catch(async (error) => {
    await recordProjection({ success: false, error });
    throw error;
  }));
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
    await sendOperations(presence.connection, normalized, { signal });
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
    await presence.connection.sendVerb('say', { text: message }, { signal });
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

export async function closeEidoverseWorldConnections() {
  return worldLock(() => closeCosPresenceInternal());
}

export const __resetEidoverseWorldForTests = closeEidoverseWorldConnections;
