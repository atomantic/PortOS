/**
 * Route → Zod → service → store round trip for the cast-integrity endpoints (#6415).
 *
 * Only the PROVIDER boundary is stubbed (`runPromptRefineRaw` /
 * `resolveStageContext`) — everything else is the real router, the real
 * schemas, the real merge and the real contract. `updateUniverse` is a faithful
 * stand-in that actually applies the mutator against a mutable universe, so the
 * inside-the-write-queue lock / staleness re-checks are genuinely exercised
 * rather than asserted against a mock's arguments.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';

let universe;

const getUniverseMock = vi.fn(async () => universe);
// Mirrors the real contract: the mutator receives the FRESHEST record and
// returns either a patch or null (no write).
const updateUniverseMock = vi.fn(async (_id, mutate) => {
  const patch = mutate(universe);
  if (!patch) return null;
  universe = { ...universe, ...patch };
  return universe;
});
vi.mock('../../services/universeBuilder.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUniverse: (...args) => getUniverseMock(...args),
  updateUniverse: (...args) => updateUniverseMock(...args),
}));

const refineRawMock = vi.fn();
vi.mock('../../services/pipeline/refineHelpers.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runPromptRefineRaw: (...args) => refineRawMock(...args),
}));

const resolveStageContextMock = vi.fn(async () => ({
  provider: { id: 'prov-1', name: 'Local Llama' },
  model: 'llama-3.3',
  contextWindow: 32000,
}));
vi.mock('../../services/stageRunner.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveStageContext: (...args) => resolveStageContextMock(...args),
}));

const { default: universeBuilderRoutes } = await import('./index.js');

const makeApp = () => {
  const app = express();
  app.use(express.json({ limit: '55mb' }));
  app.use('/api/universe-builder', universeBuilderRoutes);
  app.use(errorMiddleware);
  return app;
};

const lead = () => ({
  id: 'c-lead',
  name: 'Wren',
  role: 'protagonist',
  motivations: 'Wants the survey contract renewed.',
  ghost: 'Her crew drowned on a run she planned.',
  wound: 'She no longer trusts her judgment under pressure.',
  lie: 'If I hold the chart, nobody else dies.',
  want: 'Sole command of the northern survey.',
  need: 'Shared command is not the same as being replaceable.',
  psychology: {
    theoryOfControl: 'If I carry every decision, the cost lands on me.',
    strategy: 'Takes the night watch alone.',
    protectiveBenefit: 'She never watches somebody else make the fatal call.',
    presentCost: 'Nobody on her crew can navigate without her.',
    testingPressure: 'A run she cannot take herself.',
    candidateChange: 'Letting a second navigator sign the chart.',
    assessment: 'assessed',
    assessmentNote: '',
    drives: {
      survival: { desire: 'A steady berth.', fear: 'Being put ashore.' },
      connection: { desire: 'A crew that stays.', fear: 'Being why one leaves.' },
      status: { desire: 'To be the name asked for.', fear: 'Being read as lucky.' },
    },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveStageContextMock.mockResolvedValue({
    provider: { id: 'prov-1', name: 'Local Llama' }, model: 'llama-3.3', contextWindow: 32000,
  });
  universe = {
    id: 'u-1',
    characters: [lead(), { id: 'c-2', name: 'Dockhand', role: 'minor' }],
    places: [],
    objects: [],
  };
});

describe('GET /:id/characters/integrity — the deterministic pass', () => {
  it('reports the free completeness pass and spends NOTHING on a provider', async () => {
    const res = await request(makeApp()).get('/api/universe-builder/u-1/characters/integrity');
    expect(res.status).toBe(200);
    expect(refineRawMock).not.toHaveBeenCalled();
    expect(res.body.castCount).toBe(2);
    expect(res.body.coverage.map((c) => c.characterId)).toEqual(['c-lead', 'c-2']);
    // Blank-complete is not a semantic pass.
    expect(res.body.semanticReviewedCount).toBe(0);
  });

  it('names the provider, model and batch size a review WOULD spend', async () => {
    const res = await request(makeApp()).get('/api/universe-builder/u-1/characters/integrity');
    expect(res.body.reviewScope).toMatchObject({
      providerId: 'prov-1', providerName: 'Local Llama', model: 'llama-3.3', characterCount: 2,
    });
  });

  it('still renders the report when no provider can be resolved', async () => {
    resolveStageContextMock.mockRejectedValue(new Error('no provider configured'));
    const res = await request(makeApp()).get('/api/universe-builder/u-1/characters/integrity');
    expect(res.status).toBe(200);
    expect(res.body.reviewScope.providerId).toBeNull();
    expect(res.body.coverage).toHaveLength(2);
  });

  it('lists characters outside an explicit scope as not-reviewed, never omitted', async () => {
    const res = await request(makeApp())
      .get('/api/universe-builder/u-1/characters/integrity?characterIds=c-lead');
    expect(res.body.coverage.find((c) => c.characterId === 'c-2').status).toBe('not-reviewed');
    expect(res.body.reviewedCount).toBe(1);
  });

  it('holds the minor role to lighter requirements', async () => {
    const res = await request(makeApp()).get('/api/universe-builder/u-1/characters/integrity');
    const dockhand = res.body.coverage.find((c) => c.characterId === 'c-2');
    expect(dockhand.depth).toBe('light');
    const fields = res.body.findings.filter((f) => f.characterId === 'c-2').map((f) => f.field);
    expect(fields).toEqual(['motivations', 'want']);
  });
});

describe('POST /:id/characters/integrity/review — the semantic pass', () => {
  const reviewResponse = (findings) => ({
    content: { findings }, rationale: 'ok', runId: 'run-1', providerId: 'prov-1', model: 'llama-3.3',
  });

  it('merges a well-formed finding and marks the character reviewed', async () => {
    refineRawMock.mockResolvedValue(reviewResponse([{
      characterId: 'c-lead',
      field: 'psychology.drives.status.fear',
      kind: 'underspecified',
      dimension: 'drives-specific',
      evidence: 'The status fear restates the survival fear.',
      suggestion: 'Name the specific standing she loses.',
    }]));
    const res = await request(makeApp())
      .post('/api/universe-builder/u-1/characters/integrity/review').send({});
    expect(res.status).toBe(200);
    const lead = res.body.coverage.find((c) => c.characterId === 'c-lead');
    expect(lead.status).toBe('findings');
    expect(lead.semanticReviewed).toBe(true);
    expect(res.body.findings.some((f) => f.field === 'psychology.drives.status.fear')).toBe(true);
  });

  it('drops a finding that names a character outside the cast', async () => {
    refineRawMock.mockResolvedValue(reviewResponse([{
      characterId: 'c-does-not-exist', field: 'lie', kind: 'contradictory', evidence: 'x',
    }]));
    const res = await request(makeApp())
      .post('/api/universe-builder/u-1/characters/integrity/review').send({});
    expect(res.body.findings.some((f) => f.characterId === 'c-does-not-exist')).toBe(false);
  });

  it('drops a finding on a field path outside the contract', async () => {
    refineRawMock.mockResolvedValue(reviewResponse([{
      characterId: 'c-lead', field: 'physicalDescription', kind: 'underspecified', evidence: 'x',
    }]));
    const res = await request(makeApp())
      .post('/api/universe-builder/u-1/characters/integrity/review').send({});
    expect(res.body.findings.some((f) => f.field === 'physicalDescription')).toBe(false);
  });

  it('400s on an empty explicit selection rather than reviewing the whole cast', async () => {
    const res = await request(makeApp())
      .post('/api/universe-builder/u-1/characters/integrity/review').send({ characterIds: [] });
    expect(res.status).toBe(400);
    expect(refineRawMock).not.toHaveBeenCalled();
  });

  it('sends the model only the characters in scope', async () => {
    refineRawMock.mockResolvedValue(reviewResponse([]));
    await request(makeApp())
      .post('/api/universe-builder/u-1/characters/integrity/review').send({ characterIds: ['c-2'] });
    const cast = JSON.parse(refineRawMock.mock.calls[0][0].variables.castJson);
    expect(cast.map((c) => c.id)).toEqual(['c-2']);
  });
});

describe('POST /:id/characters/:entryId/augment — propose', () => {
  const proposalResponse = (proposals) => ({
    content: { proposals }, rationale: 'ok', runId: 'run-2', providerId: 'prov-1', model: 'llama-3.3',
  });

  it('returns before/after and writes NOTHING', async () => {
    refineRawMock.mockResolvedValue(proposalResponse([
      { field: 'lie', value: 'If I am the only one who signs the chart, no one else carries a death.', rationale: 'names the act' },
    ]));
    const res = await request(makeApp())
      .post('/api/universe-builder/u-1/characters/c-lead/augment').send({ fields: ['lie'] });
    expect(res.status).toBe(200);
    expect(res.body.proposals[0]).toMatchObject({ field: 'lie', before: 'If I hold the chart, nobody else dies.' });
    expect(res.body.fingerprint).toEqual(expect.any(String));
    expect(updateUniverseMock).not.toHaveBeenCalled();
    expect(universe.characters[0].lie).toBe('If I hold the chart, nobody else dies.');
  });

  it('drops a proposal for a field the user did not request', async () => {
    refineRawMock.mockResolvedValue(proposalResponse([
      { field: 'lie', value: 'sharper lie' },
      { field: 'want', value: 'an unrequested rewrite' },
    ]));
    const res = await request(makeApp())
      .post('/api/universe-builder/u-1/characters/c-lead/augment').send({ fields: ['lie'] });
    expect(res.body.proposals.map((p) => p.field)).toEqual(['lie']);
  });

  it('drops a proposal identical to the current value', async () => {
    refineRawMock.mockResolvedValue(proposalResponse([
      { field: 'lie', value: 'If I hold the chart, nobody else dies.' },
    ]));
    const res = await request(makeApp())
      .post('/api/universe-builder/u-1/characters/c-lead/augment').send({ fields: ['lie'] });
    expect(res.body.proposals).toEqual([]);
  });

  it('rejects a field path outside the contract at the schema, before any call', async () => {
    const res = await request(makeApp())
      .post('/api/universe-builder/u-1/characters/c-lead/augment').send({ fields: ['physicalDescription'] });
    expect(res.status).toBe(400);
    expect(refineRawMock).not.toHaveBeenCalled();
  });

  it('skips the provider entirely for a locked character', async () => {
    universe.characters[0].locked = true;
    const res = await request(makeApp())
      .post('/api/universe-builder/u-1/characters/c-lead/augment').send({ fields: ['lie'] });
    expect(res.body.locked).toBe(true);
    expect(refineRawMock).not.toHaveBeenCalled();
  });

  it('404s on a character that is not in the universe', async () => {
    const res = await request(makeApp())
      .post('/api/universe-builder/u-1/characters/c-ghost/augment').send({ fields: ['lie'] });
    expect(res.status).toBe(404);
  });
});

describe('POST /:id/characters/:entryId/augment/apply — selective apply', () => {
  // The fingerprint comes from a real propose call, which is the only way a
  // client ever obtains one.
  const fingerprintFor = async (id = 'c-lead') => {
    refineRawMock.mockResolvedValue({
      content: { proposals: [{ field: 'lie', value: 'A sharper lie.' }] },
      rationale: '', runId: 'run-3', providerId: 'prov-1', model: 'llama-3.3',
    });
    const res = await request(makeApp())
      .post(`/api/universe-builder/u-1/characters/${id}/augment`).send({ fields: ['lie'] });
    return res.body.fingerprint;
  };

  it('applies ONLY the selected field and leaves the rest untouched', async () => {
    const fingerprint = await fingerprintFor();
    const res = await request(makeApp())
      .post('/api/universe-builder/u-1/characters/c-lead/augment/apply')
      .send({ fields: [{ field: 'lie', value: 'A sharper lie.' }], fingerprint });
    expect(res.status).toBe(200);
    expect(res.body.appliedFields).toEqual(['lie']);
    expect(universe.characters[0].lie).toBe('A sharper lie.');
    expect(universe.characters[0].want).toBe('Sole command of the northern survey.');
  });

  it('writes a psychology leaf without dropping its siblings', async () => {
    const fingerprint = await fingerprintFor();
    await request(makeApp())
      .post('/api/universe-builder/u-1/characters/c-lead/augment/apply')
      .send({ fields: [{ field: 'psychology.drives.status.fear', value: 'Being thanked instead of hired.' }], fingerprint });
    const { psychology } = universe.characters[0];
    expect(psychology.drives.status.fear).toBe('Being thanked instead of hired.');
    expect(psychology.drives.status.desire).toBe('To be the name asked for.');
    expect(psychology.theoryOfControl).toBe('If I carry every decision, the cost lands on me.');
  });

  it('409s instead of clobbering a character edited since the proposal', async () => {
    const fingerprint = await fingerprintFor();
    universe.characters[0].lie = 'the author rewrote this by hand';
    const res = await request(makeApp())
      .post('/api/universe-builder/u-1/characters/c-lead/augment/apply')
      .send({ fields: [{ field: 'lie', value: 'the model version' }], fingerprint });
    expect(res.status).toBe(409);
    expect(universe.characters[0].lie).toBe('the author rewrote this by hand');
  });

  it('does not go stale on an edit to an UNRELATED field', async () => {
    const fingerprint = await fingerprintFor();
    universe.characters[0].physicalDescription = 'a newly rendered description';
    const res = await request(makeApp())
      .post('/api/universe-builder/u-1/characters/c-lead/augment/apply')
      .send({ fields: [{ field: 'lie', value: 'A sharper lie.' }], fingerprint });
    expect(res.status).toBe(200);
  });

  it('refuses a character locked between the proposal and the apply', async () => {
    const fingerprint = await fingerprintFor();
    universe.characters[0].locked = true;
    const res = await request(makeApp())
      .post('/api/universe-builder/u-1/characters/c-lead/augment/apply')
      .send({ fields: [{ field: 'lie', value: 'A sharper lie.' }], fingerprint });
    expect(res.body.locked).toBe(true);
    expect(universe.characters[0].lie).toBe('If I hold the chart, nobody else dies.');
  });

  it('404s when the character was deleted between the proposal and the apply', async () => {
    const fingerprint = await fingerprintFor();
    universe.characters = universe.characters.filter((c) => c.id !== 'c-lead');
    const res = await request(makeApp())
      .post('/api/universe-builder/u-1/characters/c-lead/augment/apply')
      .send({ fields: [{ field: 'lie', value: 'A sharper lie.' }], fingerprint });
    expect(res.status).toBe(404);
  });

  it('rejects an out-of-contract field path at the schema', async () => {
    const res = await request(makeApp())
      .post('/api/universe-builder/u-1/characters/c-lead/augment/apply')
      .send({ fields: [{ field: 'wardrobes', value: 'x' }] });
    expect(res.status).toBe(400);
    expect(updateUniverseMock).not.toHaveBeenCalled();
  });
});
