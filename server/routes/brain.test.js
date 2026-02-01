import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import brainRoutes from './brain.js';

// Mock the brain service
vi.mock('../services/brain.js', () => ({
  // Capture & Inbox
  captureThought: vi.fn(),
  getInboxLog: vi.fn(),
  getInboxLogById: vi.fn(),
  getInboxLogCounts: vi.fn(),
  resolveReview: vi.fn(),
  fixClassification: vi.fn(),
  retryClassification: vi.fn(),
  // People
  getPeople: vi.fn(),
  getPersonById: vi.fn(),
  createPerson: vi.fn(),
  updatePerson: vi.fn(),
  deletePerson: vi.fn(),
  // Projects
  getProjects: vi.fn(),
  getProjectById: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  // Ideas
  getIdeas: vi.fn(),
  getIdeaById: vi.fn(),
  createIdea: vi.fn(),
  updateIdea: vi.fn(),
  deleteIdea: vi.fn(),
  // Admin
  getAdminItems: vi.fn(),
  getAdminById: vi.fn(),
  createAdminItem: vi.fn(),
  updateAdminItem: vi.fn(),
  deleteAdminItem: vi.fn(),
  // Digest & Review
  getLatestDigest: vi.fn(),
  getDigests: vi.fn(),
  runDailyDigest: vi.fn(),
  getLatestReview: vi.fn(),
  getReviews: vi.fn(),
  runWeeklyReview: vi.fn(),
  // Settings & Summary
  loadMeta: vi.fn(),
  updateMeta: vi.fn(),
  getSummary: vi.fn()
}));

// Import mocked module
import * as brainService from '../services/brain.js';

describe('Brain Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/brain', brainRoutes);
    vi.clearAllMocks();
  });

  // ===========================================================================
  // CAPTURE & INBOX
  // ===========================================================================

  describe('POST /api/brain/capture', () => {
    it('should capture a thought and return result', async () => {
      const mockResult = {
        inboxLog: {
          id: 'inbox-001',
          capturedText: 'Test thought',
          status: 'filed',
          classification: {
            destination: 'ideas',
            confidence: 0.9,
            title: 'Test Idea'
          }
        },
        filedRecord: { id: 'idea-001', title: 'Test Idea' },
        message: 'Filed to ideas: Test Idea'
      };
      brainService.captureThought.mockResolvedValue(mockResult);

      const response = await request(app)
        .post('/api/brain/capture')
        .send({ text: 'Test thought' });

      expect(response.status).toBe(200);
      expect(response.body.inboxLog.id).toBe('inbox-001');
      expect(brainService.captureThought).toHaveBeenCalledWith('Test thought', undefined, undefined);
    });

    it('should return 400 if text is missing', async () => {
      const response = await request(app)
        .post('/api/brain/capture')
        .send({});

      expect(response.status).toBe(400);
    });

    it('should pass provider and model overrides', async () => {
      brainService.captureThought.mockResolvedValue({ inboxLog: { id: 'inbox-002' } });

      await request(app)
        .post('/api/brain/capture')
        .send({ text: 'Test', providerOverride: 'openai', modelOverride: 'gpt-4' });

      expect(brainService.captureThought).toHaveBeenCalledWith('Test', 'openai', 'gpt-4');
    });
  });

  describe('GET /api/brain/inbox', () => {
    it('should return inbox entries with counts', async () => {
      const mockEntries = [
        { id: 'inbox-001', status: 'filed' },
        { id: 'inbox-002', status: 'needs_review' }
      ];
      const mockCounts = { total: 2, filed: 1, needs_review: 1 };
      brainService.getInboxLog.mockResolvedValue(mockEntries);
      brainService.getInboxLogCounts.mockResolvedValue(mockCounts);

      const response = await request(app).get('/api/brain/inbox');

      expect(response.status).toBe(200);
      expect(response.body.entries).toHaveLength(2);
      expect(response.body.counts.total).toBe(2);
    });

    it('should pass filters to service', async () => {
      brainService.getInboxLog.mockResolvedValue([]);
      brainService.getInboxLogCounts.mockResolvedValue({});

      await request(app).get('/api/brain/inbox?status=needs_review&limit=50');

      expect(brainService.getInboxLog).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'needs_review', limit: 50 })
      );
    });
  });

  describe('GET /api/brain/inbox/:id', () => {
    it('should return inbox entry by ID', async () => {
      brainService.getInboxLogById.mockResolvedValue({ id: 'inbox-001', capturedText: 'Test' });

      const response = await request(app).get('/api/brain/inbox/inbox-001');

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('inbox-001');
    });

    it('should return 404 if not found', async () => {
      brainService.getInboxLogById.mockResolvedValue(null);

      const response = await request(app).get('/api/brain/inbox/inbox-999');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/brain/review/resolve', () => {
    it('should resolve a needs_review item', async () => {
      const testUuid = '550e8400-e29b-41d4-a716-446655440000';
      brainService.resolveReview.mockResolvedValue({
        inboxLog: { id: testUuid, status: 'filed' },
        filedRecord: { id: 'project-001' }
      });

      const response = await request(app)
        .post('/api/brain/review/resolve')
        .send({
          inboxLogId: testUuid,
          destination: 'projects',
          editedExtracted: { name: 'Test Project' }
        });

      expect(response.status).toBe(200);
      expect(brainService.resolveReview).toHaveBeenCalledWith(
        testUuid,
        'projects',
        { name: 'Test Project' }
      );
    });

    it('should return 400 if required fields are missing', async () => {
      const response = await request(app)
        .post('/api/brain/review/resolve')
        .send({ inboxLogId: '550e8400-e29b-41d4-a716-446655440000' });

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/brain/fix', () => {
    it('should fix a filed classification', async () => {
      const testUuid = '550e8400-e29b-41d4-a716-446655440001';
      brainService.fixClassification.mockResolvedValue({
        inboxLog: { id: testUuid, status: 'corrected' },
        newRecord: { id: 'people-001' }
      });

      const response = await request(app)
        .post('/api/brain/fix')
        .send({
          inboxLogId: testUuid,
          newDestination: 'people',
          updatedFields: { name: 'John Doe' },
          note: 'Wrong category'
        });

      expect(response.status).toBe(200);
      expect(brainService.fixClassification).toHaveBeenCalledWith(
        testUuid,
        'people',
        { name: 'John Doe' },
        'Wrong category'
      );
    });

    it('should return 400 if required fields are missing', async () => {
      const response = await request(app)
        .post('/api/brain/fix')
        .send({ inboxLogId: '550e8400-e29b-41d4-a716-446655440001' });

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/brain/inbox/:id/retry', () => {
    it('should retry classification', async () => {
      brainService.retryClassification.mockResolvedValue({
        inboxLog: { id: 'inbox-001', status: 'filed' }
      });

      const response = await request(app)
        .post('/api/brain/inbox/inbox-001/retry')
        .send({});

      expect(response.status).toBe(200);
      expect(brainService.retryClassification).toHaveBeenCalledWith('inbox-001', undefined, undefined);
    });
  });

  // ===========================================================================
  // PEOPLE CRUD
  // ===========================================================================

  describe('GET /api/brain/people', () => {
    it('should return all people', async () => {
      brainService.getPeople.mockResolvedValue([
        { id: 'people-001', name: 'John' },
        { id: 'people-002', name: 'Jane' }
      ]);

      const response = await request(app).get('/api/brain/people');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
    });
  });

  describe('GET /api/brain/people/:id', () => {
    it('should return person by ID', async () => {
      brainService.getPersonById.mockResolvedValue({ id: 'people-001', name: 'John' });

      const response = await request(app).get('/api/brain/people/people-001');

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('John');
    });

    it('should return 404 if not found', async () => {
      brainService.getPersonById.mockResolvedValue(null);

      const response = await request(app).get('/api/brain/people/people-999');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/brain/people', () => {
    it('should create a person', async () => {
      brainService.createPerson.mockResolvedValue({
        id: 'people-001',
        name: 'John Doe',
        context: 'Work colleague'
      });

      const response = await request(app)
        .post('/api/brain/people')
        .send({ name: 'John Doe', context: 'Work colleague' });

      expect(response.status).toBe(201);
      expect(response.body.id).toBe('people-001');
    });

    it('should return 400 if name is missing', async () => {
      const response = await request(app)
        .post('/api/brain/people')
        .send({ context: 'Test' });

      expect(response.status).toBe(400);
    });
  });

  describe('PUT /api/brain/people/:id', () => {
    it('should update a person', async () => {
      brainService.updatePerson.mockResolvedValue({ id: 'people-001', name: 'John Updated' });

      const response = await request(app)
        .put('/api/brain/people/people-001')
        .send({ name: 'John Updated' });

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('John Updated');
    });

    it('should return 404 if not found', async () => {
      brainService.updatePerson.mockResolvedValue(null);

      const response = await request(app)
        .put('/api/brain/people/people-999')
        .send({ name: 'Test' });

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/brain/people/:id', () => {
    it('should delete a person', async () => {
      brainService.deletePerson.mockResolvedValue(true);

      const response = await request(app).delete('/api/brain/people/people-001');

      expect(response.status).toBe(204);
    });

    it('should return 404 if not found', async () => {
      brainService.deletePerson.mockResolvedValue(false);

      const response = await request(app).delete('/api/brain/people/people-999');

      expect(response.status).toBe(404);
    });
  });

  // ===========================================================================
  // PROJECTS CRUD
  // ===========================================================================

  describe('GET /api/brain/projects', () => {
    it('should return all projects', async () => {
      brainService.getProjects.mockResolvedValue([
        { id: 'proj-001', name: 'Project A' }
      ]);

      const response = await request(app).get('/api/brain/projects');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
    });

    it('should filter by status', async () => {
      brainService.getProjects.mockResolvedValue([]);

      await request(app).get('/api/brain/projects?status=active');

      expect(brainService.getProjects).toHaveBeenCalledWith({ status: 'active' });
    });
  });

  describe('POST /api/brain/projects', () => {
    it('should create a project', async () => {
      brainService.createProject.mockResolvedValue({
        id: 'proj-001',
        name: 'New Project',
        status: 'active'
      });

      const response = await request(app)
        .post('/api/brain/projects')
        .send({ name: 'New Project', status: 'active', nextAction: 'Define scope' });

      expect(response.status).toBe(201);
      expect(response.body.id).toBe('proj-001');
    });

    it('should return 400 if name is missing', async () => {
      const response = await request(app)
        .post('/api/brain/projects')
        .send({ status: 'active' });

      expect(response.status).toBe(400);
    });
  });

  // ===========================================================================
  // IDEAS CRUD
  // ===========================================================================

  describe('GET /api/brain/ideas', () => {
    it('should return all ideas', async () => {
      brainService.getIdeas.mockResolvedValue([
        { id: 'idea-001', title: 'Great Idea' }
      ]);

      const response = await request(app).get('/api/brain/ideas');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
    });
  });

  describe('POST /api/brain/ideas', () => {
    it('should create an idea', async () => {
      brainService.createIdea.mockResolvedValue({
        id: 'idea-001',
        title: 'New Idea',
        oneLiner: 'A brief description'
      });

      const response = await request(app)
        .post('/api/brain/ideas')
        .send({ title: 'New Idea', oneLiner: 'A brief description' });

      expect(response.status).toBe(201);
      expect(response.body.id).toBe('idea-001');
    });

    it('should return 400 if title is missing', async () => {
      const response = await request(app)
        .post('/api/brain/ideas')
        .send({ oneLiner: 'Test' });

      expect(response.status).toBe(400);
    });
  });

  // ===========================================================================
  // ADMIN CRUD
  // ===========================================================================

  describe('GET /api/brain/admin', () => {
    it('should return all admin items', async () => {
      brainService.getAdminItems.mockResolvedValue([
        { id: 'admin-001', title: 'Renew license' }
      ]);

      const response = await request(app).get('/api/brain/admin');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
    });

    it('should filter by status', async () => {
      brainService.getAdminItems.mockResolvedValue([]);

      await request(app).get('/api/brain/admin?status=open');

      expect(brainService.getAdminItems).toHaveBeenCalledWith({ status: 'open' });
    });
  });

  describe('POST /api/brain/admin', () => {
    it('should create an admin item', async () => {
      brainService.createAdminItem.mockResolvedValue({
        id: 'admin-001',
        title: 'Renew license',
        status: 'open'
      });

      const response = await request(app)
        .post('/api/brain/admin')
        .send({ title: 'Renew license', status: 'open' });

      expect(response.status).toBe(201);
      expect(response.body.id).toBe('admin-001');
    });

    it('should return 400 if title is missing', async () => {
      const response = await request(app)
        .post('/api/brain/admin')
        .send({ status: 'open' });

      expect(response.status).toBe(400);
    });
  });

  // ===========================================================================
  // DIGEST & REVIEW
  // ===========================================================================

  describe('GET /api/brain/digest/latest', () => {
    it('should return latest digest', async () => {
      brainService.getLatestDigest.mockResolvedValue({
        id: 'digest-001',
        digestText: 'Today summary...'
      });

      const response = await request(app).get('/api/brain/digest/latest');

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('digest-001');
    });
  });

  describe('GET /api/brain/digests', () => {
    it('should return digest history', async () => {
      brainService.getDigests.mockResolvedValue([
        { id: 'digest-001' },
        { id: 'digest-002' }
      ]);

      const response = await request(app).get('/api/brain/digests');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
    });

    it('should pass limit parameter', async () => {
      brainService.getDigests.mockResolvedValue([]);

      await request(app).get('/api/brain/digests?limit=5');

      expect(brainService.getDigests).toHaveBeenCalledWith(5);
    });
  });

  describe('POST /api/brain/digest/run', () => {
    it('should run daily digest manually', async () => {
      brainService.runDailyDigest.mockResolvedValue({
        id: 'digest-001',
        digestText: 'New digest...'
      });

      const response = await request(app)
        .post('/api/brain/digest/run')
        .send({});

      expect(response.status).toBe(200);
      expect(brainService.runDailyDigest).toHaveBeenCalled();
    });
  });

  describe('GET /api/brain/review/latest', () => {
    it('should return latest weekly review', async () => {
      brainService.getLatestReview.mockResolvedValue({
        id: 'review-001',
        reviewText: 'Weekly summary...'
      });

      const response = await request(app).get('/api/brain/review/latest');

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('review-001');
    });
  });

  describe('GET /api/brain/reviews', () => {
    it('should return review history', async () => {
      brainService.getReviews.mockResolvedValue([{ id: 'review-001' }]);

      const response = await request(app).get('/api/brain/reviews');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
    });
  });

  describe('POST /api/brain/review/run', () => {
    it('should run weekly review manually', async () => {
      brainService.runWeeklyReview.mockResolvedValue({
        id: 'review-001',
        reviewText: 'New review...'
      });

      const response = await request(app)
        .post('/api/brain/review/run')
        .send({});

      expect(response.status).toBe(200);
      expect(brainService.runWeeklyReview).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // SETTINGS & SUMMARY
  // ===========================================================================

  describe('GET /api/brain/settings', () => {
    it('should return brain settings', async () => {
      brainService.loadMeta.mockResolvedValue({
        confidenceThreshold: 0.6,
        dailyDigestTime: '09:00',
        defaultProvider: 'lmstudio'
      });

      const response = await request(app).get('/api/brain/settings');

      expect(response.status).toBe(200);
      expect(response.body.confidenceThreshold).toBe(0.6);
    });
  });

  describe('PUT /api/brain/settings', () => {
    it('should update brain settings', async () => {
      brainService.updateMeta.mockResolvedValue({
        confidenceThreshold: 0.8,
        dailyDigestTime: '10:00'
      });

      const response = await request(app)
        .put('/api/brain/settings')
        .send({ confidenceThreshold: 0.8, dailyDigestTime: '10:00' });

      expect(response.status).toBe(200);
      expect(brainService.updateMeta).toHaveBeenCalledWith(
        expect.objectContaining({ confidenceThreshold: 0.8 })
      );
    });
  });

  describe('GET /api/brain/summary', () => {
    it('should return brain summary', async () => {
      brainService.getSummary.mockResolvedValue({
        peopleCount: 5,
        projectsCount: 3,
        ideasCount: 10,
        adminCount: 2,
        needsReviewCount: 1
      });

      const response = await request(app).get('/api/brain/summary');

      expect(response.status).toBe(200);
      expect(response.body.peopleCount).toBe(5);
    });
  });

  // ===========================================================================
  // CAPTURE FLOW - ALWAYS CREATES INBOX LOG
  // ===========================================================================

  describe('Capture Flow - Always Creates Inbox Log', () => {
    it('should create inbox log even when AI classification fails', async () => {
      // Simulate AI failure that still creates inbox log in needs_review state
      brainService.captureThought.mockResolvedValue({
        inboxLog: {
          id: 'inbox-001',
          capturedText: 'Test thought',
          status: 'needs_review',
          classification: {
            destination: 'unknown',
            confidence: 0
          }
        },
        message: 'Thought captured but AI unavailable. Queued for manual review.'
      });

      const response = await request(app)
        .post('/api/brain/capture')
        .send({ text: 'Test thought' });

      expect(response.status).toBe(200);
      expect(response.body.inboxLog.id).toBeDefined();
      expect(response.body.inboxLog.status).toBe('needs_review');
    });
  });

  // ===========================================================================
  // CONFIDENCE THRESHOLD GATING
  // ===========================================================================

  describe('Confidence Threshold Gating', () => {
    it('should file directly when confidence is above threshold', async () => {
      brainService.captureThought.mockResolvedValue({
        inboxLog: {
          id: 'inbox-001',
          status: 'filed',
          classification: { confidence: 0.9, destination: 'ideas' }
        },
        filedRecord: { id: 'idea-001' }
      });

      const response = await request(app)
        .post('/api/brain/capture')
        .send({ text: 'High confidence thought' });

      expect(response.status).toBe(200);
      expect(response.body.inboxLog.status).toBe('filed');
    });

    it('should send to needs_review when confidence is below threshold', async () => {
      brainService.captureThought.mockResolvedValue({
        inboxLog: {
          id: 'inbox-002',
          status: 'needs_review',
          classification: { confidence: 0.4, destination: 'ideas' }
        },
        message: 'Thought captured but needs review. Confidence: 40%'
      });

      const response = await request(app)
        .post('/api/brain/capture')
        .send({ text: 'Low confidence thought' });

      expect(response.status).toBe(200);
      expect(response.body.inboxLog.status).toBe('needs_review');
    });
  });

  // ===========================================================================
  // FIX/MOVE BEHAVIOR
  // ===========================================================================

  describe('Fix/Move Behavior Updates Records', () => {
    it('should update inbox log status to corrected after fix', async () => {
      const testUuid = '550e8400-e29b-41d4-a716-446655440002';
      brainService.fixClassification.mockResolvedValue({
        inboxLog: {
          id: testUuid,
          status: 'corrected',
          correction: {
            previousDestination: 'ideas',
            newDestination: 'projects',
            note: 'Actually a project'
          }
        },
        newRecord: { id: 'proj-001' }
      });

      const response = await request(app)
        .post('/api/brain/fix')
        .send({
          inboxLogId: testUuid,
          newDestination: 'projects',
          updatedFields: { name: 'Test Project' },
          note: 'Actually a project'
        });

      expect(response.status).toBe(200);
      expect(response.body.inboxLog.status).toBe('corrected');
      expect(response.body.inboxLog.correction.previousDestination).toBe('ideas');
      expect(response.body.inboxLog.correction.newDestination).toBe('projects');
    });
  });
});
