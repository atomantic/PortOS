import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/moltworldWs.js', () => ({
  connect: vi.fn(), disconnect: vi.fn(), getStatus: vi.fn(),
  sendMove: vi.fn(), sendThink: vi.fn(), sendNearby: vi.fn(), sendInteract: vi.fn(),
}));

import * as moltworldWs from '../services/moltworldWs.js';
import moltworldWsRoutes from './moltworldWs.js';

const app = express();
app.use(express.json());
app.use('/api/agents/tools/moltworld/ws', moltworldWsRoutes);
app.use(errorMiddleware);
const BASE = '/api/agents/tools/moltworld/ws';

beforeEach(() => {
  vi.clearAllMocks();
  moltworldWs.getStatus.mockReturnValue({ status: 'connected' });
});

describe('/api/agents/tools/moltworld/ws', () => {
  it('connects the relay for an account and reports the resulting state', async () => {
    const res = await request(app).post(`${BASE}/connect`).send({ accountId: 'acct-1' });
    expect(res.body).toEqual({ status: 'connected' });
    expect(moltworldWs.connect).toHaveBeenCalledWith('acct-1');
  });

  it('surfaces a failed connect as an error, not a connected status', async () => {
    moltworldWs.connect.mockRejectedValue(new Error('Account not found'));
    const res = await request(app).post(`${BASE}/connect`).send({ accountId: 'acct-1' });
    expect(res.status).toBe(500);
  });

  it('relays a move inside the world bounds and refuses one outside them', async () => {
    const ok = await request(app).post(`${BASE}/move`).send({ x: 10, y: -10, thought: 'walking' });
    expect(ok.body).toEqual({ sent: true });
    expect(moltworldWs.sendMove).toHaveBeenCalledWith(10, -10, 'walking');

    moltworldWs.sendMove.mockClear();
    expect((await request(app).post(`${BASE}/move`).send({ x: 241, y: 0 })).status).toBe(400);
    expect(moltworldWs.sendMove).not.toHaveBeenCalled();
  });

  it('defaults an interaction payload to an empty object', async () => {
    await request(app).post(`${BASE}/interact`).send({ to: 'agent-2' });
    expect(moltworldWs.sendInteract).toHaveBeenCalledWith('agent-2', {});
  });
});
