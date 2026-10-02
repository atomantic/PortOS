/** Public acceptance routes: frozen promotion, stale detection, failed-run isolation and downstream discovery. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { chmod, mkdir, readFile, writeFile } from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { join } from 'path';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';
vi.mock('../../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('animation-acceptance-') }));
vi.mock('../../lib/fileUtils.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('animation-acceptance-') }));
vi.mock('../socket.js', () => ({ emitCodeAnimationChanged: vi.fn() }));
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { request } from '../../lib/testHelper.js';
import { PATHS } from '../../lib/paths.js';
import { createCodeAnimationPackage } from '../../lib/codeAnimationPackage.js';
import { emitCodeAnimationChanged } from '../socket.js';
import { loadHistory, saveHistory } from '../videoGen/history.js';
import routes from '../../routes/codeAnimation.js';

const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('codeAnimation/acceptance.db.test', health.connected, health.error);
if (ready) await ensureSchema();
const ids = [];
afterAll(async () => {
  if (ready && ids.length) await query('DELETE FROM code_animation_projects WHERE id = ANY($1::text[])', [ids]);
  await close(); cleanupTempDataRoots();
});
const app = express(); app.use(express.json({ limit: '55mb' })); app.use('/animation', routes); app.use(errorMiddleware);
const post = (path, body) => request(app).post(`/animation${path}`).send(body);
const get = path => request(app).get(`/animation${path}`);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

const manifest = {
  title: 'Example short', brief: { concept: 'An original reveal', cast: '', onScreenText: '' }, styleGuide: 'Flat shapes',
  renderer: { kind: 'browser', version: 'example-v1', engine: null }, format: { width: 1280, height: 720, fps: 12, durationSeconds: 2 }, seed: 1,
  entrypoints: [{ role: 'preview', path: 'index.html' }], assets: [], shots: [], events: [], audio: { kind: 'silence' },
  execution: { requested: null, effective: null },
};

async function project() {
  const created = await post('/projects', { manifest });
  ids.push(created.body.id);
  const imported = await post(`/projects/${created.body.id}/import`, createCodeAnimationPackage(manifest, [{ path: 'index.html', content: '<html><canvas></canvas></html>' }]));
  return { id: created.body.id, revision: imported.body.revision };
}

/** A finished run as the stage pipeline persists it; the pipeline itself is covered by stages.db.test. */
async function finishedRun({ id, revision }, { verdict = 'pass', bytes = 'example-mp4-bytes', settings = {}, spent = {} } = {}) {
  const runId = randomUUID();
  const videoId = randomUUID();
  const filename = `composition-${runId}.mp4`;
  await mkdir(PATHS.videos, { recursive: true });
  await writeFile(join(PATHS.videos, filename), bytes);
  const history = await loadHistory().catch(() => []);
  await saveHistory([{ id: videoId, filename, prompt: 'Example short', createdAt: new Date().toISOString() }, ...history]);
  const failed = verdict !== 'pass';
  await query(`INSERT INTO code_animation_project_runs (id, project_id, revision_id, status, data, completed_at) VALUES ($1,$2,$3,$4,$5,NOW())`,
    [runId, id, revision.id, failed ? 'failed' : 'completed', {
      kind: 'production-stages', currentRevisionId: revision.id, sourceRevisionId: revision.id,
      requested: { providerId: 'example', model: 'example-model', effort: 'high', ...settings.requested }, effective: settings.effective ?? null,
      budgets: { iterations: 8, tokens: 1000 }, spent: { iterations: 1, tokens: 200, renderMs: 5000, elapsedMs: 9000, diskBytes: 100, ...spent },
      stages: [{ key: 'style-frame', revisionId: revision.id, status: 'completed', artifacts: [{ atSeconds: 0.5, relativePath: 'code-animations/example.png' }] }],
      findings: failed ? [{ kind: 'frozen-film', severity: 'error', detail: 'Nothing moves.', atSeconds: 0 }] : [{ kind: 'event-without-change', severity: 'warning', detail: 'Quiet beat.', atSeconds: 1.5 }],
      verdict: { status: verdict, revisionId: revision.id, sourceHash: revision.sourceHash, unverified: [{ dimension: 'semantic-visual', reason: 'No reviewer ran.' }] },
      soundtrack: { artifact: null, unverified: [] }, repairs: [],
      output: failed ? null : {
        revisionId: revision.id, sourceHash: revision.sourceHash, packageHash: revision.packageHash, audioHash: null, videoId, filename, path: `/data/videos/${filename}`,
        audioEvidence: { videoHash: sha(bytes) }, verifiedDimensions: ['frame-size', 'timing', 'visual-motion', 'audio'], unverified: [{ dimension: 'semantic-visual', reason: 'No reviewer ran.' }],
      },
    }]);
  return { runId, videoId, filename };
}

describe.skipIf(!ready)('Production acceptance', () => {
  it('promotes a passing run, separates evidence dimensions, marks Media History and lists the short downstream', async () => {
    const p = await project();
    const run = await finishedRun(p);
    const accepted = await post(`/projects/${p.id}/accepted-output`, { runId: run.runId });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ acceptedRevisionId: p.revision.id, candidateRevisionId: null, acceptedOutput: { runId: run.runId, videoId: run.videoId, sourceHash: p.revision.sourceHash, renderHash: sha('example-mp4-bytes') } });
    expect(emitCodeAnimationChanged).toHaveBeenCalledWith(p.id);

    const view = (await get(`/projects/${p.id}/acceptance`)).body;
    expect(view.accepted).toMatchObject({ fresh: true, stale: [], path: `/data/videos/${run.filename}` });
    expect(view.accepted.evidence).toMatchObject({
      technical: { status: 'verified' }, visual: { status: 'partial' }, temporal: { status: 'partial' }, sound: { status: 'partial' },
    });
    // Nothing listened to the film: hearing stays unverified rather than passing.
    expect(view.accepted.evidence.sound.unverified.map(item => item.dimension)).toContain('hearing');

    expect((await loadHistory()).find(entry => entry.id === run.videoId).codeAnimation.acceptance).toMatchObject({ projectId: p.id, runId: run.runId });
    const assets = (await get('/accepted-assets')).body.items.find(item => item.projectId === p.id);
    expect(assets).toMatchObject({ videoId: run.videoId, sourceHash: p.revision.sourceHash, packageUrl: `/api/code-animation/projects/${p.id}/revisions/${p.revision.id}/package` });
  });

  it('refuses a failing run and keeps the accepted playback when a later candidate fails', async () => {
    const p = await project();
    const good = await finishedRun(p);
    await post(`/projects/${p.id}/accepted-output`, { runId: good.runId });
    const bad = await finishedRun(p, { verdict: 'fail' });
    const refused = await post(`/projects/${p.id}/accepted-output`, { runId: bad.runId });
    expect(refused).toMatchObject({ status: 409, body: { code: 'CODE_ANIMATION_OUTPUT_NOT_ACCEPTABLE' } });
    const view = (await get(`/projects/${p.id}/acceptance`)).body;
    expect(view.accepted).toMatchObject({ runId: good.runId, fresh: true, path: `/data/videos/${good.filename}` });
    expect(view.runs.map(item => [item.runId, item.accepted, item.acceptable])).toEqual(expect.arrayContaining([[good.runId, true, true], [bad.runId, false, false]]));
    expect(view.runs.find(item => item.runId === bad.runId).evidence.temporal.status).toBe('failed');
  });

  it('invalidates the earlier passing review when the rendered video or the source bytes change', async () => {
    const p = await project();
    const run = await finishedRun(p);
    await post(`/projects/${p.id}/accepted-output`, { runId: run.runId });
    await writeFile(join(PATHS.videos, run.filename), 'a different render');
    const rendered = (await get(`/projects/${p.id}/acceptance`)).body.accepted;
    expect(rendered).toMatchObject({ fresh: false, path: `/data/videos/${run.filename}` });
    expect(rendered.stale.map(item => item.dimension)).toEqual(['render']);

    const sourceFile = join(PATHS.data, p.revision.storage.relativePath, 'index.html');
    await chmod(sourceFile, 0o600);
    await writeFile(sourceFile, '<html>tampered</html>');
    expect((await get(`/projects/${p.id}/acceptance`)).body.accepted.stale.map(item => item.dimension)).toEqual(expect.arrayContaining(['source', 'render']));
    // A changed render cannot be promoted in the first place.
    const other = await project();
    const changed = await finishedRun(other);
    await writeFile(join(PATHS.videos, changed.filename), 'swapped before acceptance');
    expect((await post(`/projects/${other.id}/accepted-output`, { runId: changed.runId })).body.code).toBe('CODE_ANIMATION_RENDER_CHANGED');
  });

  it('compares two same-brief runs by requested and effective route, budgets and spend without conflating effort', async () => {
    const p = await project();
    const a = await finishedRun(p, { settings: { effective: { providerId: 'example', model: 'example-model', effort: 'high' } }, spent: { iterations: 1, tokens: 200 } });
    const b = await finishedRun(p, { settings: { requested: { effort: 'low' }, effective: { providerId: 'example', model: 'example-model', effort: 'low' } }, spent: { iterations: 4, tokens: 900 } });
    const { runs } = (await get(`/projects/${p.id}/acceptance`)).body;
    const [left, right] = [a, b].map(item => runs.find(entry => entry.runId === item.runId));
    expect([left.settings.effective.effort, right.settings.effective.effort]).toEqual(['high', 'low']);
    expect([left.spend.repairs, right.spend.repairs]).toEqual([1, 4]);
    expect([left.spend.tokens, right.spend.tokens]).toEqual([200, 900]);
    expect(left.budgets).toEqual(right.budgets);
    expect(await readFile(join(PATHS.videos, a.filename), 'utf8')).toBe('example-mp4-bytes');
  });
});
