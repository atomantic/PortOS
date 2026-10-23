/**
 * Open in storyboard editor (Series Pipeline) and Use as shot art, through the
 * real storyboard router and file-backed board store. The pipeline issue store
 * is an in-memory stand-in that applies stage writes the way
 * `updateStageWithLatest` does.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('storyboard-from-pipeline-');
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const issues = vi.hoisted(() => new Map());
vi.mock('../pipeline/issues.js', async () => {
  const { assertStageUnlocked } = await vi.importActual('../pipeline/issuesShared.js');
  return {
    assertStageUnlocked,
    getIssue: async (id) => {
      if (!issues.has(id)) throw Object.assign(new Error('Issue not found'), { status: 404 });
      return structuredClone(issues.get(id));
    },
    updateStageWithLatest: async (id, stageId, compute) => {
      const issue = issues.get(id);
      const patch = compute(issue.stages[stageId]);
      issue.stages[stageId] = { ...issue.stages[stageId], ...patch };
      return { issue, stage: issue.stages[stageId] };
    },
  };
});

const { default: storyboardRoutes } = await import('../../routes/storyboards.js');

const app = express();
app.use(express.json());
app.use('/api/storyboards', storyboardRoutes);
app.use(errorMiddleware);
afterAll(cleanupTempDataRoots);

const seed = (id, storyboards) => issues.set(id, { id, title: 'Example Issue', stages: { storyboards } });

describe('storyboard from a pipeline issue', () => {
  it('builds beats from scenes and panels from shots, reopens the same board, and sends a panel image to its shot', async () => {
    seed('iss-1', {
      scenes: [
        { id: 'scene-01', slugline: 'INT. LAB — NIGHT', description: 'The lab hums.', shots: [
          { id: 'shot-01', description: 'Wide of the lab', shotType: 'wide', durationSeconds: 5, startFrameFilename: 'lab.png' },
          { id: 'shot-02', description: 'Close on the dial', shotType: 'close', durationSeconds: 3 },
        ] },
        { id: 'scene-02', slugline: 'EXT. ROOF — DAWN', description: 'She looks out.', sketchKey: 'sketch:abc-123' },
      ],
    });

    const opened = await request(app).post('/api/storyboards/from-pipeline/iss-1');
    expect(opened.status).toBe(201);
    const board = (await request(app).get(`/api/storyboards/${opened.body.boardId}`)).body;
    expect(board).toMatchObject({ name: 'Example Issue', source: { kind: 'pipeline', issueId: 'iss-1' } });
    expect(board.beats.map((beat) => [beat.title, beat.panels.map((p) => [p.sourceSceneId, p.sourceShotId])])).toEqual([
      ['INT. LAB — NIGHT', [['scene-01', 'shot-01'], ['scene-01', 'shot-02']]],
      ['EXT. ROOF — DAWN', [['scene-02', null]]],
    ]);
    expect(board.beats[0].panels[0]).toMatchObject({
      action: 'Wide of the lab', framing: 'wide', seconds: 5, takes: [expect.objectContaining({ source: 'gallery', image: 'lab.png' })],
    });
    expect(board.beats[1].panels[0].takes).toEqual([expect.objectContaining({ source: 'sketch', sketchKey: 'sketch:abc-123' })]);

    const again = await request(app).post('/api/storyboards/from-pipeline/iss-1');
    expect([again.status, again.body]).toEqual([200, { boardId: board.id, created: false }]);

    const shotPanel = board.beats[0].panels[1].id;
    expect((await request(app).post(`/api/storyboards/${board.id}/panels/${shotPanel}/takes`).send({ source: 'generated', image: 'dial.png' })).status).toBe(201);
    issues.get('iss-1').stages.storyboards.locked = true;
    expect((await request(app).post(`/api/storyboards/${board.id}/panels/${shotPanel}/scene-art`)).status).toBe(400);
    issues.get('iss-1').stages.storyboards.locked = false;
    const sent = await request(app).post(`/api/storyboards/${board.id}/panels/${shotPanel}/scene-art`);
    expect(sent.status).toBe(200);
    expect(issues.get('iss-1').stages.storyboards.scenes[0].shots.map((s) => s.startFrameFilename)).toEqual(['lab.png', 'dial.png']);

    // A sketch is never sent as art.
    expect((await request(app).post(`/api/storyboards/${board.id}/panels/${board.beats[1].panels[0].id}/scene-art`)).body.code).toBe('NO_IMAGE');
  });

  it('refuses an issue with no storyboard scenes', async () => {
    seed('iss-empty', { scenes: [] });
    const res = await request(app).post('/api/storyboards/from-pipeline/iss-empty');
    expect([res.status, res.body.code]).toEqual([400, 'NO_SCENES']);
  });
});
