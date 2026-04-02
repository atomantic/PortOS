import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import toolsRoutes from './tools.js';

vi.mock('../services/tools.js', () => ({
  getTools: vi.fn(),
  getEnabledTools: vi.fn(),
  getTool: vi.fn(),
  registerTool: vi.fn(),
  updateTool: vi.fn(),
  deleteTool: vi.fn(),
  getToolsSummaryForPrompt: vi.fn()
}));

import * as toolsService from '../services/tools.js';

describe('Tools Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/tools', toolsRoutes);
    vi.clearAllMocks();
  });

  describe('GET /api/tools', () => {
    it('should return all tools', async () => {
      toolsService.getTools.mockResolvedValue([
        { id: 'sd-api', name: 'Stable Diffusion' }
      ]);

      const response = await request(app).get('/api/tools');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].id).toBe('sd-api');
    });
  });

  describe('GET /api/tools/enabled', () => {
    it('should return only enabled tools', async () => {
      toolsService.getEnabledTools.mockResolvedValue([
        { id: 'sd-api', name: 'Stable Diffusion', enabled: true }
      ]);

      const response = await request(app).get('/api/tools/enabled');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
    });
  });

  describe('GET /api/tools/summary', () => {
    it('should return prompt summary', async () => {
      toolsService.getToolsSummaryForPrompt.mockResolvedValue('## Available Tools\n...');

      const response = await request(app).get('/api/tools/summary');

      expect(response.status).toBe(200);
      expect(response.body.summary).toContain('Available Tools');
    });
  });

  describe('GET /api/tools/:id', () => {
    it('should return a tool by id', async () => {
      toolsService.getTool.mockResolvedValue({ id: 'sd-api', name: 'Stable Diffusion' });

      const response = await request(app).get('/api/tools/sd-api');

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Stable Diffusion');
    });

    it('should return 404 if not found', async () => {
      toolsService.getTool.mockResolvedValue(null);

      const response = await request(app).get('/api/tools/nonexistent');

      expect(response.status).toBe(404);
    });

    it('should reject path traversal in id', async () => {
      const response = await request(app).get('/api/tools/..%2F..%2Fetc');

      expect(response.status).toBe(400);
      expect(toolsService.getTool).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/tools', () => {
    it('should register a new tool', async () => {
      const toolData = {
        id: 'sd-api',
        name: 'Stable Diffusion',
        category: 'image-generation',
        description: 'SD API tool'
      };
      toolsService.registerTool.mockResolvedValue({ ...toolData, createdAt: '2026-01-01' });

      const response = await request(app)
        .post('/api/tools')
        .send(toolData);

      expect(response.status).toBe(201);
      expect(toolsService.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'Stable Diffusion' }));
    });

    it('should return 400 if name is missing', async () => {
      const response = await request(app)
        .post('/api/tools')
        .send({ category: 'test' });

      expect(response.status).toBe(400);
    });

    it('should reject path traversal in body id', async () => {
      const response = await request(app)
        .post('/api/tools')
        .send({ id: '../etc/passwd', name: 'Bad', category: 'test' });

      expect(response.status).toBe(400);
      expect(toolsService.registerTool).not.toHaveBeenCalled();
    });
  });

  describe('PUT /api/tools/:id', () => {
    it('should update an existing tool', async () => {
      toolsService.updateTool.mockResolvedValue({ id: 'sd-api', name: 'Updated SD', category: 'image-generation' });

      const response = await request(app)
        .put('/api/tools/sd-api')
        .send({ name: 'Updated SD' });

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Updated SD');
    });

    it('should return 404 if not found', async () => {
      toolsService.updateTool.mockResolvedValue(null);

      const response = await request(app)
        .put('/api/tools/nonexistent')
        .send({ name: 'Test' });

      expect(response.status).toBe(404);
    });

    it('should reject path traversal in id', async () => {
      const response = await request(app)
        .put('/api/tools/..%2Fhack')
        .send({ name: 'Test' });

      expect(response.status).toBe(400);
      expect(toolsService.updateTool).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/tools/:id', () => {
    it('should delete a tool', async () => {
      toolsService.deleteTool.mockResolvedValue(undefined);

      const response = await request(app).delete('/api/tools/sd-api');

      expect(response.status).toBe(204);
      expect(toolsService.deleteTool).toHaveBeenCalledWith('sd-api');
    });

    it('should reject path traversal in id', async () => {
      const response = await request(app).delete('/api/tools/..%2Fhack');

      expect(response.status).toBe(400);
      expect(toolsService.deleteTool).not.toHaveBeenCalled();
    });
  });
});
