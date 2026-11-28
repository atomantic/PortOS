import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/featureAgents.js', () => ({
  getAllFeatureAgents: vi.fn(),
  getFeatureAgent: vi.fn(),
  getFeatureAgentRuns: vi.fn(),
  createFeatureAgent: vi.fn(),
  updateFeatureAgent: vi.fn(),
  deleteFeatureAgent: vi.fn(),
  activateFeatureAgent: vi.fn(),
  pauseFeatureAgent: vi.fn(),
  resumeFeatureAgent: vi.fn(),
  triggerFeatureAgent: vi.fn(),
  stopFeatureAgent: vi.fn(),
  getFeatureAgentOutput: vi.fn(),
}));

import * as featureAgents from '../services/featureAgents.js';
import featureAgentRoutes from './featureAgents.js';

const app = express();
app.use(express.json());
const base = '/api/feature-agents';
app.use(base, featureAgentRoutes);
app.use(errorMiddleware);

const agent = { id: 'agent-1', name: 'Example agent' };
const agentUrl = `${base}/${agent.id}`;

beforeEach(() => vi.resetAllMocks());

describe('Feature agent reads', () => {
  it('lists feature agents', async () => {
    featureAgents.getAllFeatureAgents.mockResolvedValue([agent]);
    const res = await request(app).get(base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([agent]);
  });

  it('includes the five most recent runs in the agent detail', async () => {
    const recentRuns = [{ id: 'run-1' }];
    featureAgents.getFeatureAgent.mockResolvedValue(agent);
    featureAgents.getFeatureAgentRuns.mockResolvedValue(recentRuns);
    const res = await request(app).get(agentUrl);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...agent, recentRuns });
    expect(featureAgents.getFeatureAgent).toHaveBeenCalledWith(agent.id);
    expect(featureAgents.getFeatureAgentRuns).toHaveBeenCalledWith(agent.id, 5);
  });

  it('returns 404 for a missing agent without reading its runs', async () => {
    featureAgents.getFeatureAgent.mockResolvedValue(null);
    const res = await request(app).get(agentUrl);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(featureAgents.getFeatureAgentRuns).not.toHaveBeenCalled();
  });

  it.each([
    { stored: { agentId: agent.id, output: 'Example output' }, expected: { agentId: agent.id, output: 'Example output' } },
    { stored: null, expected: { agentId: null, output: '' } },
  ])('returns the output contract for stored output $stored', async ({ stored, expected }) => {
    featureAgents.getFeatureAgentOutput.mockResolvedValue(stored);
    const res = await request(app).get(`${agentUrl}/output`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expected);
    expect(featureAgents.getFeatureAgentOutput).toHaveBeenCalledWith(agent.id);
  });
});

describe('Feature agent mutations', () => {
  it('creates an agent with a default schedule and returns 201', async () => {
    const input = { name: agent.name, description: 'Example description', appId: 'app-1' };
    featureAgents.createFeatureAgent.mockResolvedValue(agent);
    const res = await request(app).post(base).send(input);
    expect(res.status).toBe(201);
    expect(res.body).toEqual(agent);
    expect(featureAgents.createFeatureAgent).toHaveBeenCalledWith(expect.objectContaining({
      ...input,
      schedule: { mode: 'continuous', pauseBetweenRunsMs: 60000 },
    }));
  });

  it('rejects a create request missing required fields before creating an agent', async () => {
    const res = await request(app).post(base).send({ name: agent.name });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(featureAgents.createFeatureAgent).not.toHaveBeenCalled();
  });

  it('applies a partial update without adding create defaults', async () => {
    const patch = { name: 'Updated agent' };
    const updated = { ...agent, ...patch };
    featureAgents.updateFeatureAgent.mockResolvedValue(updated);
    const res = await request(app).put(agentUrl).send(patch);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(updated);
    expect(featureAgents.updateFeatureAgent).toHaveBeenCalledWith(agent.id, patch);
  });

  it('rejects an invalid update before writing', async () => {
    const res = await request(app).put(agentUrl).send({ schedule: { intervalMs: 10 } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(featureAgents.updateFeatureAgent).not.toHaveBeenCalled();
  });

  it('returns 404 when the agent to update is missing', async () => {
    featureAgents.updateFeatureAgent.mockResolvedValue(null);
    const res = await request(app).put(agentUrl).send({ name: 'Updated agent' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('returns an empty 204 after deletion', async () => {
    featureAgents.deleteFeatureAgent.mockResolvedValue(true);
    const res = await request(app).delete(agentUrl);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(featureAgents.deleteFeatureAgent).toHaveBeenCalledWith(agent.id);
  });

  it('returns 404 when the agent to delete is missing', async () => {
    featureAgents.deleteFeatureAgent.mockResolvedValue(false);
    const res = await request(app).delete(agentUrl);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe.each([
  { action: 'start', operation: featureAgents.activateFeatureAgent, result: { ...agent, status: 'active' } },
  { action: 'pause', operation: featureAgents.pauseFeatureAgent, result: { ...agent, status: 'paused' } },
  { action: 'resume', operation: featureAgents.resumeFeatureAgent, result: { ...agent, status: 'active' } },
  { action: 'trigger', operation: featureAgents.triggerFeatureAgent, result: { triggered: true } },
  { action: 'stop', operation: featureAgents.stopFeatureAgent, result: { ...agent, status: 'stopped' } },
])('POST /api/feature-agents/:id/$action', ({ action, operation, result }) => {
  it('dispatches the action for the requested agent and returns the result', async () => {
    operation.mockResolvedValue(result);
    const res = await request(app).post(`${agentUrl}/${action}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(operation).toHaveBeenCalledExactlyOnceWith(agent.id);
  });

  it('returns 404 for a missing agent', async () => {
    operation.mockResolvedValue(null);
    const res = await request(app).post(`${agentUrl}/${action}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/feature-agents/:id/runs', () => {
  it('400s on a repeated limit key and never reads runs', async () => {
    const res = await request(app).get(`${agentUrl}/runs?limit=1&limit=2`);
    expect(res.status).toBe(400);
    expect(featureAgents.getFeatureAgentRuns).not.toHaveBeenCalled();
  });

  it('defaults the limit to 20 and clamps to 500', async () => {
    featureAgents.getFeatureAgentRuns.mockResolvedValue([]);
    await request(app).get(`${agentUrl}/runs`);
    expect(featureAgents.getFeatureAgentRuns).toHaveBeenLastCalledWith('agent-1', 20);
    await request(app).get(`${agentUrl}/runs?limit=9999`);
    expect(featureAgents.getFeatureAgentRuns).toHaveBeenLastCalledWith('agent-1', 500);
  });
});
