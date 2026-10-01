/** HTTP → PostgreSQL → immutable managed bytes; synthetic records only. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { readFile, mkdir, symlink, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';
vi.mock('../../lib/paths.js', async importOriginal =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('code-animation-production-') }));
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
});
