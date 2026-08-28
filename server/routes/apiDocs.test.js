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

  it('returns an empty-paths 3.0.3 spec when nothing exposed', async () => {
    const res = await request(buildApp()).get('/api/api-docs/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.0.3');
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

  it('serves the complete internal spec independently of public exposure', async () => {
    const res = await request(buildApp()).get('/api/api-docs/internal/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.paths['/api/cos/mind/tools'].get).toBeDefined();
    expect(Object.keys(res.body.paths).length).toBeGreaterThan(1000);
  });

  it('serves searchable catalog metadata and registry cards', async () => {
    const res = await request(buildApp()).get('/api/api-docs/catalog.json');
    expect(res.status).toBe(200);
    expect(res.body.stats.operations).toBeGreaterThan(2000);
    expect(res.body.operations[0].contractStatus).toMatch(/modeled|generated/);
    expect(res.body.externallyExposableApis.map((entry) => entry.id)).toEqual(['voice', 'sdapi']);
  });

  it('serves the generated Socket.IO catalog and AsyncAPI 3 document', async () => {
    const events = await request(buildApp()).get('/api/api-docs/events.json');
    expect(events.status).toBe(200);
    expect(events.body.stats.events).toBeGreaterThan(100);
    expect(events.body.events.some((event) => event.event === 'cos:mind:event')).toBe(true);

    const asyncapi = await request(buildApp()).get('/api/api-docs/asyncapi.json');
    expect(asyncapi.status).toBe(200);
    expect(asyncapi.body.asyncapi).toBe('3.0.0');
    expect(Object.values(asyncapi.body.channels).some((channel) => channel.address === 'shell:start')).toBe(true);
  });

  it('serves the minimized semantic tool resource', async () => {
    const res = await request(buildApp()).get('/api/api-docs/tools.min.json');
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('portos_tool_resource');
    expect(res.body.source.version).toBe('3.0.3');
    expect(res.body.tools).toHaveLength(8);
    expect(res.body.errors.some((error) => error.code === 'VALIDATION_ERROR')).toBe(true);
  });
});
