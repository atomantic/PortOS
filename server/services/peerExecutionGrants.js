/** Machine-local execution policy. Planning grants are deliberately never read. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { peerAdminActionSchema, PEER_ADMIN_ACTIONS, PEER_EXECUTION_SCOPE } from '../lib/peerAdminValidation.js';
import { peerAdminPairBinding } from './peerAdministration.js';

const uuid = z.string().uuid();
const record = z.object({
  id: uuid, peerId: z.string().min(1).max(100), peerInstanceId: uuid, hostInstanceId: uuid,
  action: peerAdminActionSchema, scope: z.literal(PEER_EXECUTION_SCOPE),
  pairBinding: z.string().regex(/^[a-f0-9]{64}$/), executionEpoch: uuid,
  generation: z.number().int().positive().safe(), allowed: z.boolean(),
  expiresAt: z.number().int().positive().safe(), createdAt: z.number().int().positive().safe(),
  authority: z.enum(['operator-session', 'local-operator']),
}).strict();
const storeSchema = z.object({ version: z.literal(1), grants: z.array(record).max(300) }).strict();
export const peerExecutionError = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const fail = (code, message, status) => { throw peerExecutionError(code, message, status); };
const floorKey = (identity, action) => ({ hostInstanceId: identity.self.instanceId, peerInstanceId: identity.peer.instanceId, action });

// The receiver owns a single mutex across save and dispatch; these methods are
// internal to that boundary. Publish the generation floor BEFORE policy bytes.
export function createPeerExecutionGrants({ ledger, readStore, writeStore, identity, now = Date.now }) {
  const read = async () => storeSchema.parse(await readStore());
  const active = async (grant, pair) => {
    const authority = ledger.authority.read();
    return Boolean(grant?.allowed && grant.expiresAt > now() && authority?.phase === 'ready'
      && grant.executionEpoch === authority.epoch && grant.hostInstanceId === pair.self.instanceId
      && grant.peerInstanceId === pair.peer.instanceId && grant.pairBinding === peerAdminPairBinding(pair.peer, pair.self)
      && grant.generation === await ledger.generationFloor(floorKey(pair, grant.action)));
  };
  const current = async (peerId, action) => {
    const pair = await identity(peerId);
    const grant = (await read()).grants.find(entry => entry.peerId === peerId && entry.action === action);
    if (!await active(grant, pair)) fail('PEER_EXECUTION_GRANT_REQUIRED', 'A fresh execution grant for this exact pair and action is required.', 403);
    return { ...pair, grant };
  };
  const describe = async peerId => {
    const store = await read();
    let pair;
    try { pair = await identity(peerId); } catch { pair = null; }
    return { scope: PEER_EXECUTION_SCOPE, actions: await Promise.all(PEER_ADMIN_ACTIONS.map(async action => {
      const grant = store.grants.find(entry => entry.peerId === peerId && entry.action === action);
      const { pairBinding: _secret, executionEpoch: _epoch, ...publicGrant } = grant ?? {};
      return { action, grant: grant ? publicGrant : null, active: Boolean(pair && await active(grant, pair)) };
    })) };
  };
  const save = async (input, req) => {
    const pair = await identity(input.peerId, { allowInactive: !input.allowExecution });
    if (input.confirmedHostInstanceId !== pair.self.instanceId || input.confirmedPeerInstanceId !== pair.peer.instanceId)
      fail('PEER_ADMIN_IDENTITY_CHANGED', 'The confirmed pair identity changed.');
    const authority = await ledger.initialize();
    ledger.authority.requireReady(authority.epoch);
    const store = await read();
    const index = store.grants.findIndex(entry => entry.peerId === input.peerId && entry.action === input.action);
    const previous = store.grants[index];
    if ((previous?.id ?? null) !== input.previousGrantId) fail('PEER_ADMIN_GRANT_CHANGED', 'Refresh the current grant before changing it.');
    if (!input.allowExecution && !previous) fail('PEER_ADMIN_GRANT_CHANGED', 'There is no execution grant to revoke.');
    if (index < 0 && store.grants.length >= 300) fail('PEER_ADMIN_GRANT_LIMIT', 'The bounded execution policy store is full.');
    const generation = Math.max(previous?.generation ?? 0, await ledger.generationFloor(floorKey(pair, input.action))) + 1;
    const grant = record.parse({ id: randomUUID(), peerId: input.peerId, ...floorKey(pair, input.action),
      scope: PEER_EXECUTION_SCOPE, generation, executionEpoch: authority.epoch,
      pairBinding: input.allowExecution ? peerAdminPairBinding(pair.peer, pair.self) : previous.pairBinding, allowed: input.allowExecution,
      createdAt: now(), expiresAt: now() + input.expiresInMinutes * 60_000,
      authority: req.portosAuthContext.method === 'session' ? 'operator-session' : 'local-operator' });
    await ledger.advanceGenerationFloor({ ...floorKey(pair, input.action), generation, executionEpoch: authority.epoch });
    if (index >= 0) store.grants[index] = grant; else store.grants.push(grant);
    ledger.authority.requireReady(authority.epoch);
    await writeStore(store);
    return describe(input.peerId);
  };
  return { current, describe, save };
}
