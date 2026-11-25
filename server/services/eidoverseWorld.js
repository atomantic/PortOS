/**
 * PortOS-owned Eidoverse world integration.
 *
 * Eidoverse owns the append-only world log and its derived snapshot. PortOS
 * owns the install-local identity/configuration that decides who enters the
 * world and how PortOS resources are projected into it. The projection is
 * deterministic and uses the Eidoverse world protocol; it never edits the
 * external checkout or calls an AI provider.
 *
 * Storage: `file-primary` (`data/eidoverse/portos-world.json`, and the runtime's
 * append-only `data/eidoverse/worlds/`) — machine-local, never federated by
 * PortOS; covered by filesystem backups. The asset lock holds paths, fingerprints
 * and provenance only, never model bytes; guest travel sessions and chat cursors
 * are in-memory transport state, not a store.
 */
import { randomUUID } from 'node:crypto';
import { eidoverseModelBounds } from '../lib/eidoverseCityLayout.js';
import { buildEidoverseSceneInspection, eidoverseInspectSceneInputSchema } from '../lib/eidoverseSceneInspection.js';
import { ServerError } from '../lib/errorHandler.js';
import { scrubSecretTokens } from '../lib/secretText.js';
import { getEidoverseStatus } from './eidoverse.js';
import { libraryUrl } from './eidoverseWorldAssets.js';
import {
  assertInstalled,
  closeCosPresenceInternal,
  createWorldConnection,
  ensureCosPresenceInternal,
  getCosPresence,
  presenceSummary,
  readEidoverseWorldConfig,
  sendPacedVerb,
  throwIfAborted,
  worldLock,
} from './eidoverseWorldConnection.js';
import { DEFAULT_HUMAN_AVATAR, resolveSuggestedCosId, safeText, updateWorldConfigState, validIdentity } from './eidoverseWorldState.js';
import { getSelf } from './instanceIdentity.js';

export { projectedJiraTickets, projectedStorage } from '../lib/eidoverseWorldSignals.js';
export { supportsEidoverseGuestEntry } from './eidoverseWorldAssets.js';
export { ensureEidoverseWorldConfig } from './eidoverseWorldConnection.js';
export { buildProjectionPlan, DEFAULT_EIDOVERSE_PROJECTION_RECIPE } from './eidoverseWorldProjection.js';
export { augmentEidoverseWorld, projectEidoverseWorld, reconcilePendingEidoverseWorld } from './eidoverseWorldReconcile.js';
export { getEidoverseWorldProjectionStatus, readEidoverseHostDescriptor, readEidoverseWorldRecipe } from './eidoverseWorldState.js';

export async function updateEidoverseWorldConfig(patch) {
  return worldLock(async () => {
    const { self, presenceConfigChanged } = await updateWorldConfigState(patch);
    if (presenceConfigChanged) await closeCosPresenceInternal();
    return readEidoverseWorldConfig(self);
  });
}

export async function ensureEidoverseWorldPresence({ verbIntervalMs } = {}) {
  return worldLock(async () => {
    await assertInstalled();
    const presence = await ensureCosPresenceInternal({ verbIntervalMs });
    return presenceSummary(presence);
  });
}

// Inspection never joins, starts, grants, projects, or visits a peer. It reads
// the already admitted LOCAL connection and fetches bounded model summaries.
export async function inspectEidoverseScene(input, { signal } = {}) {
  const args = eidoverseInspectSceneInputSchema.parse(input);
  throwIfAborted(signal);
  const connection = getCosPresence()?.connection;
  if (!connection?.isOpen()) return buildEidoverseSceneInspection(null, args);
  const view = await connection.getSceneView();
  if (view.availability !== 'current') return buildEidoverseSceneInspection(view, args);
  const boundsByAsset = new Map();
  const assets = [...new Set([...view.entities.values()].map((entity) => entity.asset).filter(Boolean))].slice(0, 16);
  const geometrySignal = AbortSignal.any([AbortSignal.timeout(2000), ...(signal ? [signal] : [])]);
  // No reusable cache: a mutable library reference may have changed since
  // the last inspection. Missing, oversized, or timed-out summaries stay unknown.
  await Promise.all(assets.map(async (asset) => {
    try {
      const response = await fetch(libraryUrl('/geom', { lib: asset }), { signal: geometrySignal, redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); return; }
      const reader = response.body?.getReader();
      if (!reader) return;
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) { await reader.cancel(); return; }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const bounds = eidoverseModelBounds(JSON.parse(Buffer.concat(chunks).toString('utf8'))?.bbox);
      if (bounds) boundsByAsset.set(asset, bounds);
    } catch {
      // Never export runtime error bodies, URLs, or credentials as evidence.
    }
  }));
  throwIfAborted(signal);
  const latest = await connection.getSceneView();
  return buildEidoverseSceneInspection(latest, args, { boundsByAsset, observedAt: new Date().toISOString() });
}

export async function sayInEidoverseWorld(text, { signal, verbIntervalMs } = {}) {
  return worldLock(async () => {
    throwIfAborted(signal);
    await assertInstalled();
    const presence = await ensureCosPresenceInternal({ signal, verbIntervalMs });
    const message = safeText(text, '', 2000);
    if (!message) {
      throw new ServerError('A non-empty Eidoverse message is required.', {
        status: 400,
        code: 'EIDOVERSE_ARGUMENT_INVALID',
      });
    }
    // `say` has no PortOS-side rewrite dimension (it is opaque text), so its
    // only two consequences are "the world acked it" (this resolves) or "it
    // didn't" (sendPacedVerb rejects and the mind sees a real tool error,
    // never a false success).
    await sendPacedVerb(presence.connection, 'say', { text: message }, {
      signal,
      pacing: presence.pacing,
      verbIntervalMs,
    });
    return {
      success: true,
      world: presence.connection.world,
      id: presence.connection.id,
      proposed: { text: message },
      committed: true,
    };
  });
}

export async function getEidoverseWorldStatus({ compact = false } = {}) {
  const [setup, self] = await Promise.all([getEidoverseStatus(), getSelf()]);
  const config = await readEidoverseWorldConfig(self);
  const suggestedCosId = await resolveSuggestedCosId(config.cos.id);
  // Semantic callers have a 4KB result budget. The full design/recipe can
  // consume that before setup and presence are reached, hiding how to act.
  if (compact) {
    const assets = {};
    const availableAssets = Object.entries(config.recipe.assets || {});
    for (const [slot, path] of availableAssets) {
      if (JSON.stringify({ ...assets, [slot]: path }).length > 2000) break;
      assets[slot] = path;
    }
    return {
      setup: { installed: setup.installed, runtimeStatus: setup.runtimeStatus, worldDataReady: setup.worldDataReady },
      cos: { id: config.cos.id, enabled: config.cos.enabled, connected: config.cos.connected, role: config.cos.role,
        chat: getCosPresence()?.connection?.chatSummary() ?? { cursor: -1, retained: 0 } },
      suggestedCosId,
      design: { selectedVersion: config.design.selectedVersion, lastAppliedVersion: config.design.lastAppliedVersion, pendingVersion: config.design.pendingVersion },
      assets,
      assetsTruncated: Object.keys(assets).length < availableAssets.length,
    };
  }
  return {
    ...config,
    identity: config.human,
    suggestedCosId,
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

export const __resetEidoverseWorldForTests = async () => {
  pendingGuestRevokes.clear();
  return closeEidoverseWorldConnections();
};


// Guest grants whose revoke failed; retried once on the next world-lock acquisition.
const pendingGuestRevokes = new Map();

/** Strip a guest's role. Caller holds worldLock. A failure is logged and queued for one retry. */
async function revokeGuestGrant(presence, { world, name }, { verbIntervalMs, retry = false } = {}) {
  const key = `${world}\0${name}`;
  if (presence.connection.world !== world) {
    pendingGuestRevokes.delete(key);
    return;
  }
  await sendPacedVerb(presence.connection, 'grant', { id: name, role: null }, { pacing: presence.pacing, verbIntervalMs }).then(
    () => pendingGuestRevokes.delete(key),
    (error) => {
      console.error(`❌ Eidoverse guest revoke failed${retry ? ' on retry' : ''}: ${error.message}`);
      if (retry) pendingGuestRevokes.delete(key);
      else pendingGuestRevokes.set(key, { world, name });
    },
  );
}

/** Remove a departed guest's visitor role so repeated visits cannot accumulate grants. */
export async function revokeEidoverseGuest(identity) {
  if (!identity?.name || !identity.world) return;
  return worldLock(async () => {
    const presence = await ensureCosPresenceInternal();
    await revokeGuestGrant(presence, identity);
  }).catch((error) => {
    pendingGuestRevokes.set(`${identity.world}\0${identity.name}`, { world: identity.world, name: identity.name });
    console.error(`❌ Eidoverse guest revoke failed: ${error.message}`);
  });
}

/** Guest admission happens through the owner before any guest joins. */
export async function admitEidoverseGuest({ agent = false, name, verbIntervalMs } = {}) {
  return worldLock(async () => {
    await assertInstalled();
    const presence = await ensureCosPresenceInternal({ verbIntervalMs });
    if (presence.snapshot?.yourRights?.role !== 'owner') {
      throw new ServerError('The resident must own this world to admit visitors.', { status: 409, code: 'EIDOVERSE_GUEST_ADMISSION_UNAVAILABLE' });
    }
    const desiredName = validIdentity(name, '');
    const usableName = desiredName && scrubSecretTokens(desiredName) === desiredName
      && presence.snapshot?.state?.roles;
    for (const pending of [...pendingGuestRevokes.values()]) await revokeGuestGrant(presence, pending, { verbIntervalMs, retry: true });
    const baseName = usableName ? desiredName : `guest-${randomUUID()}`;
    let id = baseName;
    for (let suffix = 2; presence.connection.hasIdentity(id); suffix += 1) {
      const tail = ` (${suffix})`;
      id = `${baseName.slice(0, 64 - tail.length)}${tail}`;
    }
    await sendPacedVerb(presence.connection, 'grant', { id, role: 'visitor', gen: false }, {
      pacing: presence.pacing,
      verbIntervalMs,
    });
    const identity = { world: presence.connection.world, name: id, avatar: DEFAULT_HUMAN_AVATAR };
    if (!agent) return { identity };
    const connection = createWorldConnection({ world: identity.world, id, avatar: identity.avatar, agent: true, guest: true });
    return connection.waitForSnapshot().then(async (snapshot) => {
      if (snapshot.yourRights?.role !== 'visitor' || snapshot.yourRights?.gen || snapshot.yourRights?.open) {
        throw new ServerError('The world did not confirm visitor access.', { status: 409, code: 'EIDOVERSE_GUEST_ROLE_INVALID' });
      }
      return { identity, connection };
    }).catch(async (error) => {
      await connection.close();
      await revokeGuestGrant(presence, identity, { verbIntervalMs });
      throw error;
    });
  });
}

/** Live messages only: joining never exports the world's stored chat history. */
export async function readEidoverseWorldChat(after = -1) {
  return worldLock(async () => {
    const presence = await ensureCosPresenceInternal();
    return presence.connection.readChat(after);
  });
}
