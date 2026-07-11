import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/workflow.js', () => ({
  getWorkflowGraph: vi.fn(),
  WORKFLOW_STAGES: [
    { id: 'plan', label: 'Plan', description: 'Plan stage', taskTypes: ['do-replan'], jobIds: [] },
    { id: 'build', label: 'Build', description: 'Build stage', taskTypes: ['feature-ideas'], jobIds: [] }
  ]
}));

import workflowRoutes from './cosWorkflowRoutes.js';
import * as workflow from '../services/workflow.js';

describe('CoS Workflow Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/cos', workflowRoutes);
    vi.clearAllMocks();
  });

  describe('GET /api/cos/workflow', () => {
    it('returns the workflow graph', async () => {
      workflow.getWorkflowGraph.mockResolvedValue({
        generatedAt: '2026-05-09T00:00:00.000Z',
        stages: [{ id: 'plan', nodeCount: 1, enabledCount: 1 }],
        nodes: [{ id: 'task:do-replan', stage: 'plan' }],
        edges: []
      });

      const response = await request(app).get('/api/cos/workflow');
      expect(response.status).toBe(200);
      expect(response.body.nodes).toHaveLength(1);
      expect(response.body.nodes[0].id).toBe('task:do-replan');
    });

    it('surfaces workflow service errors as 500', async () => {
      workflow.getWorkflowGraph.mockRejectedValue(new Error('boom'));
      const response = await request(app).get('/api/cos/workflow');
      expect(response.status).toBe(500);
    });

    it('accepts the supported seven-day projection horizon', async () => {
      workflow.getWorkflowGraph.mockResolvedValue({ nodes: [], stages: [], edges: [] });
      await request(app).get('/api/cos/workflow?hours=168');
      expect(workflow.getWorkflowGraph).toHaveBeenCalledWith({ horizonHours: 168 });
    });

    it('falls back to 24 hours for unsupported horizons', async () => {
      workflow.getWorkflowGraph.mockResolvedValue({ nodes: [], stages: [], edges: [] });
      await request(app).get('/api/cos/workflow?hours=999');
      expect(workflow.getWorkflowGraph).toHaveBeenCalledWith({ horizonHours: 24 });
    });
  });

  describe('GET /api/cos/workflow/stages', () => {
    it('returns the canonical stage list', async () => {
      const response = await request(app).get('/api/cos/workflow/stages');
      expect(response.status).toBe(200);
      expect(response.body.stages.map(s => s.id)).toEqual(['plan', 'build']);
    });
  });
});
