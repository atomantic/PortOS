/** Eidoverse world transport, resident presence, verb pacing, and retired-owner cleanup. */

import { WebSocket } from 'ws';
import { createMutex } from '../lib/asyncMutex.js';
import { createEidoverseSceneView, updateEidoverseSceneView } from '../lib/eidoverseSceneInspection.js';
import { ServerError } from '../lib/errorHandler.js';
import { EIDOVERSE_PORT, getEidoverseStatus } from './eidoverse.js';
import {
  clone,
  ensureEidoverseWorldConfig as ensureConfigWithPresence,
  loadState,
  mutateState,
  readEidoverseWorldConfig as readConfigWithPresence,
  RETIRED_OWNER_MAX_ATTEMPTS,
  roleFromSnapshot,
  safeText,
  validRole,
} from './eidoverseWorldState.js';

// Eidoverse admits 12 authored verbs per four seconds. Stay just below that
// public protocol limit so large first-run reconciliations remain reliable.
export const PROJECTION_VERB_INTERVAL_MS = 350;
export const worldLock = createMutex();
let cosPresence = null;

export const getCosPresence = () => cosPresence;
export const readEidoverseWorldConfig = (self) => readConfigWithPresence(self, getCosPresence);

export async function ensureEidoverseWorldConfig() {
  return ensureConfigWithPresence(getCosPresence);
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException(String(signal?.reason || 'The Eidoverse operation was canceled.'), 'AbortError');
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

export function waitWithSignal(promise, signal) {
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

export function resolveWorldWsUrl() {
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

export function createWorldConnection({ world, id, avatar, agent = true, guest = false, onClosed = null }) {
  const socket = new WebSocket(resolveWorldWsUrl());
  let closed = false;
  let failure = null;
  let openSettled = false;
  let snapshotSettled = false;
  let snapshotValue = null;
  let sceneView = createEidoverseSceneView(null);
  const occupiedIdentities = new Set();
  let closeTimer = null;
  let openTimer = null;
  let snapshotTimer = null;
  let closeResolver = null;
  let messageTail = Promise.resolve();
  const pendingVerbs = [];
  const chat = [];
  let chatCursor = -1;

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
  // Opening can fail before a caller reaches the snapshot await, or after
  // cancellation detaches it. Own both rejections for the connection lifetime;
  // callers still await the original promises and receive the same errors.
  openPromise.catch(() => {});
  snapshotPromise.catch(() => {});

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
    sceneView.availability = 'unavailable';
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
      sceneView.availability = 'incomplete';
      return;
    }

    if (message?.type === 'snapshot') {
      sceneView = createEidoverseSceneView(message);
      for (const key of [...Object.keys(message.state?.roles || {}), ...Object.keys(message.state?.entities || {})]) occupiedIdentities.add(key);
      settleSnapshot(message);
      return;
    }
    if (message?.type === 'world-reset') sceneView.availability = 'incomplete';
    if (message?.type === 'log') updateEidoverseSceneView(sceneView, message.entry);
    if (message?.type === 'error') {
      fail(new ServerError(String(message.error || 'Eidoverse rejected the request.'), {
        status: 409,
        code: 'EIDOVERSE_WORLD_VERB_REJECTED',
      }));
      return;
    }
    if (message?.type === 'log' && message.entry) {
      // Grants and arrivals after the initial snapshot also reserve their names.
      if (typeof message.entry.actor === 'string') occupiedIdentities.add(message.entry.actor);
      if (typeof message.entry.args?.id === 'string') occupiedIdentities.add(message.entry.args.id);
    }
    if (message?.type === 'log' && message.entry?.verb === 'say') {
      const entry = message.entry;
      if (Number.isSafeInteger(entry.seq) && typeof entry.args?.text === 'string') {
        chatCursor = Math.max(chatCursor, entry.seq);
        chat.push({ seq: entry.seq, actor: String(entry.actor).slice(0, 64), text: entry.args.text.slice(0, 2000) });
        if (chat.length > 100) chat.shift();
      }
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
      ...(guest ? { guest: true } : {}),
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
    getSceneView: async () => {
      await messageTail;
      return structuredClone({ ...sceneView,
        availability: closed || failure || socket.readyState !== WebSocket.OPEN ? 'unavailable' : sceneView.availability });
    },
    hasIdentity: (name) => occupiedIdentities.has(name),
    readChat: (after = -1) => {
      const unread = chat.filter((entry) => entry.seq > after);
      const messages = [];
      for (const entry of unread.slice(0, 20)) {
        // Preserve a usable cursor inside the Mind's 4KB tool-result budget.
        // Even heavily escaped text gets one bounded, explicitly clipped row.
        const row = JSON.stringify(entry).length > 3000
          ? { ...entry, text: entry.text.slice(0, 400), textTruncated: true } : entry;
        if (JSON.stringify([...messages, row]).length > 3000) break;
        messages.push(row);
      }
      return { messages, cursor: messages.at(-1)?.seq ?? Math.max(after, chatCursor),
        hasMore: messages.length < unread.length, truncated: chat.length === 100 && after < chat[0].seq };
    },
    chatSummary: () => ({ cursor: chatCursor, retained: chat.length }),
  });
}

export function presenceSummary(presence = cosPresence) {
  return {
    connected: Boolean(presence?.connection?.isOpen()),
    id: presence?.connection?.id || null,
    world: presence?.connection?.world || null,
    role: presence?.snapshot?.yourRights?.role || null,
    gen: presence?.snapshot?.yourRights?.gen === true,
    joinedAt: presence?.joinedAt || null,
  };
}

export async function assertInstalled() {
  const setup = await getEidoverseStatus();
  if (setup.installed) return setup;
  throw new ServerError('Install and start Eidoverse Worlds before using the PortOS world projection.', {
    status: 409,
    code: 'EIDOVERSE_NOT_INSTALLED',
  });
}

export async function closeCosPresenceInternal() {
  const current = cosPresence;
  cosPresence = null;
  if (current?.connection) await current.connection.close();
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
  verbIntervalMs = PROJECTION_VERB_INTERVAL_MS,
} = {}) {
  const ordered = [...targets].sort((left, right) => (
    Number(left.id === connection.id) - Number(right.id === connection.id)
  ));
  const failures = [];
  const succeeded = [];
  for (const target of ordered) {
    await sendPacedVerb(connection, 'grant', { id: target.id, role: 'visitor' }, {
      signal,
      pacing,
      verbIntervalMs,
    }).then(
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
  verbIntervalMs = PROJECTION_VERB_INTERVAL_MS,
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
    failures.push(...await demoteRetiredOwners(connection, currentWorldTargets, {
      signal,
      pacing,
      verbIntervalMs,
    }));
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
      failures.push(...await demoteRetiredOwners(priorConnection, group.targets, { signal, verbIntervalMs }));
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
async function seedHumanRoleAndCosGrant(config, { signal, verbIntervalMs } = {}) {
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
      await sendPacedVerb(connection, 'grant', { id: config.cos.id, role: 'owner' }, {
        signal,
        pacing,
        verbIntervalMs,
      });
      cosRole = 'owner';
    }
    return { humanRole, cosRole };
  }).then((roles) => connection.close().then(async () => {
    // Both names may change together. Reuse a recorded prior owner to grant
    // the new identities before the normal cleanup retires that owner.
    if (roles.humanRole !== 'owner' && roles.cosRole !== 'owner') {
      const state = await loadState();
      const previous = state.ownership.retired.find((entry) => entry.world === config.world && entry.actorId);
      if (previous) {
        const priorConnection = createWorldConnection({
          world: config.world, id: previous.actorId,
          avatar: previous.actorAvatar || config.cos.avatar, agent: true,
        });
        await priorConnection.waitForSnapshot({ signal }).then(async (snapshot) => {
          if ((snapshot?.yourRights?.role || roleFromSnapshot(snapshot, previous.actorId)) !== 'owner') return;
          for (const id of new Set([config.human.id, config.cos.id])) {
            await sendPacedVerb(priorConnection, 'grant', { id, role: 'owner' }, { signal, pacing, verbIntervalMs });
          }
          roles.humanRole = 'owner';
          roles.cosRole = 'owner';
        }).finally(() => priorConnection.close());
      }
    }
    await rememberObservedRoles(roles);
    return roles;
  }), (error) => connection.close().then(() => { throw error; }));
}

export async function ensureCosPresenceInternal({ fresh = false, signal, verbIntervalMs } = {}) {
  throwIfAborted(signal);
  const config = await ensureEidoverseWorldConfig();
  throwIfAborted(signal);
  if (!config.cos.enabled) {
    throw new ServerError('The PortOS CoS presence is disabled in the Eidoverse world configuration.', {
      status: 409,
      code: 'EIDOVERSE_COS_DISABLED',
    });
  }
  if (fresh || (cosPresence && (!cosPresence.connection.isOpen()
    || cosPresence.connection.id !== config.cos.id || cosPresence.connection.world !== config.world))) await closeCosPresenceInternal();
  if (cosPresence?.connection.isOpen()) return cosPresence;

  await seedHumanRoleAndCosGrant(config, { signal, verbIntervalMs });

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
      await sendPacedVerb(connection, 'grant', { id: config.human.id, role: 'owner' }, {
        signal,
        pacing,
        verbIntervalMs,
      });
      humanRole = 'owner';
    }
    if (cosRole === 'owner') await revokeRetiredOwners(connection, config, { signal, pacing, verbIntervalMs });
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

export function createVerbPacing() {
  return { lastVerbSentAt: null };
}

export async function sendPacedVerb(connection, verb, args, {
  signal,
  pacing = createVerbPacing(),
  verbIntervalMs = PROJECTION_VERB_INTERVAL_MS,
} = {}) {
  throwIfAborted(signal);
  if (pacing.lastVerbSentAt !== null) {
    const wait = verbIntervalMs - (Date.now() - pacing.lastVerbSentAt);
    if (wait > 0) await abortableDelay(wait, signal);
  }
  // The resolved log entry is the world's ack for this verb — callers that
  // need to know what actually landed (as opposed to what was sent) read it
  // off the return value; existing fire-and-forget callers keep ignoring it.
  const entry = await connection.sendVerb(verb, args, { signal });
  pacing.lastVerbSentAt = Date.now();
  return entry;
}
