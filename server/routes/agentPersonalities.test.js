import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

const agentPersonalities = vi.hoisted(() => ({
  getAgentsByUser: vi.fn(),
  getAllAgents: vi.fn(),
  getAgentById: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  toggleAgent: vi.fn(),
}));

const generateAgentPersonality = vi.hoisted(() => vi.fn());
const logAction = vi.hoisted(() => vi.fn());

vi.mock('../services/agentPersonalities.js', () => agentPersonalities);
vi.mock('../services/agentPersonalityGenerator.js', () => ({ generateAgentPersonality }));
vi.mock('../services/history.js', () => ({ logAction }));

import agentPersonalitiesRoutes from './agentPersonalities.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agents/personalities', agentPersonalitiesRoutes);
  return app;
};

const expectValidationError = (response) => {
  expect(response.status).toBe(400);
  expect(response.body.code).toBe('VALIDATION_ERROR');
  expect(response.body).toHaveProperty('timestamp');
};

describe('Agent Personalities Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('POST /generate', () => {
    it.each([
      ['null seed', { seed: null }],
      ['null personality', { seed: { personality: null } }],
      ['non-string name', { seed: { name: 123 } }],
      ['unknown top-level field', { unexpected: true }],
    ])('returns 400 for %s without calling the generator', async (_label, body) => {
      const response = await request(makeApp())
        .post('/api/agents/personalities/generate')
        .send(body);

      expectValidationError(response);
      expect(generateAgentPersonality).not.toHaveBeenCalled();
    });

    it.each([
      ['name', { name: 'x'.repeat(101) }],
      ['description', { description: 'x'.repeat(1001) }],
      ['personality tone', { personality: { style: 'casual', tone: 'x'.repeat(501) } }],
      ['personality topic', { personality: { style: 'casual', topics: ['x'.repeat(101)] } }],
      ['personality quirk', { personality: { style: 'casual', quirks: ['x'.repeat(201)] } }],
      ['personality prompt prefix', { personality: { style: 'casual', promptPrefix: 'x'.repeat(2001) } }],
    ])('returns 400 when the %s seed text exceeds its persisted limit', async (_label, seed) => {
      const response = await request(makeApp())
        .post('/api/agents/personalities/generate')
        .send({ seed });

      expectValidationError(response);
      expect(generateAgentPersonality).not.toHaveBeenCalled();
    });

    it.each([
      ['empty providerId', { providerId: '' }],
      ['oversized providerId', { providerId: 'p'.repeat(129) }],
      ['oversized model', { model: 'm'.repeat(301) }],
    ])('returns 400 for %s without calling the generator', async (_label, body) => {
      const response = await request(makeApp())
        .post('/api/agents/personalities/generate')
        .send(body);

      expectValidationError(response);
      expect(generateAgentPersonality).not.toHaveBeenCalled();
    });

    it('passes a validated seed and provider hints to the generator', async () => {
      generateAgentPersonality.mockResolvedValue({ name: 'Generated Agent' });

      const response = await request(makeApp())
        .post('/api/agents/personalities/generate')
        .send({
          seed: {
            name: 'Ada',
            description: 'A careful guide',
            personality: { style: 'casual' },
            avatar: { emoji: '🧭' },
          },
          providerId: null,
          model: null,
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ name: 'Generated Agent' });
      expect(generateAgentPersonality).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Ada',
          description: 'A careful guide',
          personality: expect.objectContaining({ style: 'casual' }),
          avatar: { emoji: '🧭' },
        }),
        null,
        null,
      );
    });

    it('defaults an omitted seed to an empty object', async () => {
      generateAgentPersonality.mockResolvedValue({ name: 'Generated Agent' });

      const response = await request(makeApp())
        .post('/api/agents/personalities/generate')
        .send({});

      expect(response.status).toBe(200);
      expect(generateAgentPersonality).toHaveBeenCalledWith({}, undefined, undefined);
    });
  });

  describe('POST /:id/toggle', () => {
    it.each([
      ['missing enabled', {}],
      ['string enabled', { enabled: 'false' }],
      ['numeric enabled', { enabled: 1 }],
      ['null enabled', { enabled: null }],
    ])('returns 400 for %s without changing the agent', async (_label, body) => {
      const response = await request(makeApp())
        .post('/api/agents/personalities/agent-1/toggle')
        .send(body);

      expectValidationError(response);
      expect(agentPersonalities.toggleAgent).not.toHaveBeenCalled();
    });

    it('passes a real boolean to the service', async () => {
      const agent = { id: 'agent-1', enabled: false };
      agentPersonalities.toggleAgent.mockResolvedValue(agent);

      const response = await request(makeApp())
        .post('/api/agents/personalities/agent-1/toggle')
        .send({ enabled: false });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(agent);
      expect(agentPersonalities.toggleAgent).toHaveBeenCalledWith('agent-1', false);
      expect(logAction).toHaveBeenCalledWith(
        'toggle',
        'agent-personality',
        'agent-1',
        { enabled: false },
      );
    });
  });
});
