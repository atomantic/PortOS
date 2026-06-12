import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

// Drive the docs route off a controllable settings mock so we can flip exposure.
let store = {};
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ ...store })),
}));

import apiDocsRoutes from './apiDocs.js';

const buildApp = () => {
  const app = express();
  app.use('/api/api-docs', apiDocsRoutes);
  return app;
};

describe('GET /api/api-docs/openapi.json', () => {
  beforeEach(() => { store = {}; });

  it('returns an empty-paths 3.1 spec when nothing exposed', async () => {
    const res = await request(buildApp()).get('/api/api-docs/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths)).toHaveLength(0);
    expect(res.body.info.version).not.toBe('0.0.0'); // real package.json version
  });

  it('documents voice paths once exposed', async () => {
    store = { apiAccess: { voice: { exposed: true, requireAuth: false } } };
    const res = await request(buildApp()).get('/api/api-docs/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.paths['/api/voice/public/synthesize']).toBeDefined();
    expect(res.body.paths['/api/voice/public/synthesize'].post.security).toEqual([]);
  });

  it('derives the server URL from the request Host header', async () => {
    store = { apiAccess: { voice: { exposed: true, requireAuth: false } } };
    const res = await request(buildApp()).get('/api/api-docs/openapi.json');
    expect(res.body.servers[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
