import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('music-video-story-test-');
vi.mock('../lib/paths.js', async (actual) => makePathsProxy(await actual(), { dataRoot: ROOT }));
vi.mock('../lib/fileUtils.js', async (actual) => makePathsProxy(await actual(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', async () => {
  const { EventEmitter } = await import('node:events');
  return { getSettings: vi.fn(async () => ({})), settingsEvents: new EventEmitter() };
});
vi.mock('../services/sharing/recordEvents.js', () => ({
  emitRecordUpdated: vi.fn(), emitRecordDeleted: vi.fn(), autoSubscribeRecordToAllPeers: vi.fn(async () => {}),
}));

const { default: storyRoutes } = await import('./musicVideoStory.js');
const projects = await import('../services/musicVideo/projects.js');
const boards = await import('../services/storyboards/index.js');
const { __setStoryDepsForTests } = await import('../services/musicVideo/story.js');
// Exercise the actual route handlers and validators without requiring a local
// listening socket; the file-backed project and storyboard stores remain real.
function request(router, operator = false) {
  const call = (method, url, body) => new Promise((resolveResult, reject) => {
    const match = url.match(/^\/api\/music-video\/([^/]+)\/story\/(context|summary|propose|apply|beats|art-guides)$/);
    const layer = router.stack.find((entry) => entry.route?.path === `/:id/story/${match?.[2]}` && entry.route.methods[method.toLowerCase()]);
    if (!match || !layer) return reject(new Error(`No ${method} route for ${url}`));
    const req = { params: { id: match[1] }, body, method, url, headers: {}, socket: { remoteAddress: '192.0.2.1' },
      ...(operator ? { portosAuthContext: { enabled: true, authenticated: true, method: 'session' } } : {}), app: { get: () => null } };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { resolveResult({ status: this.statusCode, body: data }); return this; } };
    layer.route.stack[0].handle(req, res, reject);
  });
  return {
    get: (url) => call('GET', url),
    put: (url) => ({ send: (body) => call('PUT', url, body) }),
    post: (url) => ({ send: (body) => call('POST', url, body) }),
  };
}
const app = storyRoutes;
afterAll(cleanupTempDataRoots);

const provider = { id: 'test-route', enabled: true, type: 'api' };
const resolve = vi.fn(async () => ({ provider, selectedModel: 'chosen-model' }));
const run = vi.fn(async () => ({ text: JSON.stringify({ reply: 'Here is a direction.', proposal: { concept: { prompt: 'A return home' } } }), model: 'chosen-model' }));
beforeEach(() => { vi.clearAllMocks(); __setStoryDepsForTests({ resolve, run }); });
const path = (id) => `/api/music-video/${id}/story`;
const context = async (id) => (await request(app).get(`${path(id)}/context`)).body;

async function fixture() {
  const project = await projects.createProject({ name: 'Story fixture', concept: { prompt: 'Original', style: 'Blue', songStyle: 'Synth', subjects: [
    { id: 'mvc-existing', kind: 'character', name: 'Ari', role: 'protagonist', description: 'A singer', canonId: 'canon-original', ingredientId: 'cat-original' },
  ] } });
  const board = await boards.createStoryboard({ name: 'Story fixture' });
  const { beatId } = await boards.addBeat(board.id, { title: 'First beat', what: 'Arrive' });
  const { panelId } = await boards.addPanel(board.id, beatId, { action: 'Walk in', castIds: ['cast-original'], notes: 'Keep this' });
  await boards.addPanelTake(board.id, panelId, { source: 'sketch', sketchKey: 'sketch:original' });
  await projects.mutateProjectRecord(project.id, (current) => ({ project: { ...current, storyboardId: board.id,
    scenes: [{ sceneId: 'mvs-original', order: 0, startSec: 0, endSec: 4, takes: [], prompt: 'Protected shot' }],
    productionReview: { storyboard: { approved: true }, shotLocks: { 'mvs-original': 'locked' } },
  } }));
  return { id: project.id, boardId: board.id, beatId, panelId };
}

describe('Music Video story review and apply', () => {
  it('persists rough notes separately and refuses to overwrite a newer summary', async () => {
    const { id } = await fixture();
    const saved = await request(app).put(`${path(id)}/summary`).send({ summary: 'Rough human notes\nwith a turn.', baseSummary: '' });
    expect(saved.status).toBe(200);
    expect(saved.body.project.storySummary).toBe('Rough human notes\nwith a turn.');
    expect(saved.body.project.concept.prompt).toBe('Original');
    const stale = await request(app).put(`${path(id)}/summary`).send({ summary: 'Old tab', baseSummary: '' });
    expect(stale.status).toBe(409);
    expect((await projects.getProject(id)).storySummary).toBe('Rough human notes\nwith a turn.');
  });

  it('previews without a model call, propagates the requested route, and keeps proposals read-only', async () => {
    const { id } = await fixture();
    await request(app).put(`${path(id)}/summary`).send({ summary: 'My rough plot', baseSummary: '' });
    const input = { providerId: 'test-route', model: 'chosen-model', effort: 'high', executionOptions: { serviceTier: 'fast' },
      messages: [{ role: 'user', content: 'Keep the ending hopeful' }] };
    const before = await projects.getProject(id);
    const preview = await request(app).post(`${path(id)}/propose`).send({ ...input, preview: true });
    expect(preview.status).toBe(200);
    expect(preview.body.sentPrompt).toContain('My rough plot');
    expect(preview.body.sentPrompt).toContain('Keep the ending hopeful');
    expect(run).not.toHaveBeenCalled();
    const result = await request(app).post(`${path(id)}/propose`).send(input);
    expect(result.status).toBe(200);
    expect(result.body.proposal.concept.prompt).toBe('A return home');
    expect(resolve).toHaveBeenCalledWith({ providerId: 'test-route', model: 'chosen-model' });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ provider, model: 'chosen-model', effort: 'high',
      executionOptions: { serviceTier: 'fast' }, allowFallback: false, toolFree: true }));
    expect(await projects.getProject(id)).toEqual(before);
    resolve.mockResolvedValueOnce({ provider: { id: 'different-provider', enabled: true }, selectedModel: 'other' });
    expect((await request(app).post(`${path(id)}/propose`).send(input)).status).toBe(400);
    expect(run).toHaveBeenCalledTimes(1);
    run.mockResolvedValueOnce({ text: '{"reply":"unfinished", "proposal":{"beats":[{"extra":"invalid"}]}}' });
    expect((await request(app).post(`${path(id)}/propose`).send(input)).status).toBe(502);
    expect(await projects.getProject(id)).toEqual(before);
  });

  it('requires server-derived host authority for tool-capable providers', async () => {
    const { id } = await fixture();
    const input = { providerId: 'test-route', messages: [{ role: 'user', content: 'Develop this story' }] };
    resolve.mockResolvedValue({ provider: { id: 'test-route', enabled: true, type: 'tui', command: 'codex' }, selectedModel: 'chosen-model' });
    const denied = await request(app).post(`${path(id)}/propose`).send(input);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    expect(run).not.toHaveBeenCalled();
    const authorized = await request(app, true).post(`${path(id)}/propose`).send(input);
    expect(authorized.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    expect((await request(app).post(`${path(id)}/propose`).send({ ...input, hasHostControl: true })).status).toBe(400);
  });

  it('applies only selected project fields, keeps identities and shots, and rejects stale or repeated proposals', async () => {
    const { id } = await fixture();
    const before = await projects.getProject(id);
    const initial = await context(id);
    const proposal = { concept: { prompt: 'A new arc' }, subjects: [
      { id: 'mvc-existing', kind: 'character', name: 'Ari', description: 'Returning home' },
      { kind: 'place', name: 'The station', description: 'A quiet platform' },
    ] };
    const applied = await request(app).post(`${path(id)}/apply`).send({ basis: initial.basis, proposal });
    expect(applied.status).toBe(200);
    expect(applied.body.project.concept).toMatchObject({ prompt: 'A new arc', style: 'Blue', songStyle: 'Synth' });
    expect(applied.body.project.concept.subjects).toEqual([
      expect.objectContaining({ id: 'mvc-existing', canonId: 'canon-original', ingredientId: 'cat-original', name: 'Ari', description: 'Returning home' }),
      expect.objectContaining({ name: 'The station', localOnly: true, id: expect.any(String) }),
    ]);
    expect(applied.body.project.scenes).toEqual(before.scenes);
    expect(applied.body.project.productionReview).toEqual(before.productionReview);
    expect((await request(app).post(`${path(id)}/apply`).send({ basis: initial.basis, proposal })).status).toBe(409);
    expect((await projects.getProject(id)).concept.subjects).toHaveLength(2);
    const latest = await context(id);
    await projects.updateProject(id, { concept: { style: 'Changed elsewhere' } });
    expect((await request(app).post(`${path(id)}/apply`).send({ basis: latest.basis, proposal: { concept: { style: 'Stale' } } })).status).toBe(409);
    expect((await projects.getProject(id)).concept.style).toBe('Changed elsewhere');
    expect((await request(app).post(`${path(id)}/apply`).send({ basis: latest.basis, proposal: { beats: [] } })).status).toBe(400);
    expect((await request(app).post(`${path(id)}/apply`).send({ basis: latest.basis, proposal: {} })).status).toBe(400);
  });

  it('updates only selected storyboard foundations and keeps panel takes, references and timed shots', async () => {
    const { id, boardId, beatId, panelId } = await fixture();
    const beforeProject = await projects.getProject(id);
    const beforeBoard = await boards.getStoryboard(boardId);
    const reviewed = await context(id);
    const beats = [{ id: beatId, what: 'A different arrival', panels: [{ id: panelId, action: 'She opens the door' }] },
      { title: 'A new beat', panels: [{ action: 'The lights come on' }] }];
    const applied = await request(app).post(`${path(id)}/beats`).send({ boardId, boardBasis: reviewed.board.basis, basis: reviewed.basis, beats });
    expect(applied.status).toBe(200);
    expect(applied.body.board.beats[0]).toMatchObject({ id: beatId, what: 'A different arrival' });
    expect(applied.body.board.beats[0].panels[0]).toMatchObject({ id: panelId, action: 'She opens the door',
      takes: beforeBoard.beats[0].panels[0].takes, castIds: ['cast-original'], notes: 'Keep this' });
    expect(applied.body.board.beats).toHaveLength(2);
    expect(await projects.getProject(id)).toEqual(beforeProject);
    expect((await request(app).post(`${path(id)}/beats`).send({ boardId, boardBasis: reviewed.board.basis, basis: reviewed.basis, beats })).status).toBe(409);
    expect((await boards.getStoryboard(boardId)).beats).toHaveLength(2);
    const latest = await context(id);
    const invalid = await request(app).post(`${path(id)}/beats`).send({ boardId, boardBasis: latest.board.basis, basis: latest.basis,
      beats: [{ id: beatId, what: 'Do not write', panels: [{ id: 'panel-missing', action: 'No' }] }] });
    expect(invalid.status).toBe(409);
    expect((await boards.getStoryboard(boardId)).beats[0].what).toBe('A different arrival');
    await projects.updateProject(id, { concept: { prompt: 'Changed on another tab' } });
    const staleStory = await request(app).post(`${path(id)}/beats`).send({ boardId, boardBasis: latest.board.basis, basis: latest.basis, beats });
    expect(staleStory.status).toBe(409);
    expect((await boards.getStoryboard(boardId)).beats).toHaveLength(2);
  });
});

describe('Music Video art guides from the story', () => {
  it('previews the exact prompt, refuses without a story, and returns guides without saving them', async () => {
    const { id } = await fixture();
    const input = { providerId: 'test-route', model: 'chosen-model' };
    expect((await request(app).post(`${path(id)}/art-guides`).send(input)).status).toBe(409);
    await request(app).put(`${path(id)}/summary`).send({ summary: 'Ari at 7 and at 30, the old rink at night.', baseSummary: '' });
    const preview = await request(app).post(`${path(id)}/art-guides`).send({ ...input, preview: true });
    expect(preview.status).toBe(200);
    expect(run).not.toHaveBeenCalled();
    expect(preview.body.promptAdditions.map((a) => a.id)).toEqual(['creative-latitude', 'art-guide-instructions', 'story', 'project']);
    expect(preview.body.sentPrompt).toContain('Story in your own words:\nAri at 7 and at 30, the old rink at night.');
    run.mockResolvedValueOnce({ text: JSON.stringify({ cast: 'Ari, 30: tired eyes. Ari, 7: pigtails.', environments: 'The rink, empty, at night.', visualLanguage: 'Warm tungsten, 16mm grain.' }) });
    const drafted = await request(app, true).post(`${path(id)}/art-guides`).send(input);
    expect(drafted.status).toBe(200);
    expect(drafted.body.proposal).toEqual({ cast: 'Ari, 30: tired eyes. Ari, 7: pigtails.', environments: 'The rink, empty, at night.', visualLanguage: 'Warm tungsten, 16mm grain.' });
    expect(run.mock.calls[0][0].prompt).toBe(preview.body.sentPrompt);
    expect((await projects.getProject(id)).productionReview?.draft?.cast).toBeFalsy();
  });
});
