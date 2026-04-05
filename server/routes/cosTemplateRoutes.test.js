import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import templateRoutes from './cosTemplateRoutes.js';

vi.mock('../services/taskTemplates.js', () => ({
  getAllTemplates: vi.fn(),
  getPopularTemplates: vi.fn(),
  getCategories: vi.fn(),
  createTemplate: vi.fn(),
  createTemplateFromTask: vi.fn(),
  recordTemplateUsage: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn()
}));

import * as taskTemplates from '../services/taskTemplates.js';

describe('CoS Template Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/cos', templateRoutes);
    vi.clearAllMocks();
  });

  describe('GET /api/cos/templates', () => {
    it('should return all templates', async () => {
      taskTemplates.getAllTemplates.mockResolvedValue([{ id: 't1', name: 'Fix Bug' }]);

      const response = await request(app).get('/api/cos/templates');

      expect(response.status).toBe(200);
      expect(response.body.templates).toHaveLength(1);
    });
  });

  describe('GET /api/cos/templates/popular', () => {
    it('should return popular templates with default limit', async () => {
      taskTemplates.getPopularTemplates.mockResolvedValue([{ id: 't1', useCount: 10 }]);

      const response = await request(app).get('/api/cos/templates/popular');

      expect(response.status).toBe(200);
      expect(taskTemplates.getPopularTemplates).toHaveBeenCalledWith(5);
    });

    it('should respect custom limit', async () => {
      taskTemplates.getPopularTemplates.mockResolvedValue([]);

      const response = await request(app).get('/api/cos/templates/popular?limit=3');

      expect(response.status).toBe(200);
      expect(taskTemplates.getPopularTemplates).toHaveBeenCalledWith(3);
    });
  });

  describe('GET /api/cos/templates/categories', () => {
    it('should return template categories', async () => {
      taskTemplates.getCategories.mockResolvedValue(['bugs', 'features']);

      const response = await request(app).get('/api/cos/templates/categories');

      expect(response.status).toBe(200);
      expect(response.body.categories).toEqual(['bugs', 'features']);
    });
  });

  describe('POST /api/cos/templates', () => {
    it('should create a new template', async () => {
      const templateData = { name: 'Fix Bug', description: 'Fix a bug in the app', category: 'bugs' };
      taskTemplates.createTemplate.mockResolvedValue({ id: 't1', ...templateData });

      const response = await request(app)
        .post('/api/cos/templates')
        .send(templateData);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.template.name).toBe('Fix Bug');
    });

    it('should return 400 if name is missing', async () => {
      const response = await request(app)
        .post('/api/cos/templates')
        .send({ description: 'No name' });

      expect(response.status).toBe(400);
    });

    it('should return 400 if description is missing', async () => {
      const response = await request(app)
        .post('/api/cos/templates')
        .send({ name: 'No description' });

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/cos/templates/from-task', () => {
    it('should create template from task', async () => {
      taskTemplates.createTemplateFromTask.mockResolvedValue({ id: 't2', name: 'From Task' });

      const response = await request(app)
        .post('/api/cos/templates/from-task')
        .send({ task: { description: 'Fix login' }, templateName: 'Login Fix' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 400 if task is missing', async () => {
      const response = await request(app)
        .post('/api/cos/templates/from-task')
        .send({});

      expect(response.status).toBe(400);
    });

    it('should return 400 if task has no description', async () => {
      const response = await request(app)
        .post('/api/cos/templates/from-task')
        .send({ task: {} });

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/cos/templates/:id/use', () => {
    it('should record template usage', async () => {
      taskTemplates.recordTemplateUsage.mockResolvedValue(5);

      const response = await request(app).post('/api/cos/templates/t1/use');

      expect(response.status).toBe(200);
      expect(response.body.useCount).toBe(5);
      expect(taskTemplates.recordTemplateUsage).toHaveBeenCalledWith('t1');
    });
  });

  describe('PUT /api/cos/templates/:id', () => {
    it('should update a template', async () => {
      taskTemplates.updateTemplate.mockResolvedValue({ id: 't1', name: 'Updated' });

      const response = await request(app)
        .put('/api/cos/templates/t1')
        .send({ name: 'Updated' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 400 on update error', async () => {
      taskTemplates.updateTemplate.mockResolvedValue({ error: 'Template not found' });

      const response = await request(app)
        .put('/api/cos/templates/t999')
        .send({ name: 'Fail' });

      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /api/cos/templates/:id', () => {
    it('should delete a template', async () => {
      taskTemplates.deleteTemplate.mockResolvedValue({ success: true });

      const response = await request(app).delete('/api/cos/templates/t1');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 400 on delete error', async () => {
      taskTemplates.deleteTemplate.mockResolvedValue({ error: 'Template not found' });

      const response = await request(app).delete('/api/cos/templates/t999');

      expect(response.status).toBe(400);
    });
  });
});
