/**
 * Route → store round trip for the Writers Room character framework (#6417).
 *
 * Deliberately NOT mocked at the service boundary the way `writersRoom.test.js`
 * is: the regression this catches is the schema and the store disagreeing about
 * which fields exist — a payload the Zod schema accepts and `createBibleStore`
 * then drops on the floor. Only a real request through the real store proves
 * the two halves line up, so `characters.js` / `local.js` run for real against
 * a temp data root and everything else on the router is stubbed out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

let tempRoot;

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => tempRoot });
});

// Everything on the router that would reach a provider, Postgres, or a PTY.
vi.mock('../services/writersRoom/evaluator.js', () => ({
  runAnalysis: vi.fn(),
  listAnalyses: vi.fn(async () => []),
  getAnalysis: vi.fn(),
  persistSceneImage: vi.fn(),
}));
vi.mock('../services/writersRoom/polish.js', () => ({
  startPolish: vi.fn(), attachClient: vi.fn(), cancelPolish: vi.fn(),
  isPolishActive: vi.fn(() => false), listSnapshots: vi.fn(async () => []),
  getSnapshot: vi.fn(), revertToSnapshot: vi.fn(),
}));
vi.mock('../services/writersRoom/syncedReview.js', () => ({ getSyncedReview: vi.fn() }));
vi.mock('../services/writersRoom/liveDirector.js', () => ({
  suggestContinuation: vi.fn(), reserveRenderPreview: vi.fn(),
  suggestCdBridge: vi.fn(), sendToCreativeDirector: vi.fn(),
}));
vi.mock('../services/writersRoom/promoteToPipeline.js', () => ({
  promoteWorkToPipeline: vi.fn(), ERR_NO_DRAFT_BODY: 'WR_PROMOTE_NO_DRAFT_BODY',
}));
vi.mock('../services/catalogExtraction.js', () => ({
  scanProseForIngredientRefs: vi.fn(async () => []),
}));

const { default: writersRoomRouter } = await import('./writersRoom.js');
const { createWork } = await import('../services/writersRoom/local.js');

const app = express();
app.use(express.json());
app.use('/api/writers-room', writersRoomRouter);
app.use(errorMiddleware);

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'wr-char-framework-'));
});
afterEach(() => {
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

const FRAMEWORK = {
  motivations: 'Keep the crew fed; never be the one who leaves.',
  ghost: 'Left behind at the relay station at nine.',
  wound: 'Reads every silence as abandonment.',
  lie: 'I only matter while I am useful.',
  need: 'Being wanted is not the same as being needed.',
  want: 'Buy back the family salvage license.',
  arcType: 'positive',
  secrets: ['Sold the license years ago'],
};

describe('writers room character routes — narrative framework', () => {
  it('creates, patches, clears and reads back the framework', async () => {
    const work = await createWork({ title: 'Example Work', kind: 'short-story' });
    const base = `/api/writers-room/works/${work.id}/characters`;

    const created = await request(app).post(base).send({ name: 'Wren Calloway', ...FRAMEWORK });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject(FRAMEWORK);
    const charId = created.body.id;

    const patched = await request(app).patch(`${base}/${charId}`).send({ need: 'Being wanted is enough.' });
    expect(patched.status).toBe(200);
    expect(patched.body.need).toBe('Being wanted is enough.');
    expect(patched.body.ghost).toBe(FRAMEWORK.ghost);

    const cleared = await request(app).patch(`${base}/${charId}`).send({ lie: '', arcType: null, secrets: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.lie).toBe('');
    expect(cleared.body.arcType).toBeNull();
    expect(cleared.body.secrets).toEqual([]);

    const listed = await request(app).get(base);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({
      want: FRAMEWORK.want, lie: '', arcType: null, secrets: [],
      need: 'Being wanted is enough.',
    });
  });

  it('rejects invalid framework shapes instead of silently coercing them', async () => {
    const work = await createWork({ title: 'Example Work', kind: 'short-story' });
    const base = `/api/writers-room/works/${work.id}/characters`;

    const badArc = await request(app).post(base).send({ name: 'Ines Mbeki', arcType: 'redemption' });
    expect(badArc.status).toBe(400);

    const badSecrets = await request(app).post(base).send({ name: 'Ines Mbeki', secrets: 'a single string' });
    expect(badSecrets.status).toBe(400);

    const unknownField = await request(app).post(base).send({ name: 'Ines Mbeki', theoryOfControl: 'not in this slice' });
    expect(unknownField.status).toBe(400);

    expect((await request(app).get(base)).body).toEqual([]);
  });
});
