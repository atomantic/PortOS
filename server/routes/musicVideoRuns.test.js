import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { errorMiddleware, ServerError } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';
import * as revisions from '../services/musicVideo/revisionService.js';
import * as autoReviews from '../services/musicVideo/autoReviewService.js';
import * as production from '../services/musicVideo/productionService.js';
import * as autonomous from '../services/musicVideo/autonomousService.js';
import { requireProductionReviewer } from '../services/musicVideo/productionReviewService.js';
import routes from './musicVideoRuns.js';

vi.mock('../services/musicVideo/revisionService.js', () => ({
  getDependencyImpact: vi.fn(),
  startDependencyRepair: vi.fn(),
  startRevision: vi.fn(),
  resumeRevision: vi.fn(),
  cancelRevision: vi.fn(),
  releaseRevisionSection: vi.fn(),
}));
vi.mock('../services/musicVideo/autoReviewService.js', () => ({
  startAutoReview: vi.fn(),
  resumeAutoReview: vi.fn(),
  stopAutoReview: vi.fn(),
  cancelAutoReview: vi.fn(),
}));
vi.mock('../services/musicVideo/productionService.js', () => ({
  startProduction: vi.fn(),
  getProduction: vi.fn(),
  resumeProduction: vi.fn(),
  stopProduction: vi.fn(),
  cancelProduction: vi.fn(),
}));
vi.mock('../services/musicVideo/autonomousService.js', () => ({
  startAutonomousVideo: vi.fn(),
  getAutonomousRun: vi.fn(),
  resumeAutonomousVideo: vi.fn(),
  stopAutonomousVideo: vi.fn(),
  cancelAutonomousVideo: vi.fn(),
}));
vi.mock('../services/musicVideo/productionReviewService.js', () => ({ requireProductionReviewer: vi.fn() }));

const app = express();
app.use(express.json());
app.use('/api/music-video', routes);
app.use(errorMiddleware);

const base = '/api/music-video';
const projectId = 'mv-fixture-project';
const excerptId = 'excerpt-fixture';
const revisionId = 'revision-fixture';
const autoReviewId = 'auto-review-fixture';
const productionId = 'production-fixture';
const sceneId = 'scene-fixture';
const reviewerPin = { providerId: 'example-provider', model: 'example-model' };
const reviewWindow = { startSec: 4, endSec: 12, limits: { maxAttempts: 2, maxGenerations: 0 } };
const productionPlan = {
  pool: [{ kind: 'image', mode: 'local', model: 'example-image-model' }],
  limits: { maxGenerations: 5, maxReviewAttempts: 2, spendCapUsd: 0 },
  stopBefore: 'clips',
};
const password = 'fixture-legacy-password';
const autonomousStart = { prompt: 'Paper boats on the river', fromProjectId: 'mv-fixture-source' };
const autonomousResume = { lyrics: 'Paper boats drift downstream' };
const result = { project: { id: projectId }, run: { id: 'fixture-run' } };

const cases = [
  { method: 'get', path: `/${projectId}/dependency-impact`, service: revisions.getDependencyImpact, args: [projectId] },
  {
    method: 'post', path: `/${projectId}/dependency-repairs`, service: revisions.startDependencyRepair, status: 201,
    body: { basis: 'fixture-basis' }, invalid: { basis: '' }, conflict: 'DEPENDENCY_PREVIEW_CHANGED',
  },
  {
    method: 'post', path: `/${projectId}/excerpt/${excerptId}/revisions`, service: revisions.startRevision, status: 201,
    body: { sceneIds: [sceneId] }, invalid: { sceneIds: [] },
    args: [projectId, excerptId, { sceneIds: [sceneId] }], conflict: 'EXCERPT_NOT_READY',
  },
  {
    method: 'post', path: `/${projectId}/revisions/${revisionId}/resume`, service: revisions.resumeRevision,
    args: [projectId, revisionId], conflict: 'REVISION_CLOSED',
  },
  {
    method: 'post', path: `/${projectId}/revisions/${revisionId}/cancel`, service: revisions.cancelRevision,
    args: [projectId, revisionId], conflict: 'REVISION_CLOSED',
  },
  {
    method: 'post', path: `/${projectId}/revisions/${revisionId}/release`, service: revisions.releaseRevisionSection,
    body: { sceneId }, invalid: { sceneId: '' }, args: [projectId, revisionId, sceneId], conflict: 'REVISION_CLOSED',
  },
  {
    method: 'post', path: `/${projectId}/auto-reviews`, service: autoReviews.startAutoReview, status: 201,
    body: { ...reviewWindow, ...reviewerPin }, invalid: { ...reviewWindow, endSec: reviewWindow.startSec },
    args: [projectId, { ...reviewWindow, reviewer: reviewerPin }], conflict: 'AUTO_REVIEW_IN_PROGRESS',
  },
  {
    method: 'post', path: `/${projectId}/auto-reviews/${autoReviewId}/resume`, service: autoReviews.resumeAutoReview,
    body: { limits: { maxAttempts: 3 } }, invalid: { limits: { maxAttempts: 0 } },
    args: [projectId, autoReviewId, { limits: { maxAttempts: 3 } }], conflict: 'AUTO_REVIEW_CLOSED',
  },
  {
    method: 'post', path: `/${projectId}/auto-reviews/${autoReviewId}/stop`, service: autoReviews.stopAutoReview,
    args: [projectId, autoReviewId], conflict: 'AUTO_REVIEW_NOT_RUNNING',
  },
  {
    method: 'post', path: `/${projectId}/auto-reviews/${autoReviewId}/cancel`, service: autoReviews.cancelAutoReview,
    args: [projectId, autoReviewId], conflict: 'AUTO_REVIEW_CLOSED',
  },
  {
    method: 'post', path: `/${projectId}/production-runs`, service: production.startProduction, status: 201,
    body: { ...productionPlan, ...reviewerPin }, invalid: { ...productionPlan, pool: [{ kind: 'audio', mode: 'local' }] },
    args: [projectId, { ...productionPlan, reviewer: reviewerPin }], conflict: 'PRODUCTION_IN_PROGRESS',
  },
  {
    method: 'get', path: `/${projectId}/production-runs/${productionId}`, service: production.getProduction,
    args: [projectId, productionId],
  },
  {
    method: 'post', path: `/${projectId}/production-runs/${productionId}/resume`, service: production.resumeProduction,
    body: { acceptBasis: true, stopBefore: null }, invalid: { acceptBasis: 'yes' },
    args: [projectId, productionId, { acceptBasis: true, stopBefore: null }], conflict: 'PRODUCTION_BASIS_CHANGED',
  },
  {
    method: 'post', path: `/${projectId}/production-runs/${productionId}/stop`, service: production.stopProduction,
    args: [projectId, productionId], conflict: 'PRODUCTION_CLOSED',
  },
  {
    method: 'post', path: `/${projectId}/production-runs/${productionId}/cancel`, service: production.cancelProduction,
    args: [projectId, productionId], conflict: 'PRODUCTION_CLOSED',
  },
  {
    method: 'post', path: '/autonomous', service: autonomous.startAutonomousVideo, status: 202,
    body: { ...autonomousStart, prompt: `  ${autonomousStart.prompt}  `, password }, invalid: { prompt: '   ' },
    args: [autonomousStart, { autoApproveAuthorized: false }], conflict: 'NO_SONG',
  },
  { method: 'get', path: `/${projectId}/autonomous`, service: autonomous.getAutonomousRun, args: [projectId] },
  {
    method: 'post', path: `/${projectId}/autonomous/resume`, service: autonomous.resumeAutonomousVideo,
    body: { ...autonomousResume, password }, invalid: { lyrics: false },
    args: [projectId, autonomousResume, { autoApproveAuthorized: false }], conflict: 'NOT_RESUMABLE',
  },
  {
    method: 'post', path: `/${projectId}/autonomous/stop`, service: autonomous.stopAutonomousVideo,
    args: [projectId], conflict: 'NOT_RUNNING',
  },
  {
    method: 'post', path: `/${projectId}/autonomous/cancel`, service: autonomous.cancelAutonomousVideo,
    args: [projectId], conflict: 'NOT_CANCELABLE',
  },
];

beforeEach(() => vi.resetAllMocks());

describe.each(cases)('$method $path', ({
  method, path, service, body, invalid, status = 200, conflict, args = [projectId, body],
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

describe.each([
  {
    name: 'autonomous start with an auto-approval grant',
    path: '/autonomous', service: autonomous.startAutonomousVideo, status: 202,
    body: { ...autonomousStart, autoApprove: ['storyboard', 'art', 'art'] },
    args: [{ ...autonomousStart, autoApprove: ['art', 'storyboard'] }],
  },
  {
    name: 'autonomous start with an orchestrator',
    path: '/autonomous', service: autonomous.startAutonomousVideo, status: 202,
    body: { ...autonomousStart, orchestrator: reviewerPin },
    args: [{ ...autonomousStart, orchestrator: reviewerPin }],
  },
  {
    name: 'autonomous resume with an explicit empty grant',
    path: `/${projectId}/autonomous/resume`, service: autonomous.resumeAutonomousVideo, status: 200,
    body: { ...autonomousResume, autoApprove: [] },
    args: [projectId, { ...autonomousResume, autoApprove: [] }],
  },
])('$name', ({ path, service, status, body, args }) => {
  const send = () => request(app).post(base + path).send({ ...body, password });

  it('forwards the reviewer grant and omits the legacy password', async () => {
    const reviewer = { kind: 'session', sessionId: 'fixture-session', label: 'agent' };
    requireProductionReviewer.mockResolvedValueOnce(reviewer);
    service.mockResolvedValueOnce(result);

    expect((await send()).status).toBe(status);
    expect(requireProductionReviewer).toHaveBeenCalledOnce();
    expect(service).toHaveBeenCalledExactlyOnceWith(...args, { autoApproveAuthorized: reviewer });
  });

  it('rejects a missing reviewer before dispatch', async () => {
    requireProductionReviewer.mockRejectedValueOnce(new ServerError('Sign in to PortOS.', { status: 401, code: 'AUTH_REQUIRED' }));
    const response = await send();

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(service).not.toHaveBeenCalled();
  });
});
