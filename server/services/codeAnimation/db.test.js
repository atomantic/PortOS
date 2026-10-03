/** HTTP → PostgreSQL → immutable managed bytes; synthetic records only. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { readFile, readdir, mkdir, symlink, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';
vi.mock('../../lib/paths.js', async importOriginal =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('code-animation-production-') }));
// Narrow filesystem seam: one-shot faults for the staged-write and cleanup steps; everything else is real.
const fsFaults = vi.hoisted(() => ({ failSecondWrite: false, refuseOwnedRemoval: false, writes: 0 }));
vi.mock('fs/promises', async importOriginal => {
  const real = await importOriginal();
  return {
    ...real,
    open: async (path, flags, ...rest) => {
      const handle = await real.open(path, flags, ...rest);
      if (!fsFaults.failSecondWrite || typeof flags !== 'number' || !(flags & real.constants.O_CREAT)) return handle;
      if (++fsFaults.writes < 2) return handle;
      fsFaults.failSecondWrite = false;
      return {
        writeFile: async () => { throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' }); },
        sync: async () => {}, close: () => handle.close(),
      };
    },
    rm: async (path, ...rest) => {
      if (fsFaults.refuseOwnedRemoval && String(path).includes('revisions')) {
        fsFaults.refuseOwnedRemoval = false;
        throw Object.assign(new Error('synthetic EACCES'), { code: 'EACCES' });
      }
      return real.rm(path, ...rest);
    },
  };
});
vi.mock('../socket.js', () => ({ emitCodeAnimationChanged: vi.fn() }));
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { createCodeAnimationPackage } from '../../lib/codeAnimationPackage.js';
import { PATHS } from '../../lib/paths.js';
import routes from '../../routes/codeAnimation.js';

const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('codeAnimation/db.test', health.connected, health.error);
if (ready) await ensureSchema();
const ids = [];
afterAll(async () => {
  if (ready && ids.length) await query('DELETE FROM code_animation_projects WHERE id = ANY($1::text[])', [ids]);
  await close(); cleanupTempDataRoots('code-animation-production-');
});
const app = express();
app.use(express.json({ limit: '55mb' })); app.use('/animation', routes); app.use(errorMiddleware);
const get = path => request(app).get('/animation' + path);
const post = (path, body) => request(app).post('/animation' + path).send(body);
const patch = (path, body) => request(app).patch('/animation' + path).send(body);
const manifest = {
  title: 'Synthetic film', brief: { concept: 'A cube hops over a cone.', cast: '', onScreenText: '' },
  styleGuide: 'Graphic shapes', renderer: { kind: 'browser', version: 'synthetic-v1', engine: null },
  format: { width: 1280, height: 720, fps: 24, durationSeconds: 10 }, seed: 42,
  entrypoints: [{ role: 'preview', path: 'src/index.html' }], assets: ['assets/example.bin'], shots: [], events: [],
  audio: { kind: 'silence' }, execution: {
    requested: { harness: 'example', connection: null, mode: 'api', model: 'example-model', effort: 'low' }, effective: null,
  },
};
const pkg = (source = '<html>synthetic</html>') => createCodeAnimationPackage(manifest, [
  { path: 'src/index.html', content: source },
  { path: 'assets/example.bin', encoding: 'base64', content: Buffer.from([0, 1, 2, 255]).toString('base64') },
]);
const localSettings = { providerId: 'example-provider', connectionId: 'example-local', mode: 'cli', model: 'example-model', effort: 'high' };
const create = async extra => {
  const response = await post('/projects', { manifest, localSettings, ...extra });
  expect(response.status).toBe(201); ids.push(response.body.id); return response.body;
};
const imported = async (id, value = pkg()) => {
  const response = await post(`/projects/${id}/import`, value);
  expect(response.status).toBe(201); return response.body;
};

describe.skipIf(!ready)('Production persisted public boundary', () => {
  it('reopens settings and execution provenance, pages history and exports immutable accepted source separately from new candidates', async () => {
    const project = await create({ referenceIntent: { universeId: 'example-universe', moodBoardId: null, notes: 'Warm light' } });
    const limits = { iterations: 3, timeSeconds: 123, tokens: 4321, renderSeconds: 45, diskBytes: 123456 };
    expect((await patch(`/projects/${project.id}`, { budgets: limits })).status).toBe(200);
    const first = await imported(project.id);
    expect(first).toMatchObject({ executed: false, project: { acceptedRevisionId: null, candidateRevisionId: first.revision.id } });
    expect((await post(`/projects/${project.id}/accept`, { revisionId: first.revision.id })).body.acceptedRevisionId).toBe(first.revision.id);
    const second = await imported(project.id, pkg('<html>new</html>'));
    expect((await get(`/projects/${project.id}`)).body).toMatchObject({ budgets: limits, localSettings, acceptedRevisionId: first.revision.id, candidateRevisionId: second.revision.id });
    const history = (await get(`/projects/${project.id}/history?limit=1`)).body;
    expect(history.items).toHaveLength(1); expect(history.nextCursor).toBe('1');
    expect(history.items[0]).toMatchObject({ status: 'completed', revisionId: second.revision.id, data: { requested: localSettings, effective: null, stageRunIds: {}, budgets: limits, executed: false } });
    expect((await get(`/projects/${project.id}/revisions/${first.revision.id}/package`)).body).toEqual(pkg());
    const brief = (await get(`/projects/${project.id}/brief`)).body;
    expect(brief).toMatchObject({ budgets: limits, manifest: { execution: { requested: null, effective: null } } });
    expect(JSON.stringify(brief)).not.toMatch(/example-provider|example-local|example-universe|relativePath/);
    expect((await get('/projects?limit=1')).body.items[0]).not.toHaveProperty('manifest');
    await query("INSERT INTO code_animation_project_runs (id, project_id, status, data) VALUES ($1, $2, 'staging', $3)", [randomUUID(), project.id, { executed: false }]);
    expect((await get(`/projects/${project.id}/history`)).body.items.some(run => run.status === 'interrupted' && run.data.executed === false)).toBe(true);
  });

  it('gives overlapping imports distinct owned destinations and rejects stale or cross-project acceptance', async () => {
    const project = await create();
    const [a, b] = await Promise.all([imported(project.id), imported(project.id)]);
    expect(a.revision.storage.relativePath).not.toBe(b.revision.storage.relativePath);
    for (const revision of [a.revision, b.revision]) {
      expect(await readFile(join(PATHS.data, revision.storage.relativePath, 'src/index.html'), 'utf8')).toBe('<html>synthetic</html>');
    }
    const current = (await get(`/projects/${project.id}`)).body.candidateRevisionId;
    const stale = current === a.revision.id ? b.revision.id : a.revision.id;
    expect((await post(`/projects/${project.id}/accept`, { revisionId: stale })).status).toBe(409);
    expect((await post(`/projects/${project.id}/accept`, { revisionId: current })).status).toBe(200);
    const other = await create();
    expect((await post(`/projects/${other.id}/accept`, { revisionId: current })).status).toBe(404);
  });

  it('refuses unsafe packages, symlinks and cumulative disk overflow while retaining accepted work', async () => {
    const project = await create();
    const first = await imported(project.id);
    await post(`/projects/${project.id}/accept`, { revisionId: first.revision.id });
    const value = pkg(); value.files[0].path = '../escape.html';
    expect((await post(`/projects/${project.id}/import`, value)).status).toBe(400);
    expect((await patch(`/projects/${project.id}`, { budgets: { ...project.budgets, diskBytes: first.revision.totalBytes - 1 } })).status).toBe(409);
    await patch(`/projects/${project.id}`, { budgets: { ...project.budgets, diskBytes: first.revision.totalBytes } });
    expect((await post(`/projects/${project.id}/import`, pkg())).status).toBe(409);
    expect((await get(`/projects/${project.id}`)).body).toMatchObject({ acceptedRevisionId: first.revision.id, candidateRevisionId: null });
    expect((await get(`/projects/${project.id}/history`)).body.items.some(run => run.status === 'failed')).toBe(true);

    const linked = await create();
    const parent = join(PATHS.data, 'code-animations', 'projects', linked.id);
    const outside = join(PATHS.data, 'synthetic-outside');
    await mkdir(parent); await mkdir(outside);
    await symlink(outside, join(parent, 'revisions'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await post(`/projects/${linked.id}/import`, pkg())).status).toBe(409);
    expect((await get(`/projects/${linked.id}`)).body.candidateRevisionId).toBeNull();
    const file = join(PATHS.data, first.revision.storage.relativePath, 'src/index.html');
    await rm(file); await writeFile(join(outside, 'example.html'), '<html>outside</html>');
    await symlink(join(outside, 'example.html'), file);
    expect((await get(`/projects/${project.id}/revisions/${first.revision.id}/package`)).status).toBe(409);
    await rm(file); await writeFile(file, '<html>changed</html>');
    expect((await get(`/projects/${project.id}/revisions/${first.revision.id}/package`)).status).toBe(409);
  });

  describe('failed import disk reservations', () => {
    // Same-length sources, so every import reserves the same byte count.
    const variant = char => pkg(`<html>syntheti${char}</html>`);
    const revisionsDir = projectId => join(PATHS.data, 'code-animations', 'projects', projectId, 'revisions');
    const reservations = async projectId => (await query(
      "SELECT status, (data->>'reservedBytes')::int AS reserved FROM code_animation_project_runs WHERE project_id = $1 ORDER BY created_at, id", [projectId])).rows;
    const revisionCount = async projectId =>
      Number((await query('SELECT COUNT(*) AS n FROM code_animation_project_revisions WHERE project_id = $1', [projectId])).rows[0].n);
    const armFaults = faults => Object.assign(fsFaults, { failSecondWrite: false, refuseOwnedRemoval: false, writes: 0 }, faults);
    // Accepted + candidate revisions exist; budget leaves room for exactly one more same-size import.
    const seeded = async () => {
      const project = await create();
      const accepted = await imported(project.id, variant('A'));
      await post(`/projects/${project.id}/accept`, { revisionId: accepted.revision.id });
      const candidate = await imported(project.id, variant('B'));
      const bytes = accepted.revision.totalBytes;
      expect((await patch(`/projects/${project.id}`, { budgets: { ...project.budgets, diskBytes: bytes * 3 } })).status).toBe(200);
      return { project, accepted, candidate, bytes };
    };
    const expectPointers = async ({ project, accepted, candidate }) =>
      expect((await get(`/projects/${project.id}`)).body).toMatchObject({ acceptedRevisionId: accepted.revision.id, candidateRevisionId: candidate.revision.id });

    it('keeps the full reservation when a write failure is followed by a refused cleanup, so retries cannot exceed the budget', async () => {
      const state = await seeded();
      const { project, bytes } = state;
      armFaults({ failSecondWrite: true, refuseOwnedRemoval: true });
      expect((await post(`/projects/${project.id}/import`, variant('C'))).status).toBe(500);
      expect((await reservations(project.id)).at(-1)).toEqual({ status: 'failed', reserved: bytes });
      expect(await revisionCount(project.id)).toBe(2);
      await expectPointers(state);
      const dirsBefore = await readdir(revisionsDir(project.id));
      expect(dirsBefore).toHaveLength(3);
      // The partial first file is still on disk and still owned by the failed run.
      const failed = (await get(`/projects/${project.id}/history`)).body.items.find(run => run.status === 'failed');
      expect((await readdir(join(PATHS.data, failed.data.relativePath, 'assets'))).length + (await readdir(join(PATHS.data, failed.data.relativePath, 'src'))).length).toBeGreaterThan(0);
      for (let attempt = 0; attempt < 3; attempt++) {
        expect((await post(`/projects/${project.id}/import`, variant('D'))).status).toBe(409);
      }
      expect(await readdir(revisionsDir(project.id))).toEqual(dirsBefore);
      expect((await reservations(project.id)).reduce((sum, run) => sum + run.reserved, 0)).toBe(bytes * 3);
    });

    it('releases the reservation after a confirmed cleanup, and when no owned directory was ever created', async () => {
      const state = await seeded();
      const { project, bytes } = state;
      armFaults({ failSecondWrite: true });
      expect((await post(`/projects/${project.id}/import`, variant('C'))).status).toBe(500);
      expect((await reservations(project.id)).at(-1)).toEqual({ status: 'failed', reserved: 0 });
      expect(await readdir(revisionsDir(project.id))).toHaveLength(2);
      await expectPointers(state);
      const retry = await post(`/projects/${project.id}/import`, variant('D'));
      expect(retry.status).toBe(201);
      expect(retry.body.revision.totalBytes).toBe(bytes);

      const linked = await create();
      const outside = join(PATHS.data, 'synthetic-outside-reservation');
      const parent = join(PATHS.data, 'code-animations', 'projects', linked.id);
      await mkdir(parent, { recursive: true }); await mkdir(outside, { recursive: true });
      await symlink(outside, join(parent, 'revisions'), process.platform === 'win32' ? 'junction' : 'dir');
      expect((await post(`/projects/${linked.id}/import`, pkg())).status).toBe(409);
      expect((await reservations(linked.id)).at(-1)).toEqual({ status: 'failed', reserved: 0 });
    });

    it('retains the staged tree and reservation when publication fails, rolls back the revision, and publishes a clean control import', async () => {
      const state = await seeded();
      const { project, bytes } = state;
      const trigger = `code_animation_fail_${project.id.replaceAll('-', '')}`;
      await query(`CREATE OR REPLACE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic publish failure'; END $$`);
      await query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON code_animation_project_revisions
        FOR EACH ROW WHEN (NEW.project_id = '${project.id}') EXECUTE FUNCTION ${trigger}()`);
      try {
        expect((await post(`/projects/${project.id}/import`, variant('C'))).status).toBe(500);
      } finally {
        await query(`DROP TRIGGER IF EXISTS ${trigger} ON code_animation_project_revisions`);
        await query(`DROP FUNCTION IF EXISTS ${trigger}()`);
      }
      expect((await reservations(project.id)).at(-1)).toEqual({ status: 'failed', reserved: bytes });
      expect(await revisionCount(project.id)).toBe(2);
      expect(await readdir(revisionsDir(project.id))).toHaveLength(3);
      await expectPointers(state);
      // The retained tree still counts against the budget until the operator raises it.
      expect((await post(`/projects/${project.id}/import`, variant('D'))).status).toBe(409);
      expect((await patch(`/projects/${project.id}`, { budgets: { ...project.budgets, diskBytes: bytes * 4 } })).status).toBe(200);
      const control = await imported(project.id, variant('D'));
      expect(await revisionCount(project.id)).toBe(3);
      expect((await get(`/projects/${project.id}`)).body).toMatchObject({ acceptedRevisionId: state.accepted.revision.id, candidateRevisionId: control.revision.id });
      expect((await get(`/projects/${project.id}/revisions/${control.revision.id}/package`)).body).toEqual(variant('D'));
    });
  });
});
