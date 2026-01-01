import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import healthRoutes from './health.js';

describe('Health Routes', () => {
  const app = express();
  app.use('/api', healthRoutes);

  it('should return health status', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.version).toBeDefined();
  });
});
