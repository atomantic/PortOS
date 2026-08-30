import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const mocks = vi.hoisted(() => ({
  getAgentContextManifest: vi.fn(),
  callAgentContextTool: vi.fn(),
}));

vi.mock('../services/agentContextMcp.js', () => ({
  getAgentContextManifest: mocks.getAgentContextManifest,
  callAgentContextTool: mocks.callAgentContextTool,
}));

import agentContextMcpRoutes, { isAllowedAgentContextOrigin, isLoopbackAddress } from './agentContextMcp.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent-context', agentContextMcpRoutes);
  app.use(errorMiddleware);
  return app;
};

const enabledManifest = {
  enabled: true,
  configurationValid: true,
  profile: 'metadata',
  scopes: ['navigation', 'workspaces'],
  actions: { readPortos: false, writePortos: false, manageEidoverse: false },
  tools: [{ name: 'context_profile', inputSchema: { type: 'object' } }],
};

const mcpPost = (body) => request(buildApp())
  .post('/api/agent-context/mcp')
  .set('Accept', 'application/json, text/event-stream')
  .send(body);

describe('agentContextMcp route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAgentContextManifest.mockResolvedValue(enabledManifest);
    mocks.callAgentContextTool.mockResolvedValue({ content: [{ type: 'text', text: '{}' }], structuredContent: {} });
  });

  it('recognizes loopback addresses and origins only', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('127.0.0.999')).toBe(false);
    expect(isLoopbackAddress('192.0.2.10')).toBe(false);
    expect(isAllowedAgentContextOrigin('http://localhost:5555')).toBe(true);
    expect(isAllowedAgentContextOrigin('https://example.com')).toBe(false);
  });

  it('serves a local manifest even while context is disabled', async () => {
    mocks.getAgentContextManifest.mockResolvedValue({ ...enabledManifest, enabled: false });
    const response = await request(buildApp()).get('/api/agent-context/manifest');
    expect(response.status).toBe(200);
    expect(response.body.enabled).toBe(false);
  });

  it('rejects MCP calls while disabled and rejects non-loopback Origins', async () => {
    mocks.getAgentContextManifest.mockResolvedValue({ ...enabledManifest, enabled: false });
    const disabled = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(disabled.status).toBe(403);
    expect(disabled.body.code).toBe('AGENT_CONTEXT_DISABLED');

    mocks.getAgentContextManifest.mockResolvedValue(enabledManifest);
    const origin = await request(buildApp())
      .get('/api/agent-context/manifest')
      .set('Origin', 'https://example.com');
    expect(origin.status).toBe(403);
    expect(origin.body.code).toBe('AGENT_CONTEXT_ORIGIN_REJECTED');
  });

  it('implements initialize negotiation and stateless tools/list', async () => {
    const initialize = await mcpPost({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Example Client', version: '1.0' } },
    });
    expect(initialize.status).toBe(200);
    expect(initialize.body.result.protocolVersion).toBe('2025-11-25');
    expect(initialize.body.result.capabilities.tools).toEqual({ listChanged: false });
    expect(initialize.body.result.serverInfo.name).toBe('PortOS Agent Tools');
    expect(initialize.body.result.instructions).toMatch(/semantic actions/i);

    const tools = await mcpPost({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(tools.body.result.tools).toEqual(enabledManifest.tools);
  });

  it('dispatches tools/call and acknowledges notifications without a body', async () => {
    const called = await mcpPost({
      jsonrpc: '2.0',
      id: 'call-1',
      method: 'tools/call',
      params: { name: 'context_profile', arguments: {} },
    });
    expect(called.status).toBe(200);
    expect(mocks.callAgentContextTool).toHaveBeenCalledWith('context_profile', {}, {
      agentContext: {
        enabled: true,
        profile: 'metadata',
        scopes: ['navigation', 'workspaces'],
        actions: { readPortos: false, writePortos: false, manageEidoverse: false },
      },
    }, {
      requestId: expect.stringMatching(/^agent-mcp:/),
    });

    const notification = await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notification.status).toBe(202);
    expect(notification.text).toBe('');
  });

  it('enforces transport headers and validated JSON-RPC envelopes', async () => {
    const accept = await request(buildApp())
      .post('/api/agent-context/mcp')
      .set('Accept', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(accept.status).toBe(406);

    const version = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'ping' })
      .set('MCP-Protocol-Version', '1900-01-01');
    expect(version.status).toBe(400);

    const invalid = await mcpPost({ jsonrpc: '2.0', method: 42 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe(-32600);
  });

  it('returns 405 for unsupported GET transport', async () => {
    const response = await request(buildApp()).get('/api/agent-context/mcp');
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('POST');
  });
});
