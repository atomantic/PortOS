/**
 * HTTP boundary for the durable provider connection graph (#6367).
 *
 * The graph service is doubled here on purpose: what this file owns is the
 * boundary contract a client depends on — that the durable endpoint answers in
 * the same version-1 shape as the #6366 preview, that an install without a
 * database gets an EXPLICIT unsupported answer rather than an empty graph, that
 * link/unlink bodies are Zod-validated before any row is touched, and that the
 * flat provider API a downgraded or older client uses is unchanged.
 *
 * Fixtures are synthetic. Nothing here is read out of a running install.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware, ServerError } from '../lib/errorHandler.js';

const graph = {
  getManagementGraph: vi.fn(),
  previewBindingLink: vi.fn(),
  linkBinding: vi.fn(),
  unlinkBinding: vi.fn(),
  removeConnection: vi.fn(),
};
vi.mock('../services/providerGraph.js', () => graph);

const { createPortOSProviderRoutes } = await import('./providers.js');

const BINDING = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

const PROVIDERS = {
  activeProvider: 'claude-ollama',
  providers: [
    { id: 'claude-ollama', name: 'Claude', type: 'cli', command: 'claude', enabled: true, models: [] },
  ],
};

function app(providerService = { getAllProviders: vi.fn().mockResolvedValue(PROVIDERS) }) {
  const toolkit = { services: { providers: providerService }, routes: { providers: Router() } };
  const server = express();
  server.use(express.json());
  server.use('/api/providers', createPortOSProviderRoutes(toolkit));
  server.use(errorMiddleware);
  return server;
}

afterEach(() => vi.clearAllMocks());

describe('GET /api/providers/management', () => {
  it('serves the durable graph and never caches it', async () => {
    graph.getManagementGraph.mockResolvedValue({
      schemaVersion: 1, activeProvider: 'claude-ollama', connections: [], bindings: [], routes: [],
    });

    const res = await request(app()).get('/api/providers/management');
    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe(1);
    // A configuration graph read from a cache is a graph that lies after a save.
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers an install without a database EXPLICITLY, not with an empty graph', async () => {
    // An empty graph and an unavailable one must never look the same to a
    // client: one means "nothing configured", the other means "fall back to the
    // flat list".
    graph.getManagementGraph.mockRejectedValue(
      new ServerError('unavailable', { status: 503, code: 'PROVIDER_GRAPH_UNAVAILABLE' }));

    const res = await request(app()).get('/api/providers/management');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PROVIDER_GRAPH_UNAVAILABLE');
  });

  it('leaves the flat provider API unchanged for an older client', async () => {
    const res = await request(app()).get('/api/providers');
    expect(res.status).toBe(200);
    expect(res.body.activeProvider).toBe('claude-ollama');
    expect(res.body.providers.map((provider) => provider.id)).toEqual(['claude-ollama']);
    expect(graph.getManagementGraph).not.toHaveBeenCalled();
  });
});

describe('POST /api/providers/bindings/:id/link', () => {
  it('previews without applying', async () => {
    graph.previewBindingLink.mockResolvedValue({ bindingId: BINDING, affectedRouteIds: ['claude-ollama'] });

    const res = await request(app())
      .post(`/api/providers/bindings/${BINDING}/link/preview`)
      .send({ targetConnectionId: TARGET });

    expect(res.status).toBe(200);
    expect(graph.previewBindingLink).toHaveBeenCalledWith({
      bindingId: BINDING, targetConnectionId: TARGET, expectedRevisions: {},
    });
    expect(graph.linkBinding).not.toHaveBeenCalled();
  });

  it('passes the reviewed revisions through to the service', async () => {
    graph.linkBinding.mockResolvedValue({ bindingId: BINDING, connectionId: TARGET, affectedRouteIds: [] });
    const expectedRevisions = { binding: 2, sourceConnection: 3, targetConnection: 4 };

    const res = await request(app())
      .post(`/api/providers/bindings/${BINDING}/link`)
      .send({ targetConnectionId: TARGET, expectedRevisions });

    expect(res.status).toBe(200);
    expect(graph.linkBinding).toHaveBeenCalledWith({ bindingId: BINDING, targetConnectionId: TARGET, expectedRevisions });
  });

  it('surfaces a stale-revision refusal as a 409 rather than applying it', async () => {
    graph.linkBinding.mockRejectedValue(
      new ServerError('stale', { status: 409, code: 'PROVIDER_GRAPH_STALE_REVISION' }));

    const res = await request(app())
      .post(`/api/providers/bindings/${BINDING}/link`)
      .send({ targetConnectionId: TARGET, expectedRevisions: { binding: 1 } });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROVIDER_GRAPH_STALE_REVISION');
  });

  it.each([
    ['a missing target', {}],
    ['a non-uuid target', { targetConnectionId: 'not-a-uuid' }],
    ['an unknown field', { targetConnectionId: TARGET, mergeCredentials: true }],
  ])('rejects %s before the service is reached', async (_label, body) => {
    const res = await request(app()).post(`/api/providers/bindings/${BINDING}/link`).send(body);
    expect(res.status).toBe(400);
    expect(graph.linkBinding).not.toHaveBeenCalled();
  });
});

describe('POST /api/providers/bindings/:id/unlink', () => {
  it('takes no target connection and forwards the binding', async () => {
    graph.unlinkBinding.mockResolvedValue({ bindingId: BINDING, connectionId: TARGET });

    const res = await request(app())
      .post(`/api/providers/bindings/${BINDING}/unlink`)
      .send({ expectedRevisions: { binding: 1, sourceConnection: 1 } });

    expect(res.status).toBe(200);
    expect(graph.unlinkBinding).toHaveBeenCalledWith({
      bindingId: BINDING, expectedRevisions: { binding: 1, sourceConnection: 1 },
    });
  });

  it('rejects a body that names a target — unlink never repoints', async () => {
    const res = await request(app())
      .post(`/api/providers/bindings/${BINDING}/unlink`)
      .send({ targetConnectionId: TARGET });
    expect(res.status).toBe(400);
    expect(graph.unlinkBinding).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/providers/connections/:id', () => {
  it('forwards the id and returns the service verdict', async () => {
    graph.removeConnection.mockResolvedValue({ deleted: true });
    const res = await request(app()).delete(`/api/providers/connections/${TARGET}`);
    expect(res.status).toBe(200);
    expect(graph.removeConnection).toHaveBeenCalledWith(TARGET);
  });

  it('surfaces an in-use refusal as a 409', async () => {
    graph.removeConnection.mockRejectedValue(
      new ServerError('in use', { status: 409, code: 'PROVIDER_GRAPH_CONNECTION_IN_USE' }));
    const res = await request(app()).delete(`/api/providers/connections/${TARGET}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROVIDER_GRAPH_CONNECTION_IN_USE');
  });
});
