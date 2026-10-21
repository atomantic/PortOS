/**
 * The behavior every cos_agents backend must have, run by the in-memory suite
 * (cosAgentRepository.test.js) and the PostgreSQL suite (cosAgentRepository.db.test.js)
 * so the two cannot drift. Not a test file itself: it only registers cases.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { planAgentSave } from '../lib/cosAgentRows.js';

const id = (n) => `agent-example-${String(n).padStart(4, '0')}`;
const agent = (n, extra = {}) => ({
  id: id(n), taskId: `task-example-${n}`, status: 'running', startedAt: '2026-01-02T03:04:05.000Z',
  metadata: { app: 'example-app', note: 'a }{ b \u0000 ü' }, output: [], ...extra,
});

/** @param {{ name: string, makeBackend: () => Promise<object>|object }} options */
export function __runCosAgentRepositoryContract({ name, makeBackend }) {
  describe(`cos_agents contract (${name})`, () => {
    let backend;
    let persisted;
    let version;
    // Saves a whole map the way cosState does: plan against what was loaded, then apply.
    const save = async (next) => {
      const plan = planAgentSave({ persisted, next });
      version = await backend.apply(plan, version);
      persisted = plan.persisted;
      return plan;
    };
    const load = async () => {
      const loaded = await backend.loadAgents();
      return { version: loaded.version, agents: Object.fromEntries(loaded.rows.map((row) => [row.id, JSON.parse(row.body)])), rows: loaded.rows };
    };

    beforeEach(async () => {
      backend = await makeBackend();
      persisted = new Map();
      version = 0;
    });

    it('starts empty at version 0', async () => {
      expect(await backend.loadAgents()).toEqual({ version: 0, rows: [] });
    });

    it('round-trips every record byte for byte, in insertion order', async () => {
      const map = { [id(3)]: agent(3), [id(1)]: agent(1, { status: 'completed', completedAt: '2026-01-02T04:00:00.000Z', pid: 4242 }), [id(2)]: agent(2) };
      await save(map);
      const { rows } = await backend.loadAgents();
      expect(rows.map((row) => row.id)).toEqual([id(3), id(1), id(2)]);
      expect(rows.map((row) => row.body)).toEqual(Object.values(map).map((value) => JSON.stringify(value)));
    });

    it('writes only the changed row and deletes ids that left the map', async () => {
      const map = { [id(1)]: agent(1), [id(2)]: agent(2), [id(3)]: agent(3) };
      await save(map);
      const changed = { ...map, [id(2)]: { ...map[id(2)], status: 'completed', output: [{ line: 'done' }] } };
      delete changed[id(3)];
      const plan = await save(changed);
      expect(plan.upserts.map((row) => row.id)).toEqual([id(2)]);
      expect(plan.deletes).toEqual([id(3)]);
      const { agents } = await load();
      expect(agents).toEqual({ [id(1)]: map[id(1)], [id(2)]: changed[id(2)] });
    });

    it('bumps the version per write and refuses a write planned against a stale version', async () => {
      await save({ [id(1)]: agent(1) });
      expect((await backend.loadAgents()).version).toBe(1);
      const stalePlan = planAgentSave({ persisted: new Map(), next: {} });
      await expect(backend.apply({ ...stalePlan, deletes: [id(1)] }, 0)).rejects.toMatchObject({ code: 'COS_AGENTS_STALE', status: 409 });
      expect((await load()).agents).toEqual({ [id(1)]: agent(1) });
      expect((await backend.loadAgents()).version).toBe(1);
    });

    it('lets exactly one of two writes planned against the same version land', async () => {
      await save({ [id(1)]: agent(1) });
      const first = planAgentSave({ persisted, next: { [id(1)]: agent(1, { status: 'completed' }) } });
      const second = planAgentSave({ persisted, next: { [id(1)]: agent(1, { status: 'failed' }) } });
      const results = await Promise.allSettled([backend.apply(first, version), backend.apply(second, version)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected').reason.code).toBe('COS_AGENTS_STALE');
    });

    it('serves single records and bodiless statuses straight from the store', async () => {
      await save({ [id(1)]: agent(1), [id(2)]: agent(2, { status: 'paused' }) });
      expect(await backend.getAgent(id(2))).toEqual(agent(2, { status: 'paused' }));
      expect(await backend.getAgent(id(9))).toBeNull();
      expect(await backend.listStatuses()).toEqual([{ id: id(1), status: 'running' }, { id: id(2), status: 'paused' }]);
    });

    it('stores a malformed record without dropping it', async () => {
      await save({ [id(1)]: { status: 42 }, [id(2)]: null });
      expect((await load()).agents).toEqual({ [id(1)]: { status: 42 }, [id(2)]: null });
      expect(await backend.listStatuses()).toEqual([{ id: id(1), status: 'unknown' }, { id: id(2), status: 'unknown' }]);
    });
  });
}
