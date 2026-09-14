import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const auditModelPins = vi.hoisted(() => vi.fn());
const clearModelPin = vi.hoisted(() => vi.fn());
vi.mock('../services/modelPinAudit.js', () => ({ auditModelPins, clearModelPin }));

const { createPortOSProviderRoutes } = await import('./providers.js');

const app = () => {
  const toolkit = { services: { providers: {} }, routes: { providers: Router() } };
  const instance = express();
  instance.use(express.json());
  instance.use('/api/providers', createPortOSProviderRoutes(toolkit));
  instance.use(errorMiddleware);
  return instance;
};

beforeEach(() => vi.clearAllMocks());

describe('GET /model-pins', () => {
  it('serves the audit, and is not swallowed by the /:id provider route', async () => {
    // The literal path is registered BEFORE '/:id'; registered after, this would
    // 404 as "no provider named model-pins".
    auditModelPins.mockResolvedValue({ pins: [{ id: 'settings:imageGen.agy.model' }], providers: {} });

    const res = await request(app()).get('/api/providers/model-pins');

    expect(res.status).toBe(200);
    expect(res.body.pins).toEqual([{ id: 'settings:imageGen.agy.model' }]);
  });
});

describe('POST /model-pins/clear', () => {
  it('clears the named pin', async () => {
    clearModelPin.mockResolvedValue({ cleared: true, id: 'task:audit' });

    const res = await request(app()).post('/api/providers/model-pins/clear').send({ pinId: 'task:audit' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleared: true, id: 'task:audit' });
    expect(clearModelPin).toHaveBeenCalledWith('task:audit');
  });

  it('rejects a body with no pin id before reaching the service', async () => {
    const res = await request(app()).post('/api/providers/model-pins/clear').send({});

    expect(res.status).toBe(400);
    expect(clearModelPin).not.toHaveBeenCalled();
  });

});
