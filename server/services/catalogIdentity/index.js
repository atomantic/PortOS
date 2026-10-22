import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../../lib/db.js';
import { snapshot, lockCatalog, ingredient, assertUnlocked, buildPlan, hash, fail, validateSnapshot } from './snapshots.js';
import { localIdentity, identityPeer, readEvidence, revalidateEvidence } from './transport.js';
import { toPgJson } from '../../lib/pgJson.js';

const db = { query };
const idsOf = row => [row.source_id, row.survivor_id];
const peerOf = row => row.local_owner === row.source_owner ? row.survivor_owner : row.source_owner;
const coordinator = row => row.local_owner === row.survivor_owner;
const ACTIVE = ['proposed', 'prepared', 'committed', 'recovery_prepared'];
export function present(row, full = true) {
  const value = { id: row.id, sourceId: row.source_id, survivorId: row.survivor_id,
    sourceOwner: row.source_owner, survivorOwner: row.survivor_owner, localOwner: row.local_owner,
    state: row.state, epoch: row.epoch, planHash: row.plan_hash, peerState: row.peer_state,
    peerObservedAt: row.peer_observed_at, createdAt: row.created_at, updatedAt: row.updated_at };
  return full ? { ...value, plan: row.plan, beforeState: row.before_state,
    appliedFingerprint: row.applied_fingerprint, currentSnapshot: row.current_snapshot, recovery: row.recovery } : value;
}
async function load(client, id) {
  const { rows: [row] } = await client.query('SELECT * FROM catalog_identity_operations WHERE id = $1', [id]);
  if (!row) fail('Identity receipt not found', 'CATALOG_IDENTITY_NOT_FOUND', 404);
  return row;
}
async function revalidate(row, self, client, fullSnapshot = true) {
  if (row.local_owner !== self) fail('Receipt belongs to a different local owner');
  await identityPeer(peerOf(row));
  const current = fullSnapshot ? await snapshot(client, idsOf(row)) : { ingredients: (await client.query(
    'SELECT id,origin_instance_id,deleted FROM catalog_ingredients WHERE id=ANY($1)', [idsOf(row)])).rows };
  for (const [id, owner] of [[row.source_id, row.source_owner], [row.survivor_id, row.survivor_owner]]) {
    const member = ingredient(current, id);
    if (member.origin_instance_id !== owner) fail('Ingredient owner changed', 'CATALOG_IDENTITY_STALE');
  }
  return current;
}
async function noOverlap(client, ids, except = '') {
  const active = await client.query(`SELECT id FROM catalog_identity_operations WHERE id <> $2
    AND state = ANY($3) AND (source_id = ANY($1) OR survivor_id = ANY($1))
    UNION ALL SELECT id FROM catalog_ingredient_merges WHERE restored_at IS NULL
    AND (source_id = ANY($1) OR survivor_id = ANY($1))`, [ids, except, ACTIVE]);
  if (active.rowCount) fail('Either identity already participates in an active consolidation');
}
function binding(row, remote) {
  if (!remote || remote.id !== row.id || remote.planHash !== row.plan_hash || hash(remote.plan) !== row.plan_hash
      || remote.sourceId !== row.source_id || remote.survivorId !== row.survivor_id
      || remote.sourceOwner !== row.source_owner || remote.survivorOwner !== row.survivor_owner
      || remote.localOwner !== peerOf(row)) fail('Peer receipt does not match the accepted owner pair', 'CATALOG_IDENTITY_EVIDENCE_INVALID');
}
async function update(client, row, state, epoch, extra = {}) {
  const columns = { state, epoch, ...extra };
  const values = [row.id];
  const sets = Object.entries(columns).map(([key, value]) => {
    values.push(value && typeof value === 'object' ? toPgJson(value) : value);
    return `${key} = $${values.length}`;
  });
  await client.query(`UPDATE catalog_identity_operations SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, values);
  return present(await load(client, row.id));
}
async function writeContent(client, row, original = false) {
  await client.query("SELECT set_config('portos.catalog_identity_operation', $1, true)", [row.id]);
  const content = original ? ingredient(row.before_state, row.survivor_id) : row.plan.proposed;
  await client.query(`UPDATE catalog_ingredients SET name = $2, payload = $3::jsonb, tags = $4,
    embedding = NULL, embedding_model = NULL WHERE id = $1`,
  [row.survivor_id, content.name, toPgJson(content.payload), content.tags]);
  await client.query(`INSERT INTO catalog_ingredient_revisions (id, ingredient_id, name, payload, tags, source, actor)
    VALUES ($1, $2, $3, $4::jsonb, $5, 'user', $6)`,
  [`cat-rev-${randomUUID()}`, row.survivor_id, content.name, toPgJson(content.payload), content.tags,
    original ? 'catalog-identity-recovery' : 'catalog-shared-identity']);
}
async function adoptContent(client, row, content) {
  await client.query("SELECT set_config('portos.catalog_identity_operation', $1, true)", [row.id]);
  // Adoption is not a newly authored creative revision. The receipt and owner
  // snapshot retain the actual revision identity and owner timestamp.
  await client.query(`UPDATE catalog_ingredients SET name=$2,payload=$3::jsonb,tags=$4,updated_at=$5,
    embedding=NULL,embedding_model=NULL WHERE id=$1`,
  [row.survivor_id, content.name, toPgJson(content.payload), content.tags, content.updated_at]);
}
export async function listIdentityOperations({ ingredientId, limit = 20, offset = 0 } = {}) {
  const { rows } = await query(`SELECT id, source_id, survivor_id, source_owner, survivor_owner, local_owner,
    state, epoch, plan_hash, peer_state, peer_observed_at, created_at, updated_at FROM catalog_identity_operations
    WHERE ($1::text IS NULL OR source_id = $1 OR survivor_id = $1)
    ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`, [ingredientId ?? null, limit + 1, offset]);
  return { items: rows.slice(0, limit).map(row => present(row, false)), nextOffset: rows.length > limit ? offset + limit : null };
}
export async function getIdentityOperation(id) { return present(await load(db, id)); }
export async function ownerSnapshot(id, self = null) {
  self ??= await localIdentity();
  const value = await withTransaction(async client => { await lockCatalog(client); return snapshot(client, [id]); });
  if (ingredient(value, id).origin_instance_id !== self) fail('Only the original owner may attest this identity', 'CATALOG_IDENTITY_FOREIGN');
  return value;
}
export async function previewIdentity({ operationId, sourceId, survivorId, fieldChoices }) {
  const self = await localIdentity();
  const local = await snapshot(db, [sourceId, survivorId]);
  const source = ingredient(local, sourceId);
  const survivor = ingredient(local, survivorId);
  if (survivor.origin_instance_id !== self) fail('Create the plan on the selected survivor owner', 'CATALOG_IDENTITY_COORDINATOR_REQUIRED');
  if (source.origin_instance_id === self) fail('Use local consolidation for same-owner ingredients');
  const authoritative = await readEvidence(source.origin_instance_id, 'snapshot', sourceId);
  validateSnapshot(authoritative, sourceId, source.origin_instance_id);
  return buildPlan(authoritative, await ownerSnapshot(survivorId, self), fieldChoices, operationId);
}
export async function createIdentity(input) {
  const self = await localIdentity();
  const replay = await query('SELECT * FROM catalog_identity_operations WHERE id=$1 AND local_owner=$2', [input.operationId, self]);
  if (replay.rowCount) {
    const row = replay.rows[0];
    if (row.plan_hash !== input.planHash || row.source_id !== input.sourceId || row.survivor_id !== input.survivorId || hash(row.plan.fieldChoices) !== hash(input.fieldChoices ?? {})) fail('Retry must name the same reviewed plan');
    return present(row);
  }
  const preview = await previewIdentity(input);
  if (preview.planHash !== input.planHash) fail('Preview changed; review both owner snapshots again', 'CATALOG_IDENTITY_STALE');
  if (preview.conflicts.length) fail('Resolve every populated field conflict');
  return withTransaction(async client => {
    await lockCatalog(client);
    const { plan } = preview;
    if (await localIdentity() !== self) fail('Local owner changed');
    await identityPeer(plan.sourceOwner);
    await revalidateEvidence(plan.source);
    const existing = await client.query('SELECT * FROM catalog_identity_operations WHERE id = $1 AND local_owner = $2', [input.operationId, self]);
    if (existing.rowCount) {
      if (existing.rows[0].plan_hash !== preview.planHash) fail('Operation ID already names a different plan');
      return present(existing.rows[0]);
    }
    await noOverlap(client, [plan.sourceId, plan.survivorId]);
    if (hash(await snapshot(client, [plan.survivorId])) !== hash(plan.survivor)) fail('Survivor changed', 'CATALOG_IDENTITY_STALE');
    const id = input.operationId;
    await client.query(`INSERT INTO catalog_identity_operations
      (id, source_id, survivor_id, source_owner, survivor_owner, local_owner, state, plan, plan_hash)
      VALUES ($1,$2,$3,$4,$5,$6,'proposed',$7::jsonb,$8)`,
    [id, plan.sourceId, plan.survivorId, plan.sourceOwner, plan.survivorOwner, self, toPgJson(plan), preview.planHash]);
    return present(await load(client, id));
  });
}
export async function importIdentity({ peerId, operationId }) {
  const self = await localIdentity();
  const remote = await readEvidence(peerId, 'status', operationId);
  if (remote.localOwner !== peerId || remote.survivorOwner !== peerId || remote.sourceOwner !== self
      || !['proposed', 'prepared'].includes(remote.state) || hash(remote.plan) !== remote.planHash) fail('Import requires a proposed plan from its canonical owner');
  validateSnapshot(remote.plan.source, remote.sourceId, self);
  validateSnapshot(remote.plan.survivor, remote.survivorId, peerId);
  const rebuilt = buildPlan(remote.plan.source, remote.plan.survivor, remote.plan.fieldChoices, remote.id);
  if (rebuilt.planHash !== remote.planHash || rebuilt.conflicts.length) fail('Owner plan is invalid');
  return withTransaction(async client => {
    await lockCatalog(client);
    await revalidateEvidence(remote);
    const old = await client.query('SELECT * FROM catalog_identity_operations WHERE id = $1', [operationId]);
    if (old.rowCount) {
      binding(old.rows[0], remote);
      return present(old.rows[0]);
    }
    await noOverlap(client, [remote.sourceId, remote.survivorId]);
    const local = await snapshot(client, [remote.sourceId, remote.survivorId]);
    if (ingredient(local, remote.sourceId).origin_instance_id !== self
      || ingredient(local, remote.survivorId).origin_instance_id !== peerId
      || hash(await snapshot(client, [remote.sourceId])) !== hash(remote.plan.source)) fail('Source revision or local owner pair changed', 'CATALOG_IDENTITY_STALE');
    await client.query(`INSERT INTO catalog_identity_operations
      (id,source_id,survivor_id,source_owner,survivor_owner,local_owner,state,plan,plan_hash)
      VALUES ($1,$2,$3,$4,$5,$6,'proposed',$7::jsonb,$8)`,
    [operationId, remote.sourceId, remote.survivorId, self, peerId, self, toPgJson(remote.plan), remote.planHash]);
    return present(await load(client, operationId));
  });
}
export async function acceptIdentity(id, planHash) {
  const initial = await load(db, id);
  const self = await localIdentity();
  const peerSnapshot = await readEvidence(peerOf(initial), 'snapshot', coordinator(initial) ? initial.source_id : initial.survivor_id);
  const remote = await readEvidence(peerOf(initial), 'status', id);
  binding(initial, remote);
  return withTransaction(async client => {
    await lockCatalog(client);
    const row = await load(client, id);
    const current = await revalidate(row, self, client);
    await revalidateEvidence(peerSnapshot);
    await revalidateEvidence(remote);
    if (row.plan_hash !== planHash) fail('Accept the exact reviewed plan hash');
    if (row.state !== 'proposed') return present(row);
    if (!['proposed', 'prepared'].includes(remote.state) || remote.epoch !== 0) fail('Peer has already decided or cancelled this operation; advance its receipt');
    const own = coordinator(row) ? row.plan.survivor : row.plan.source;
    const foreign = coordinator(row) ? row.plan.source : row.plan.survivor;
    validateSnapshot(peerSnapshot, foreign.ingredients[0].id, peerOf(row));
    if (hash(peerSnapshot) !== hash(foreign) || hash(await snapshot(client, [own.ingredients[0].id])) !== hash(own)) {
      fail('Owner revision changed; abort and review a new plan', 'CATALOG_IDENTITY_STALE');
    }
    current.ingredients.forEach(assertUnlocked);
    await noOverlap(client, idsOf(row), id);
    return update(client, row, 'prepared', 0, { before_state: current });
  });
}
export async function abortIdentity(id) {
  const self = await localIdentity();
  return withTransaction(async client => {
    await lockCatalog(client);
    const row = await load(client, id);
    if (row.local_owner !== self) fail('Receipt belongs to a different local owner');
    if (row.state === 'aborted') return present(row);
    if (row.state !== 'proposed' && !(coordinator(row) && row.state === 'prepared')) {
      fail('Only the coordinator may abort a prepared operation; advance to read its durable decision');
    }
    return update(client, row, 'aborted', 1);
  });
}
export async function prepareIdentityRecovery(id, planHash) {
  const initial = await load(db, id);
  const self = await localIdentity();
  const remote = await readEvidence(peerOf(initial), 'status', id);
  binding(initial, remote);
  return withTransaction(async client => {
    await lockCatalog(client);
    const row = await load(client, id);
    const current = await revalidate(row, self, client);
    await revalidateEvidence(remote);
    if (row.plan_hash !== planHash) fail('Recovery must name the accepted plan');
    if (['recovery_prepared', 'recovered'].includes(row.state)) return present(row);
    if (row.state !== 'committed' || row.epoch !== 1) fail('Only a committed identity can prepare recovery');
    if (coordinator(row) ? remote.state !== 'committed' : remote.state !== 'recovery_prepared' || remote.epoch !== 2) {
      fail('Both owners must adopt first; prepare recovery on the canonical owner before the source owner');
    }
    if (hash(current) !== row.applied_fingerprint) fail('Applied state changed; recovery cannot overwrite later work', 'CATALOG_IDENTITY_STALE');
    return update(client, row, 'recovery_prepared', 2, { recovery: { appliedFingerprint: row.applied_fingerprint } });
  });
}
export async function advanceIdentity(id) {
  const initial = await load(db, id);
  const self = await localIdentity();
  const remote = await readEvidence(peerOf(initial), 'status', id);
  binding(initial, remote);
  const refresh = initial.state === 'committed' && !coordinator(initial) && remote.state === 'committed'
    ? await readEvidence(initial.survivor_owner, 'snapshot', initial.survivor_id) : null;
  return withTransaction(async client => {
    await lockCatalog(client);
    const row = await load(client, id);
    if (row.local_owner !== self) fail('Receipt belongs to a different local owner');
    await revalidateEvidence(remote);
    if (refresh) await revalidateEvidence(refresh);
    const observation = { peer_state: remote.state, peer_observed_at: new Date().toISOString() };
    if (['aborted', 'recovered'].includes(row.state)) return update(client, row, row.state, row.epoch, observation);
    if (['proposed', 'prepared'].includes(row.state) && remote.state === 'aborted' && remote.epoch === 1) {
      return update(client, row, 'aborted', 1, observation);
    }
    const current = await revalidate(row, self, client, ['prepared', 'recovery_prepared'].includes(row.state));
    const commit = row.state === 'prepared' && (coordinator(row)
      ? remote.state === 'prepared' && remote.epoch === 0
      : remote.state === 'committed' && remote.epoch === 1);
    if (commit) {
      if (hash(current) !== hash(row.before_state)) fail('Prepared state changed', 'CATALOG_IDENTITY_STALE');
      if (coordinator(row)) await writeContent(client, row);
      const canonical = coordinator(row) ? await snapshot(client, [row.survivor_id]) : remote.currentSnapshot;
      validateSnapshot(canonical, row.survivor_id, row.survivor_owner);
      // The source adopts only the coordinator's durable decision and exact
      // canonical content. Source originals and all their associations stay put.
      if (!coordinator(row)) {
        const content = ingredient(canonical, row.survivor_id);
        await adoptContent(client, row, content);
      }
      return update(client, row, 'committed', 1, { ...observation, current_snapshot: canonical,
        applied_fingerprint: hash(await snapshot(client, idsOf(row))) });
    }
    const recover = row.state === 'recovery_prepared' && (coordinator(row)
      ? remote.state === 'recovery_prepared' && remote.epoch === 2
      : remote.state === 'recovered' && remote.epoch === 3);
    if (recover) {
      if (hash(current) !== row.recovery?.appliedFingerprint) fail('Recovery reservation changed', 'CATALOG_IDENTITY_STALE');
      if (coordinator(row)) await writeContent(client, row, true);
      else await adoptContent(client, row, ingredient(row.before_state, row.survivor_id));
      return update(client, row, 'recovered', 3, observation);
    }
    if (row.state === 'committed' && !coordinator(row) && remote.state === 'committed' && remote.epoch === 1) {
      const canonical = refresh;
      if (!canonical) fail('Canonical owner snapshot missing');
      // Refresh is explicit and authenticated. Ordinary LWW is never trusted
      // to overwrite a protected pair, including records from a third peer.
      validateSnapshot(canonical, row.survivor_id, row.survivor_owner);
      const value = ingredient(canonical, row.survivor_id);
      if (value.origin_instance_id !== row.survivor_owner) fail('Canonical owner changed');
      if (hash(canonical) !== hash(row.current_snapshot)) {
        await adoptContent(client, row, value);
      }
      // Do not move the original recovery baseline forward after later edits.
      return update(client, row, row.state, row.epoch, { ...observation, current_snapshot: canonical });
    }
    return update(client, row, row.state, row.epoch, observation);
  });
}
export async function peerIdentityStatus(id, callerId) {
  const self = await localIdentity();
  return withTransaction(async client => {
    await lockCatalog(client);
    const row = await load(client, id);
    if (['aborted', 'recovered'].includes(row.state)) {
      if (row.local_owner !== self) fail('Receipt belongs to a different local owner');
      await identityPeer(peerOf(row));
    } else await revalidate(row, self, client, false);
    if (peerOf(row) !== callerId) fail('Only the other accepted owner may read this receipt', 'CATALOG_IDENTITY_PEER_FORBIDDEN', 403);
    // The immutable decision snapshot remains readable even if later owner
    // edits exceed snapshot transfer capacity. Refresh uses its separate read.
    return { ...present(row, false), plan: row.plan, currentSnapshot: row.current_snapshot,
      appliedFingerprint: row.applied_fingerprint };
  });
}
