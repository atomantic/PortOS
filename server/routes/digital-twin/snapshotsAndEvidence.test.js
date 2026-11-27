import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { request } from '../../lib/testHelper.js';
import * as twin from '../../services/digital-twin.js';
import * as timeCapsule from '../../services/timeCapsule.js';
import * as evidence from '../../services/twinEnrichment.js';
import avatarBioRoutes from './avatar-bio.js';
import evidenceRoutes from './evidence.js';
import snapshotRoutes from './snapshots.js';

vi.mock('../../services/digital-twin.js', () => ({
  buildAvatarBio: vi.fn(),
  polishAvatarBio: vi.fn(),
}));
vi.mock('../../services/timeCapsule.js', () => ({
  listSnapshots: vi.fn(),
  createSnapshot: vi.fn(),
  getSnapshot: vi.fn(),
  deleteSnapshot: vi.fn(),
  compareSnapshots: vi.fn(),
}));
vi.mock('../../services/twinEnrichment.js', () => ({
  getObservedEvidence: vi.fn(),
  aggregateTwinEvidence: vi.fn(),
  interpretConsumption: vi.fn(),
}));

const base = '/api/digital-twin';
const app = express();
app.use(express.json());
app.use(base, snapshotRoutes, evidenceRoutes, avatarBioRoutes);
app.use(errorMiddleware);

beforeEach(() => vi.resetAllMocks());

const id1 = '00000000-0000-4000-8000-000000000001';
const id2 = '00000000-0000-4000-8000-000000000002';
const snapshot = { id: id1, label: 'Example snapshot', description: '' };
const picker = { providerId: 'example-provider', model: 'example-model' };

describe('Digital Twin snapshots', () => {
  it('lists snapshots', async () => {
    timeCapsule.listSnapshots.mockResolvedValueOnce([snapshot]);
    const response = await request(app).get(base + '/snapshots');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([snapshot]);
  });

  it('returns 201 for a new snapshot and defaults the description', async () => {
    timeCapsule.createSnapshot.mockResolvedValueOnce(snapshot);
    const response = await request(app).post(base + '/snapshots').send({ label: snapshot.label });
    expect(response.status).toBe(201);
    expect(response.body).toEqual(snapshot);
    expect(timeCapsule.createSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot.label, '');
  });

  it.each([
    { path: '/snapshots', input: { label: '' }, service: timeCapsule.createSnapshot },
    { path: '/snapshots/compare', input: { id1, id2: 'invalid-id' }, service: timeCapsule.compareSnapshots },
  ])('POST $path rejects invalid input before calling the service', async ({ path, input, service }) => {
    const response = await request(app).post(base + path).send(input);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(service).not.toHaveBeenCalled();
  });

  const idOperations = [
    { method: 'get', service: timeCapsule.getSnapshot, found: snapshot, missing: null, body: snapshot },
    { method: 'delete', service: timeCapsule.deleteSnapshot, found: true, missing: false, body: { success: true } },
  ];

  it.each(idOperations)('$method /snapshots/:id rejects malformed IDs before calling the service', async ({ method, service }) => {
    const response = await request(app)[method](base + '/snapshots/invalid-id');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'BAD_REQUEST', error: 'Invalid snapshot ID' });
    expect(service).not.toHaveBeenCalled();
  });

  it.each(idOperations)('$method /snapshots/:id returns NOT_FOUND for a missing snapshot', async ({ method, service, missing }) => {
    service.mockResolvedValueOnce(missing);
    const response = await request(app)[method](base + '/snapshots/' + id1);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
    expect(service).toHaveBeenCalledExactlyOnceWith(id1);
  });

  it.each(idOperations)('$method /snapshots/:id returns a successful response', async ({ method, service, found, body }) => {
    service.mockResolvedValueOnce(found);
    const response = await request(app)[method](base + '/snapshots/' + id1);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(body);
    expect(service).toHaveBeenCalledExactlyOnceWith(id1);
  });

  it('compares the requested snapshots in order', async () => {
    const diff = {
      snapshot1: { id: id1, label: 'Example baseline' },
      snapshot2: { id: id2, label: 'Example follow-up' },
      changes: [],
    };
    timeCapsule.compareSnapshots.mockResolvedValueOnce(diff);
    const response = await request(app).post(base + '/snapshots/compare').send({ id1, id2 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(diff);
    expect(timeCapsule.compareSnapshots).toHaveBeenCalledExactlyOnceWith(id1, id2);
  });

  it('returns NOT_FOUND when a comparison input is missing from storage', async () => {
    timeCapsule.compareSnapshots.mockResolvedValueOnce(null);
    const response = await request(app).post(base + '/snapshots/compare').send({ id1, id2 });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
    expect(timeCapsule.compareSnapshots).toHaveBeenCalledExactlyOnceWith(id1, id2);
  });
});

describe('Digital Twin observed evidence', () => {
  it('preserves the never-computed state without recalculating or interpreting', async () => {
    const observed = {
      taste: null,
      chronotype: null,
      chronotypeComparison: { statedType: null, observedType: null, agree: null, divergence: 'unknown' },
      statedChronotype: null,
    };
    evidence.getObservedEvidence.mockResolvedValueOnce(observed);
    const response = await request(app).get(base + '/twin-evidence');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(observed);
    expect(evidence.aggregateTwinEvidence).not.toHaveBeenCalled();
    expect(evidence.interpretConsumption).not.toHaveBeenCalled();
  });

  it('recomputes with no request body and returns the refreshed evidence', async () => {
    const summary = { records: 1 };
    const observed = { taste: { signal: 'Example signal' }, chronotype: null };
    evidence.aggregateTwinEvidence.mockResolvedValueOnce(summary);
    evidence.getObservedEvidence.mockResolvedValueOnce(observed);
    const response = await request(app).post(base + '/twin-evidence/recompute');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ summary, evidence: observed });
    expect(evidence.getObservedEvidence).toHaveBeenCalledAfter(evidence.aggregateTwinEvidence);
    expect(evidence.interpretConsumption).not.toHaveBeenCalled();
  });

  it('interprets evidence only with a valid provider choice and forwards the model', async () => {
    const interpretation = { text: 'Example interpretation.' };
    evidence.interpretConsumption.mockResolvedValueOnce(interpretation);
    const response = await request(app).post(base + '/twin-evidence/interpret').send(picker);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ interpretation });
    expect(evidence.interpretConsumption).toHaveBeenCalledExactlyOnceWith(picker);
  });

  it.each([
    { path: '/twin-evidence/recompute', input: picker, service: evidence.aggregateTwinEvidence },
    { path: '/twin-evidence/interpret', input: { model: picker.model }, service: evidence.interpretConsumption },
  ])('POST $path rejects invalid input before calling the service', async ({ path, input, service }) => {
    const response = await request(app).post(base + path).send(input);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(service).not.toHaveBeenCalled();
  });
});

describe('Digital Twin avatar bio', () => {
  it.each([
    { suffix: '', length: 'persona' },
    { suffix: '?length=blurb', length: 'blurb' },
  ])('GET /avatar-bio$suffix builds the $length preset', async ({ suffix, length }) => {
    const bio = { length, combined: 'Example avatar bio.' };
    twin.buildAvatarBio.mockResolvedValueOnce(bio);
    const response = await request(app).get(base + '/avatar-bio' + suffix);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(bio);
    expect(twin.buildAvatarBio).toHaveBeenCalledExactlyOnceWith({ length });
    expect(twin.polishAvatarBio).not.toHaveBeenCalled();
  });

  it('rejects a repeated length query before building a bio', async () => {
    const response = await request(app).get(base + '/avatar-bio?length=persona&length=blurb');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(twin.buildAvatarBio).not.toHaveBeenCalled();
  });

  it('polishes the requested length and forwards the provider choice', async () => {
    const input = { ...picker, length: 'knowledge' };
    const bio = { content: 'Example first-person bio.', tokenEstimate: 8 };
    twin.polishAvatarBio.mockResolvedValueOnce(bio);
    const response = await request(app).post(base + '/avatar-bio/polish').send(input);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(bio);
    expect(twin.polishAvatarBio).toHaveBeenCalledExactlyOnceWith(input);
  });

  it('rejects an invalid polish length before invoking the service', async () => {
    const response = await request(app).post(base + '/avatar-bio/polish').send({ ...picker, length: 'unsupported' });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(twin.polishAvatarBio).not.toHaveBeenCalled();
  });
});
