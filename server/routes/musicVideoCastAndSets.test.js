import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { errorMiddleware, ServerError } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';
import * as castAndSets from '../services/musicVideo/castAndSetsService.js';
import { requireProductionReviewer } from '../services/musicVideo/productionReviewService.js';
import routes from './musicVideoCastAndSets.js';

vi.mock('../services/musicVideo/castAndSetsService.js', () => ({
  useCatalogCheckin: vi.fn(),
  rebuildCatalogGuide: vi.fn(),
  repairShotReference: vi.fn(),
  getCastAndSets: vi.fn(),
  getCastAndSetsCastingChanges: vi.fn(),
  startCastAndSets: vi.fn(),
  regenerateCastAndSets: vi.fn(),
  useCastAndSetsImage: vi.fn(),
  previewCastAndSetsImageEdit: vi.fn(),
  editCastAndSetsImage: vi.fn(),
  acceptCastAndSetsImageEdit: vi.fn(),
  discardCastAndSetsImageEdit: vi.fn(),
  editCastAndSetsDirection: vi.fn(),
  editCastAndSetsDirectionText: vi.fn(),
  applyCastAndSetsFeedback: vi.fn(),
  renderCastAndSetsFeedback: vi.fn(),
  refreshCastAndSetsFeedbackRenderer: vi.fn(),
  removeCastAndSetsImageFeedback: vi.fn(),
  removeCastAndSetsFeedbackEntry: vi.fn(),
  discardCastAndSets: vi.fn(),
  resumeCastAndSets: vi.fn(),
  reinspectCastAndSetsImages: vi.fn(),
  acknowledgeCastAndSetsImage: vi.fn(),
  approveCastAndSets: vi.fn(),
  reconfirmCastAndSets: vi.fn(),
  skipCastAndSets: vi.fn(),
}));
vi.mock('../services/musicVideo/productionReviewService.js', () => ({ requireProductionReviewer: vi.fn() }));

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.portosAuthContext = { enabled: req.get('x-test-auth-enabled') === 'true' };
  next();
});
app.use('/api/music-video', routes);
app.use(errorMiddleware);

const projectId = 'mv-fixture-project';
const base = `/api/music-video/${projectId}/cast-and-sets`;
const provider = { providerId: 'example-provider', model: 'example-model' };
const image = { key: 'character', imageId: 'fixture-sheet.png' };
const imageEdit = { ...image, revision: 2, instruction: 'Add a painted star' };
const decision = { key: image.key, requestId: '11111111-1111-4111-8111-111111111111' };
const acknowledgement = {
  inputs: { ...image, imageRevision: 2, jobId: null, planPrompt: 'Paper figure', submittedPrompt: null },
  inspectionId: '22222222-2222-4222-8222-222222222222',
};
const localReviewer = { kind: 'local', label: 'Local operator' };
const approval = { catalogBasis: 'a'.repeat(64) };
const problemId = 'b'.repeat(64);
const result = { project: { id: projectId }, stage: { revision: 2 } };

const cases = [
  { method: 'post', path: '/catalog', service: castAndSets.useCatalogCheckin, conflict: 'CAST_SETS_IN_PROGRESS' },
  { method: 'post', path: '/catalog/guide', service: castAndSets.rebuildCatalogGuide, conflict: 'CAST_SETS_CATALOG_STALE' },
  {
    method: 'post', path: '/catalog/repair-shot-reference', service: castAndSets.repairShotReference,
    body: { problemId }, invalid: { problemId: 'invalid-digest' }, args: [projectId, problemId],
    conflict: 'MUSIC_VIDEO_SHOT_REFERENCE_STALE',
  },
  { method: 'get', path: '', service: castAndSets.getCastAndSets },
  { method: 'get', path: '/casting-changes', service: castAndSets.getCastAndSetsCastingChanges },
  {
    method: 'post', path: '', service: castAndSets.startCastAndSets, status: 202,
    body: provider, invalid: { ...provider, effort: 'unbounded' }, conflict: 'NOT_ANALYZED',
  },
  {
    method: 'post', path: '/regenerate', service: castAndSets.regenerateCastAndSets, status: 202,
    body: { keys: [image.key], notes: [{ text: 'Add a star', target: image.key }] },
    invalid: { keys: [] }, conflict: 'CAST_SETS_NO_DIRECTION',
  },
  {
    method: 'post', path: '/use-image', service: castAndSets.useCastAndSetsImage, status: 202,
    body: image, invalid: { ...image, key: '' }, conflict: 'CAST_SETS_NOT_IN_REVIEW',
  },
  {
    method: 'post', path: '/edit-image-preview', service: castAndSets.previewCastAndSetsImageEdit,
    body: imageEdit, invalid: { ...imageEdit, instruction: '   ' }, conflict: 'CAST_SETS_EDIT_STALE',
  },
  {
    method: 'post', path: '/edit-image', service: castAndSets.editCastAndSetsImage, status: 202,
    body: imageEdit, invalid: { ...imageEdit, revision: 0 }, conflict: 'CAST_SETS_EDIT_STALE',
  },
  {
    method: 'post', path: '/accept-image-edit', service: castAndSets.acceptCastAndSetsImageEdit, status: 202,
    body: decision, invalid: { ...decision, requestId: 'invalid-id' }, conflict: 'CAST_SETS_EDIT_STALE',
  },
  {
    method: 'post', path: '/discard-image-edit', service: castAndSets.discardCastAndSetsImageEdit,
    body: decision, invalid: { requestId: decision.requestId }, conflict: 'CAST_SETS_EDIT_STALE',
  },
  {
    method: 'patch', path: '/direction', service: castAndSets.editCastAndSetsDirection, status: 202,
    body: { sheetLayout: 'five-view', protagonist: { signature: '' } },
    invalid: { sheetLayout: 'unknown' }, conflict: 'CAST_SETS_NO_DIRECTION',
  },
  {
    method: 'patch', path: '/direction-text', service: castAndSets.editCastAndSetsDirectionText,
    body: { look: 'Painted glass', props: [] }, invalid: { props: [{ name: 'Star' }] }, conflict: 'CAST_SETS_NOT_CATALOG',
  },
  {
    method: 'post', path: '/feedback', service: castAndSets.applyCastAndSetsFeedback, status: 202,
    body: { text: '  Add a painted star  ', target: image.key }, invalid: { text: ' ' },
    args: [projectId, { text: 'Add a painted star', target: image.key }], conflict: 'CAST_SETS_JOBS_IN_FLIGHT',
  },
  {
    method: 'post', path: '/feedback/render', service: castAndSets.renderCastAndSetsFeedback, status: 202,
    body: { revision: 2, count: 0 }, invalid: { revision: 2, count: -1 }, conflict: 'CAST_SETS_PLAN_STALE',
  },
  {
    method: 'post', path: '/feedback/refresh-renderer', service: castAndSets.refreshCastAndSetsFeedbackRenderer,
    status: 202, body: { revision: 2 }, invalid: { revision: 0 }, conflict: 'CAST_SETS_PLAN_STALE',
  },
  {
    method: 'post', path: '/feedback/remove-image-note', service: castAndSets.removeCastAndSetsImageFeedback,
    body: { key: image.key, index: 0, text: 'Add a star' },
    invalid: { key: image.key, index: -1, text: 'Add a star' }, conflict: 'CAST_SETS_NOTE_STALE',
  },
  {
    method: 'delete', path: '/feedback/fixture-feedback', service: castAndSets.removeCastAndSetsFeedbackEntry,
    args: [projectId, 'fixture-feedback'], conflict: 'CAST_SETS_CATALOG_ONLY',
  },
  { method: 'delete', path: '', service: castAndSets.discardCastAndSets, conflict: 'CAST_SETS_APPROVED' },
  {
    method: 'post', path: '/resume', service: castAndSets.resumeCastAndSets, status: 202,
    body: provider, invalid: { ...provider, model: '' }, conflict: 'CAST_SETS_NOT_RESUMABLE',
  },
  {
    method: 'post', path: '/inspect', service: castAndSets.reinspectCastAndSetsImages,
    body: { keys: [image.key] }, invalid: { keys: [] }, conflict: 'CAST_SETS_NOT_IN_REVIEW',
  },
  {
    method: 'post', path: '/acknowledge-image', service: castAndSets.acknowledgeCastAndSetsImage,
    body: acknowledgement, invalid: { ...acknowledgement, inspectionId: 'invalid-id' },
    args: [projectId, acknowledgement, localReviewer], conflict: 'CAST_SETS_INSPECTION_STALE',
  },
  {
    method: 'post', path: '/approve', service: castAndSets.approveCastAndSets,
    body: approval, invalid: { catalogBasis: 'invalid-digest' }, conflict: 'CAST_SETS_CATALOG_STALE',
  },
  {
    method: 'post', path: '/reconfirm', service: castAndSets.reconfirmCastAndSets,
    body: approval, invalid: { catalogBasis: 'invalid-digest' }, conflict: 'CAST_SETS_CATALOG_STALE',
  },
  { method: 'post', path: '/skip', service: castAndSets.skipCastAndSets, conflict: 'CAST_SETS_EXISTS' },
];

beforeEach(() => vi.resetAllMocks());

describe.each(cases)('$method /:id/cast-and-sets$path', ({
  method, path, service, body, invalid, status = 200, conflict,
  args = body === undefined ? [projectId] : [projectId, body],
}) => {
  const send = (payload = body) => request(app)[method](base + path).send(payload);

  it(`forwards the request and returns ${status}`, async () => {
    service.mockResolvedValueOnce(result);
    const response = await send();
    expect(service).toHaveBeenCalledExactlyOnceWith(...args);
    expect(response.status).toBe(status);
    expect(response.body).toEqual(result);
    expect(requireProductionReviewer).not.toHaveBeenCalled();
  });

  if (invalid !== undefined) {
    it('rejects invalid input before dispatch', async () => {
      const response = await send(invalid);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(service).not.toHaveBeenCalled();
      expect(requireProductionReviewer).not.toHaveBeenCalled();
    });
  }

  const errors = [[404, 'NOT_FOUND']];
  if (conflict) errors.push([409, conflict]);
  it.each(errors)('preserves service error %i %s', async (status, code) => {
    const error = 'Fixture service refusal';
    service.mockRejectedValueOnce(new ServerError(error, { status, code }));
    const response = await send();
    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ error, code });
  });
});

it.each([
  ['approve', castAndSets.approveCastAndSets],
  ['reconfirm', castAndSets.reconfirmCastAndSets],
])('accepts a legacy %s without a request body', async (action, service) => {
  service.mockResolvedValueOnce(result);
  const response = await request(app).post(`${base}/${action}`);

  expect(response.status).toBe(200);
  expect(service).toHaveBeenCalledExactlyOnceWith(projectId, {});
});

describe('authenticated image acknowledgement', () => {
  const acknowledge = (body = acknowledgement) => request(app).post(`${base}/acknowledge-image`)
    .set('x-test-auth-enabled', 'true').send(body);

  it('forwards the authenticated reviewer to the service', async () => {
    const reviewer = { kind: 'session', sessionId: 'fixture-session', label: 'agent' };
    requireProductionReviewer.mockResolvedValueOnce(reviewer);
    castAndSets.acknowledgeCastAndSetsImage.mockResolvedValueOnce(result);

    expect((await acknowledge()).status).toBe(200);
    expect(requireProductionReviewer).toHaveBeenCalledOnce();
    expect(castAndSets.acknowledgeCastAndSetsImage).toHaveBeenCalledExactlyOnceWith(projectId, acknowledgement, reviewer);
  });

  it('rejects a missing reviewer before dispatch', async () => {
    requireProductionReviewer.mockRejectedValueOnce(new ServerError('Sign in to PortOS.', { status: 401, code: 'AUTH_REQUIRED' }));
    const response = await acknowledge();

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(castAndSets.acknowledgeCastAndSetsImage).not.toHaveBeenCalled();
  });
});
