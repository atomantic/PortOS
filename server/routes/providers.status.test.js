import { describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';
import { createPortOSProviderRoutes } from './providers.js';

describe('PortOS provider status routes', () => {
  it('returns normalized API-window metadata without raw headers', async () => {
    const toolkit = {
      services: {
        providers: {},
        providerStatus: {
          getAllStatuses: () => ({
            providers: {
              example: {
                available: false,
                reason: 'rate-limit',
                rateLimitWindow: {
                  observedAt: '2026-08-26T12:00:00.000Z',
                  remaining: 0,
                  limit: 100,
                  rawHeaders: { authorization: 'secret-value' },
                },
              },
            },
          }),
          getTimeUntilRecovery: () => '1m',
        },
      },
      routes: { providers: Router() },
    };
    const app = express();
    app.use('/api/providers', createPortOSProviderRoutes(toolkit));
    app.use(errorMiddleware);

    const response = await request(app).get('/api/providers/status');

    expect(response.status).toBe(200);
    expect(response.body.providers.example.rateLimitWindow).toEqual({
      observedAt: '2026-08-26T12:00:00.000Z',
      remaining: 0,
      limit: 100,
    });
    expect(JSON.stringify(response.body)).not.toContain('headers');
    expect(JSON.stringify(response.body)).not.toContain('secret-value');
  });

  it('recovers the toolkit status instance used by run routing', async () => {
    const markAvailable = vi.fn(async () => ({ available: true, reason: 'ok' }));
    const toolkit = {
      services: {
        providers: {},
        providerStatus: { markAvailable }
      },
      routes: { providers: Router() }
    };
    const app = express();
    app.use(express.json());
    app.use('/api/providers', createPortOSProviderRoutes(toolkit));
    app.use(errorMiddleware);

    const response = await request(app).post('/api/providers/example-provider/status/recover');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      status: { available: true, reason: 'ok' }
    });
    expect(markAvailable).toHaveBeenCalledWith('example-provider');
  });
});
