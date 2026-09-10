/**
 * Instance Identity
 *
 * Owns this install's federation identity — the local instanceId/name pair —
 * plus the data/instances.json file I/O and its mutex, which this module and
 * services/instances.js (peer orchestration) both read and write through.
 *
 * This module is a leaf on purpose. Most callers across the server only need
 * to read this install's own id (getInstanceId/ensureInstanceId/getSelf), not
 * manage peers. Before this split, that one-line id read statically loaded
 * services/instances.js's entire peer-orchestration closure — the Tailscale
 * status parser (lib/tailscale.js), the federated-media probe
 * (services/federatedMediaConsumer.js), and the peer socket relay
 * (services/peerSocketRelay.js) — a 30+ module closure paid by every test
 * suite that imports any of the 22 identity-only callers (brain, memory,
 * catalog, CoS, and more). See issue #6836.
 *
 * Import rule: this module stays a leaf. It may import only
 * `lib/fileUtils.js`, `lib/asyncMutex.js`, `node:os`, and `node:crypto` — no
 * other `server/services/*` module, and nothing that reaches the peer stack.
 * `server/lib/importScoping.test.js` enforces this.
 */

import os from 'node:os';
import crypto from 'node:crypto';
import { dataPath, readJSONFile, ensureDir, PATHS, atomicWrite } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';

const INSTANCES_FILE = dataPath('instances.json');

// Sentinel returned by getInstanceId() and stamped onto sender/peer fields when
// the local identity hasn't been initialized yet. Every consumer that fans
// instance-keyed state out to peers (sharing/annotationsSync.flushAll,
// mediaAnnotations.mergePeerAnnotations, manifest builders) must refuse this
// value — without that guard, every uninitialized peer would collide in the
// same bucket and clobber each other on merge.
export const UNKNOWN_INSTANCE_ID = 'unknown';

const withLock = createMutex();

// Default data shape
const DEFAULT_DATA = {
  self: null,
  peers: []
};

// --- File I/O ---

// STRICT (#4115): every mutation runs through `withData`, which writes whatever
// this read returned straight back. Swallowing an unreadable instances.json into
// DEFAULT_DATA therefore hands `ensureSelf` an identity-less record — it mints a
// BRAND-NEW instanceId and `saveData` persists it over the real file, rotating
// this node's federation identity and wiping every peer. ENOENT (never
// federated) stays the trustworthy first-run empty.
export async function loadData() {
  return await readJSONFile(INSTANCES_FILE, DEFAULT_DATA, { strict: true });
}

async function saveData(data) {
  await ensureDir(PATHS.data);
  await atomicWrite(INSTANCES_FILE, data);
}

export async function withData(fn) {
  return withLock(async () => {
    const data = await loadData();
    const result = await fn(data);
    await saveData(data);
    return result;
  });
}

// --- Self Identity ---

export async function ensureSelf() {
  return withData(async (data) => {
    if (!data.self) {
      data.self = {
        instanceId: crypto.randomUUID(),
        name: os.hostname()
      };
      console.log(`🌐 Instance identity created: ${data.self.name} (${data.self.instanceId})`);
    }
    return data.self;
  });
}

export async function getSelf() {
  const data = await loadData();
  return data.self;
}

let cachedInstanceId = null;
export async function getInstanceId() {
  if (!cachedInstanceId) {
    const id = (await getSelf())?.instanceId;
    if (id) cachedInstanceId = id;
    return id ?? UNKNOWN_INSTANCE_ID;
  }
  return cachedInstanceId;
}

/**
 * Resolve this machine's real federation instance id, creating the local
 * identity on the cold path. `getInstanceId()` returns the
 * `UNKNOWN_INSTANCE_ID` sentinel (and never throws) before the identity exists
 * — which can happen on a boot-time always-on auto-start that runs before the
 * startup chain's `ensureSelf()` does. Callers that stamp the id onto durable
 * records (agent provenance, worktree metadata) or compare it for cross-machine
 * task claims (#1563) must never persist/compare the sentinel, so this creates
 * (or loads) the real identity before returning. The warm path is the cheap
 * cached `getInstanceId()` read; `ensureSelf()` only runs the once.
 */
export async function ensureInstanceId() {
  let instanceId = await getInstanceId();
  if (instanceId === UNKNOWN_INSTANCE_ID) {
    instanceId = (await ensureSelf())?.instanceId || instanceId;
  }
  return instanceId;
}

export async function updateSelf(name, { defaultPeerFullSync } = {}) {
  return withData(async (data) => {
    if (!data.self) return null;
    if (typeof name === 'string' && name.trim()) {
      data.self.name = name.trim();
      console.log(`🌐 Instance name updated: ${data.self.name}`);
    }
    // The default full-sync ("mirror everything") mode applied to NEW peers as
    // they're added. Existing peers are untouched — this only seeds addPeer.
    if (typeof defaultPeerFullSync === 'boolean') {
      data.self.defaultPeerFullSync = defaultPeerFullSync;
      console.log(`🌐 New-peer full-sync default: ${defaultPeerFullSync ? 'on' : 'off'}`);
    }
    return data.self;
  });
}
