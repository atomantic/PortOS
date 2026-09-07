/**
 * Route → Zod → service → store round trip for Writers Room cast augmentation
 * (#6417).
 *
 * Only the PROVIDER boundary is stubbed (`runPromptRefineRaw`) — the router,
 * the shared schemas, `characterAugmentation.js` and the real per-work bible
 * store all run, against a temp data root. That is what makes the load-bearing
 * assertions meaningful: "propose writes nothing" and "apply persists only the
 * ticked field" are both claims about the store, and a mocked store would let a
 * dropped `editableFields` entry pass silently.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
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

const refineRawMock = vi.fn();
vi.mock('../services/pipeline/refineHelpers.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runPromptRefineRaw: (...args) => refineRawMock(...args),
}));

// Everything else on the router that would reach a provider, Postgres, or a PTY.
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
const { createCharacter, getCharacter, updateCharacter } = await import('../services/writersRoom/characters.js');

const app = express();
app.use(express.json());
app.use('/api/writers-room', writersRoomRouter);
app.use(errorMiddleware);

beforeEach(() => {
  vi.clearAllMocks();
  tempRoot = mkdtempSync(join(tmpdir(), 'wr-cast-augment-'));
});
afterEach(() => {
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

const LEAD = {
  name: 'Wren',
  role: 'protagonist',
  lie: 'If I hold the chart, nobody else dies.',
  want: 'Sole command of the northern survey.',
  psychology: {
    theoryOfControl: 'If I carry every decision, the cost lands on me.',
    assessment: 'assessed',
    drives: {
      survival: { desire: 'A steady berth.', fear: 'Being put ashore.' },
      status: { desire: 'To be the name asked for.', fear: 'Being read as lucky.' },
    },
  },
};

/** A work with a two-character bible; returns the base path plus both ids. */
async function seed() {
  const work = await createWork({ title: 'Example Work', kind: 'short-story' });
  const lead = await createCharacter(work.id, LEAD);
  const peer = await createCharacter(work.id, { name: 'Dockhand', role: 'minor' });
  return { workId: work.id, leadId: lead.id, peerId: peer.id, base: `/api/writers-room/works/${work.id}/characters` };
}

/**
 * Set the canon lock bit directly in the persisted bible.
 *
 * Writers Room has no lock toggle of its own — a locked entry gets here by
 * arriving already locked (a peer-synced work, a merged extraction), which
 * `sanitizeCharacter` round-trips. So the guard is real, and the only honest
 * way to set up the fixture is to write the record the way it would arrive.
 */
function lockInStore(workId, characterId) {
  const path = join(tempRoot, 'writers-room', 'works', workId, 'characters.json');
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  doc.characters = doc.characters.map((c) => (c.id === characterId ? { ...c, locked: true } : c));
  writeFileSync(path, JSON.stringify(doc, null, 2));
}

const proposalResponse = (proposals) => ({
  content: { proposals }, rationale: 'ok', runId: 'run-1', providerId: 'prov-1', model: 'test-model',
});

/** The fingerprint a client can only ever obtain from a real propose call. */
async function fingerprintFor(base, characterId) {
  refineRawMock.mockResolvedValue(proposalResponse([{ field: 'lie', value: 'A sharper lie.' }]));
  const res = await request(app).post(`${base}/${characterId}/augment`).send({ fields: ['lie'] });
  return res.body.fingerprint;
}

describe('POST /works/:id/characters/:characterId/augment — propose', () => {
  it('returns before/after and writes NOTHING to the bible', async () => {
    const { workId, leadId, base } = await seed();
    refineRawMock.mockResolvedValue(proposalResponse([
      { field: 'lie', value: 'If I am the only one who signs the chart, no one else carries a death.', rationale: 'names the act' },
    ]));
    const res = await request(app).post(`${base}/${leadId}/augment`).send({ fields: ['lie'] });
    expect(res.status).toBe(200);
    expect(res.body.proposals[0]).toMatchObject({ field: 'lie', before: LEAD.lie });
    expect(res.body.fingerprint).toEqual(expect.any(String));
    expect((await getCharacter(workId, leadId)).lie).toBe(LEAD.lie);
  });

  it('sends the SIBLING cast as peers, so the model keeps this work self-contained', async () => {
    const { leadId, base } = await seed();
    refineRawMock.mockResolvedValue(proposalResponse([]));
    await request(app).post(`${base}/${leadId}/augment`).send({ fields: ['lie'] });
    const peers = JSON.parse(refineRawMock.mock.calls[0][0].variables.peersJson);
    expect(peers.map((p) => p.name)).toEqual(['Dockhand']);
  });

  it('drops a proposal for a field the user did not request', async () => {
    const { leadId, base } = await seed();
    refineRawMock.mockResolvedValue(proposalResponse([
      { field: 'lie', value: 'sharper lie' },
      { field: 'want', value: 'an unrequested rewrite' },
    ]));
    const res = await request(app).post(`${base}/${leadId}/augment`).send({ fields: ['lie'] });
    expect(res.body.proposals.map((p) => p.field)).toEqual(['lie']);
  });

  it('rejects a field path outside the contract at the schema, before any call', async () => {
    const { leadId, base } = await seed();
    const res = await request(app).post(`${base}/${leadId}/augment`).send({ fields: ['physicalDescription'] });
    expect(res.status).toBe(400);
    expect(refineRawMock).not.toHaveBeenCalled();
  });

  it('skips the provider entirely for a locked character', async () => {
    const { workId, leadId, base } = await seed();
    lockInStore(workId, leadId);
    const res = await request(app).post(`${base}/${leadId}/augment`).send({ fields: ['lie'] });
    expect(res.body.locked).toBe(true);
    expect(refineRawMock).not.toHaveBeenCalled();
  });

  it('404s on a character that is not in this work', async () => {
    const { base } = await seed();
    const res = await request(app).post(`${base}/wr-char-00000000-0000-0000-0000-000000000000/augment`).send({ fields: ['lie'] });
    expect(res.status).toBe(404);
    expect(refineRawMock).not.toHaveBeenCalled();
  });
});

describe('POST /works/:id/characters/:characterId/augment/apply — selective apply', () => {
  it('applies ONLY the selected field and leaves the rest untouched', async () => {
    const { workId, leadId, base } = await seed();
    const fingerprint = await fingerprintFor(base, leadId);
    const res = await request(app).post(`${base}/${leadId}/augment/apply`)
      .send({ fields: [{ field: 'lie', value: 'A sharper lie.' }], fingerprint });
    expect(res.status).toBe(200);
    expect(res.body.appliedFields).toEqual(['lie']);
    const stored = await getCharacter(workId, leadId);
    expect(stored.lie).toBe('A sharper lie.');
    expect(stored.want).toBe(LEAD.want);
  });

  it('writes a psychology leaf without dropping its siblings', async () => {
    const { workId, leadId, base } = await seed();
    const fingerprint = await fingerprintFor(base, leadId);
    await request(app).post(`${base}/${leadId}/augment/apply`)
      .send({ fields: [{ field: 'psychology.drives.status.fear', value: 'Being thanked instead of hired.' }], fingerprint });
    const { psychology } = await getCharacter(workId, leadId);
    expect(psychology.drives.status.fear).toBe('Being thanked instead of hired.');
    expect(psychology.drives.status.desire).toBe(LEAD.psychology.drives.status.desire);
    expect(psychology.theoryOfControl).toBe(LEAD.psychology.theoryOfControl);
  });

  it('409s instead of clobbering a character edited since the proposal', async () => {
    const { workId, leadId, base } = await seed();
    const fingerprint = await fingerprintFor(base, leadId);
    await updateCharacter(workId, leadId, { lie: 'the author rewrote this by hand' });
    const res = await request(app).post(`${base}/${leadId}/augment/apply`)
      .send({ fields: [{ field: 'lie', value: 'the model version' }], fingerprint });
    expect(res.status).toBe(409);
    expect((await getCharacter(workId, leadId)).lie).toBe('the author rewrote this by hand');
  });

  it('does not go stale on an edit to an UNRELATED field', async () => {
    const { workId, leadId, base } = await seed();
    const fingerprint = await fingerprintFor(base, leadId);
    await updateCharacter(workId, leadId, { physicalDescription: 'a newly written description' });
    const res = await request(app).post(`${base}/${leadId}/augment/apply`)
      .send({ fields: [{ field: 'lie', value: 'A sharper lie.' }], fingerprint });
    expect(res.status).toBe(200);
  });

  it('refuses a character locked between the proposal and the apply', async () => {
    const { workId, leadId, base } = await seed();
    const fingerprint = await fingerprintFor(base, leadId);
    lockInStore(workId, leadId);
    const res = await request(app).post(`${base}/${leadId}/augment/apply`)
      .send({ fields: [{ field: 'lie', value: 'A sharper lie.' }], fingerprint });
    expect(res.body.locked).toBe(true);
    expect((await getCharacter(workId, leadId)).lie).toBe(LEAD.lie);
  });

  it('rejects an out-of-contract field path at the schema', async () => {
    const { workId, leadId, base } = await seed();
    const res = await request(app).post(`${base}/${leadId}/augment/apply`)
      .send({ fields: [{ field: 'wardrobes', value: 'x' }] });
    expect(res.status).toBe(400);
    expect((await getCharacter(workId, leadId)).lie).toBe(LEAD.lie);
  });
});
