import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import systemHealthRoutes from './systemHealth.js';

describe('System Health Routes', () => {
  const app = express();
  app.use('/api/system', systemHealthRoutes);

  it('should return health status', async () => {
    const response = await request(app).get('/api/system/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.version).toBeDefined();
  });
});
