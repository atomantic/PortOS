import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as db from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { catalogDdl } from '../../lib/db/schema/catalog.js';
import { catalogIdentityDdl } from '../../lib/db/schema/catalogIdentity.js';
import { buildCatalogIdentityViewsDdl } from '../../lib/db/schema/catalogIdentityViews.js';

const context = new AsyncLocalStorage();
const fixture = vi.hoisted(() => ({ runtime: null }));
vi.mock('../../lib/db.js', async original => {
  const actual = await original();
  return { ...actual,
    query: (...args) => fixture.runtime ? actual.withTransaction(async client => {
      await client.query(`SET LOCAL search_path TO ${fixture.runtime.schema()}, public`);
      return client.query(...args);
    }) : actual.query(...args),
    withTransaction: fn => actual.withTransaction(async client => {
      if (fixture.runtime) await client.query(`SET LOCAL search_path TO ${fixture.runtime.schema()}, public`);
      return fn(client);
    }),
  };
});
vi.mock('../instanceIdentity.js', () => ({ getInstanceId: async () => fixture.runtime.owner(), UNKNOWN_INSTANCE_ID: 'unknown' }));
vi.mock('../sharing/peerSyncShared.js', () => ({
  findPeerById: async id => fixture.runtime.peer(id),
  peerAllowsOutbound: peer => peer.enabled !== false && peer.syncEnabled !== false && peer.directions.includes('outbound'),
  peerAllowsCategoryPull: peer => peer.syncCategories.catalog === true,
}));
vi.mock('../../lib/peerHttpClient.js', async original => ({ ...await original(), peerFetch: (...args) => fixture.runtime.fetch(...args) }));
const protocol = await import('./index.js');
const transport = await import('./transport.js');
const actual = await vi.importActual('../../lib/db.js');
const health = await actual.checkHealth().catch(error => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('bilateral canonical identity protocol', health.connected, health.error);
const runId = randomUUID().replaceAll('-', '');
const owners = ['fixture-source', 'fixture-canonical'];
const schemas = Object.fromEntries(owners.map((owner, i) => [owner, `identity_${runId}_${i}`]));
const configs = {};
let offline = false;
let corrupt = false;
let wireHook = null;
const as = (owner, fn) => context.run(owner, fn);
const sql = (owner, text, args = []) => as(owner, () => db.query(text, args));
function resetPeers() {
  offline = false; corrupt = false; wireHook = null;
  for (const owner of owners) configs[owner] = { instanceId: owner, host: `${owner}.invalid`, port: 5555,
    syncSecret: 'fake-fixture-pair-secret-never-used-outside-tests', auth: { password: 'fake-must-never-send' },
    enabled: true, syncEnabled: true, directions: ['inbound', 'outbound'], syncCategories: { catalog: true } };
}
beforeAll(async () => {
  if (!ready) return;
  resetPeers();
  for (const schema of Object.values(schemas)) {
    await actual.query(`CREATE SCHEMA ${schema}`);
    await actual.withTransaction(async client => {
      await client.query(`SET LOCAL search_path TO ${schema}, public`);
      for (const statement of [...catalogDdl, ...catalogIdentityDdl, ...buildCatalogIdentityViewsDdl()]) await client.query(statement);
    });
  }
  fixture.runtime = {
    owner: () => context.getStore(), schema: () => schemas[context.getStore()],
    peer: id => configs[id] ? structuredClone(configs[id]) : null,
    fetch: async (url, options, peer) => {
      if (offline) throw new Error('fixture peer offline');
      expect(peer.auth).toBeUndefined(); expect(options.headers.Authorization).toBeUndefined();
      const caller = context.getStore(); const target = peer.instanceId; const parsed = new URL(url);
      return as(target, async () => {
        const authenticated = await transport.authenticateIdentityPeer({ headers: {
          'x-portos-instance-id': caller, 'x-portos-peer-auth': options.headers['X-PortOS-Peer-Auth'] } });
        const kind = parsed.pathname.endsWith('/snapshot') ? 'snapshot' : 'status';
        const id = parsed.searchParams.get(kind === 'snapshot' ? 'ingredientId' : 'operationId');
        const value = kind === 'snapshot' ? await protocol.ownerSnapshot(id) : await protocol.peerIdentityStatus(id, caller);
        const response = transport.signEvidence(authenticated, { owner: target,
          challenge: parsed.searchParams.get('challenge'), kind, target: id, value });
        if (corrupt) response.challenge = 'f'.repeat(64);
        if (wireHook) wireHook(response);
        return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
    },
  };
});
afterAll(async () => {
  fixture.runtime = null;
  if (ready) for (const schema of Object.values(schemas)) await actual.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await actual.close();
});
async function pair() {
  resetPeers(); const sourceId = `source-${randomUUID()}`; const survivorId = `survivor-${randomUUID()}`;
  for (const owner of owners) for (const [id, origin, name, description] of [
    [sourceId, owners[0], 'Fixture musician', 'Original biography'], [survivorId, owners[1], 'Fixture performer', 'Performance canon'],
  ]) {
    await sql(owner, `INSERT INTO catalog_ingredients(id,type,name,payload,tags,origin_instance_id,created_at,updated_at)
      VALUES ($1,'character',$2,$3::jsonb,ARRAY['fixture'],$4,'2026-01-01','2026-01-01')`,
    [id, name, JSON.stringify({ locked: false, description, primaryImageRef: `${id}.png` }), origin]);
    await sql(owner, `INSERT INTO catalog_ingredient_revisions(id,ingredient_id,name,payload,created_at)
      VALUES ($1,$2,$3,$4::jsonb,'2026-01-01')`, [`${id}-revision-${owner}`, id, name, JSON.stringify({ description })]);
  }
  return { operationId: randomUUID(), sourceId, survivorId, fieldChoices: { '/name': 'survivor', '/payload/description': 'source', '/payload/primaryImageRef': 'survivor' } };
}
async function propose(input) {
  const preview = await as(owners[1], () => protocol.previewIdentity(input)); expect(preview.conflicts).toEqual([]);
  const receipt = await as(owners[1], () => protocol.createIdentity({ ...input, planHash: preview.planHash }));
  await as(owners[0], () => protocol.importIdentity({ peerId: owners[1], operationId: receipt.id })); return receipt;
}
async function prepare(receipt) {
  await as(owners[1], () => protocol.acceptIdentity(receipt.id, receipt.planHash));
  await as(owners[0], () => protocol.acceptIdentity(receipt.id, receipt.planHash));
}
async function commit(receipt) {
  await prepare(receipt); await as(owners[1], () => protocol.advanceIdentity(receipt.id)); await as(owners[0], () => protocol.advanceIdentity(receipt.id));
}
describe.skipIf(!ready)('two owner persisted canonical identity protocol', () => {
  it('survives interrupted commit and recovery while preserving original rows and exact reviewed owner evidence', async () => {
    const input = await pair(); const receipt = await propose(input);
    const original = (await sql(owners[0], 'SELECT * FROM catalog_ingredients WHERE id=$1', [input.sourceId])).rows[0];
    expect((await as(owners[1], () => protocol.createIdentity({ ...input, planHash: receipt.planHash }))).id).toBe(receipt.id);
    await prepare(receipt);
    await expect(sql(owners[0], 'UPDATE catalog_ingredients SET name=$2 WHERE id=$1', [input.sourceId, 'blocked'])).rejects.toThrow('protected');
    await expect(sql(owners[1], `INSERT INTO catalog_ingredient_refs(ingredient_id,ref_kind,ref_id,role) VALUES($1,'universe','fixture','cast')`, [input.survivorId])).rejects.toThrow('protected');
    await expect(as(owners[0], () => protocol.abortIdentity(receipt.id))).rejects.toThrow('Only the coordinator');
    expect(await as(owners[1], () => protocol.advanceIdentity(receipt.id))).toMatchObject({ state: 'committed', epoch: 1 });
    offline = true;
    await expect(as(owners[0], () => protocol.advanceIdentity(receipt.id))).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_PEER_UNAVAILABLE' });
    expect((await as(owners[0], () => protocol.getIdentityOperation(receipt.id))).state).toBe('prepared');
    offline = false; await as(owners[0], () => protocol.advanceIdentity(receipt.id));
    expect((await sql(owners[0], 'SELECT * FROM catalog_ingredients WHERE id=$1', [input.sourceId])).rows[0]).toEqual(original);
    for (const owner of owners) {
      expect((await sql(owner, 'SELECT catalog_canonical_ingredient_id($1) AS id', [input.sourceId])).rows[0].id).toBe(input.survivorId);
      expect((await sql(owner, 'SELECT payload FROM catalog_ingredients WHERE id=$1', [input.survivorId])).rows[0].payload.description).toBe('Original biography');
    }
    await expect(as(owners[0], () => protocol.prepareIdentityRecovery(receipt.id, receipt.planHash))).rejects.toThrow('canonical owner before');
    await as(owners[1], () => protocol.prepareIdentityRecovery(receipt.id, receipt.planHash));
    await as(owners[0], () => protocol.prepareIdentityRecovery(receipt.id, receipt.planHash));
    await as(owners[1], () => protocol.advanceIdentity(receipt.id));
    expect((await as(owners[1], () => protocol.advanceIdentity(receipt.id))).state).toBe('recovered');
    await as(owners[0], () => protocol.advanceIdentity(receipt.id));
    for (const owner of owners) {
      expect((await sql(owner, 'SELECT catalog_canonical_ingredient_id($1) AS id', [input.sourceId])).rows[0].id).toBe(input.sourceId);
      expect((await sql(owner, 'SELECT payload FROM catalog_ingredients WHERE id=$1', [input.survivorId])).rows[0].payload.description).toBe('Performance canon');
    }
  });
  it('rejects forged/replayed evidence, revoked directions and stale acceptance before fencing', async () => {
    const input = await pair(); corrupt = true;
    await expect(as(owners[1], () => protocol.previewIdentity(input))).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_EVIDENCE_INVALID' });
    corrupt = false; configs[owners[0]].directions = ['outbound'];
    await expect(as(owners[1], () => protocol.previewIdentity(input))).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_PEER_FORBIDDEN' });
    resetPeers(); const receipt = await propose(input);
    await sql(owners[0], 'UPDATE catalog_ingredients SET name=$2 WHERE id=$1', [input.sourceId, 'New approved source']);
    await expect(as(owners[0], () => protocol.acceptIdentity(receipt.id, receipt.planHash))).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_STALE' });
    expect((await as(owners[0], () => protocol.getIdentityOperation(receipt.id))).state).toBe('proposed');
  });
  it('fences relation endpoints, foreign writes and type changes; later canonical edits cannot be recovered over', async () => {
    const input = await pair(); const receipt = await propose(input); await commit(receipt);
    await expect(sql(owners[0], 'UPDATE catalog_ingredients SET name=$2 WHERE id=$1', [input.survivorId, 'Foreign edit'])).rejects.toThrow('protected');
    await expect(sql(owners[1], `INSERT INTO catalog_ingredient_relations(from_id,to_id,kind) VALUES($1,$2,'related-to')`, [input.survivorId, input.sourceId])).rejects.toThrow('protected');
    await expect(sql(owners[1], 'UPDATE catalog_ingredients SET type=$2 WHERE id=$1', [input.survivorId, 'object'])).rejects.toThrow('protected');
    await sql(owners[1], 'UPDATE catalog_ingredients SET name=$2 WHERE id=$1', [input.survivorId, 'Later canonical edit']);
    await as(owners[0], () => protocol.advanceIdentity(receipt.id));
    expect((await sql(owners[0], 'SELECT name FROM catalog_ingredients WHERE id=$1', [input.survivorId])).rows[0].name).toBe('Later canonical edit');
    await expect(as(owners[1], () => protocol.prepareIdentityRecovery(receipt.id, receipt.planHash))).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_STALE' });
  });
  it('retains a coordinator abort and allows prepared source release only after verifying that decision', async () => {
    const input = await pair(); const receipt = await propose(input); await prepare(receipt);
    await as(owners[1], () => protocol.abortIdentity(receipt.id));
    expect((await as(owners[0], () => protocol.advanceIdentity(receipt.id))).state).toBe('aborted');
    expect((await as(owners[0], () => protocol.advanceIdentity(receipt.id))).epoch).toBe(1);
    await sql(owners[0], 'UPDATE catalog_ingredients SET name=$2 WHERE id=$1', [input.sourceId, 'Writable after abort']);
  });
  it('invalidates peer rebinding and signed owner/ID substitution rather than accepting a different record', async () => {
    const input = await pair();
    wireHook = () => { configs[owners[0]].host = 'changed.invalid'; };
    await expect(as(owners[1], () => protocol.previewIdentity(input))).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_EVIDENCE_INVALID' });
    resetPeers();
    wireHook = response => {
      response.value.ingredients[0].id = 'unrelated-fixture-id';
      const { mac: _mac, ...evidence } = response;
      Object.assign(response, transport.signEvidence({ ...configs[owners[1]], instanceId: owners[1] }, evidence));
    };
    await expect(as(owners[1], () => protocol.previewIdentity(input))).rejects.toThrow('snapshot identity');
  });
  it('can locally cancel after peer revocation; a prepared source still requires verified coordinator release', async () => {
    const input = await pair(); const receipt = await propose(input); await prepare(receipt);
    configs[owners[0]].syncEnabled = false;
    expect((await as(owners[1], () => protocol.abortIdentity(receipt.id))).state).toBe('aborted');
    await expect(as(owners[0], () => protocol.advanceIdentity(receipt.id))).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_PEER_UNAVAILABLE' });
    expect((await as(owners[0], () => protocol.getIdentityOperation(receipt.id))).state).toBe('prepared');
    resetPeers();
    expect((await as(owners[0], () => protocol.advanceIdentity(receipt.id))).state).toBe('aborted');
  });
  it('rejects an oversized projected canonical revision before creating or fencing any receipt', async () => {
    const input = await pair();
    await sql(owners[1], `UPDATE catalog_ingredients SET payload=jsonb_set(payload,'{notes}',to_jsonb($2::text)) WHERE id=$1`,
      [input.survivorId, 'x'.repeat(2200000)]);
    await expect(as(owners[1], () => protocol.previewIdentity(input))).rejects.toThrow('Projected canonical snapshot');
    expect((await sql(owners[1], 'SELECT id FROM catalog_identity_operations WHERE survivor_id=$1', [input.survivorId])).rowCount).toBe(0);
  });

  it('honors terminal cancellation before acceptance and permits a new intentional attempt with the same content', async () => {
    const input = await pair(); const receipt = await propose(input);
    await as(owners[1], () => protocol.abortIdentity(receipt.id));
    await expect(as(owners[0], () => protocol.acceptIdentity(receipt.id, receipt.planHash))).rejects.toThrow('already decided');
    await sql(owners[0], 'UPDATE catalog_ingredients SET deleted=true WHERE id=$1', [input.sourceId]);
    expect((await as(owners[0], () => protocol.advanceIdentity(receipt.id))).state).toBe('aborted');
    expect((await as(owners[1], () => protocol.advanceIdentity(receipt.id))).peerState).toBe('aborted');
    // A second pair keeps snapshots identical across the cancellation cycle.
    const again = await pair(); const old = await propose(again);
    await as(owners[1], () => protocol.abortIdentity(old.id));
    await as(owners[0], () => protocol.advanceIdentity(old.id));
    const fresh = await propose({ ...again, operationId: randomUUID() });
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.state).toBe('proposed');
    expect((await as(owners[1], () => protocol.createIdentity({ ...again, planHash: old.planHash }))).id).toBe(old.id);
  });
  it('keeps the immutable commit decision readable after oversized later canonical edits and records no invented source revision', async () => {
    const input = await pair(); const receipt = await propose(input); await commit(receipt);
    const sourceRevisions = (await sql(owners[0], 'SELECT actor FROM catalog_ingredient_revisions WHERE ingredient_id=$1', [input.survivorId])).rows;
    expect(sourceRevisions.some(row => row.actor === 'catalog-shared-identity')).toBe(false);
    const ownerTime = (await sql(owners[1], 'SELECT updated_at FROM catalog_ingredients WHERE id=$1', [input.survivorId])).rows[0].updated_at;
    expect((await sql(owners[0], 'SELECT updated_at FROM catalog_ingredients WHERE id=$1', [input.survivorId])).rows[0].updated_at).toEqual(ownerTime);
    await sql(owners[1], `UPDATE catalog_ingredients SET payload=jsonb_set(payload,'{notes}',to_jsonb($2::text)) WHERE id=$1`,
      [input.survivorId, 'x'.repeat(8500000)]);
    expect((await as(owners[0], () => transport.readEvidence(owners[1], 'status', receipt.id))).state).toBe('committed');
    expect((await as(owners[1], () => protocol.advanceIdentity(receipt.id))).peerState).toBe('committed');
  });

});
