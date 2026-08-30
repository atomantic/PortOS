import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: {},
  getBrainProjections: vi.fn(),
  listContexts: vi.fn(),
  previewLegacyExport: vi.fn(),
  executeCosToolCall: vi.fn(),
  getCosToolCatalog: vi.fn(),
}));

vi.mock('./settings.js', () => ({ getSettings: vi.fn(async () => mocks.settings) }));
vi.mock('./brainSearchIndex.js', () => ({
  BRAIN_SEARCH_TYPES: ['projects'],
  getBrainProjections: mocks.getBrainProjections,
}));
vi.mock('./workspaceContext.js', () => ({ listContexts: mocks.listContexts }));
vi.mock('./legacyExport.js', () => ({
  previewLegacyExport: mocks.previewLegacyExport,
  redactSecrets: (text) => text.replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED]'),
}));
vi.mock('../lib/navManifest.js', () => ({
  NAV_COMMANDS: [{ id: 'nav.dashboard', path: '/', label: 'Dashboard', section: 'Main', aliases: ['home'], keywords: ['overview'] }],
  resolveNavCommand: (query) => query.toLowerCase().includes('home')
    ? { path: '/', matched: 'home', command: { id: 'nav.dashboard', path: '/', label: 'Dashboard', section: 'Main', aliases: ['home'] } }
    : null,
}));
vi.mock('./cosToolRegistry.js', () => ({
  executeCosToolCall: mocks.executeCosToolCall,
  getCosToolCatalog: mocks.getCosToolCatalog,
  formatCosToolCatalog: (catalog) => ({
    tools: catalog.tools.map((tool) => ({
      name: tool.providerName,
      description: tool.description,
      inputSchema: tool.input_schema,
      outputSchema: tool.output_schema,
      annotations: { readOnlyHint: tool.policy.sideEffect === 'read' },
    })),
  }),
}));

import { AGENT_CONTEXT_LIMITS } from '../lib/agentContextValidation.js';
import {
  callAgentContextTool,
  getAgentContextManifest,
  redactAgentContextText,
} from './agentContextMcp.js';

describe('agentContextMcp service', () => {
  beforeEach(() => {
    mocks.settings = {};
    vi.clearAllMocks();
    mocks.listContexts.mockResolvedValue([]);
    mocks.getBrainProjections.mockResolvedValue([]);
    mocks.previewLegacyExport.mockResolvedValue({ sections: {} });
    mocks.getCosToolCatalog.mockImplementation(({ capabilities }) => ({
      tools: capabilities?.readPortos ? [{
        name: 'brain.search',
        providerName: 'brain_search',
        aliases: ['brain_search'],
        description: 'Search Brain.',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        output_schema: { type: 'object' },
        policy: { sideEffect: 'read' },
        granted: true,
      }] : [],
    }));
    mocks.executeCosToolCall.mockResolvedValue({
      type: 'portos_tool_result', requestId: 'agent-mcp:test', name: 'brain.search', state: 'completed', result: { ok: true },
    });
  });

  it('fails closed to a disabled metadata-only default manifest', async () => {
    const manifest = await getAgentContextManifest();
    expect(manifest.enabled).toBe(false);
    expect(manifest.profile).toBe('metadata');
    expect(manifest.scopes).toEqual(['navigation', 'workspaces']);
    expect(manifest.transport).toMatchObject({ loopbackOnly: true, stateful: false });
    expect(manifest).toMatchObject({
      schemaVersion: 4,
      actions: { readPortos: false, writePortos: false, manageEidoverse: false },
      limits: { maxApproxTokens: 5_000 },
    });
    expect(manifest.exclusions.join(' ')).toMatch(/Privacy Vault/);
  });

  it('does not execute tools while disabled', async () => {
    const result = await callAgentContextTool('list_context', { scope: 'navigation' });
    expect(result.isError).toBe(true);
    expect(mocks.listContexts).not.toHaveBeenCalled();
  });

  it('advertises and dispatches only explicitly granted semantic tools', async () => {
    mocks.settings = {
      agentContext: {
        enabled: true,
        scopes: ['navigation'],
        actions: { readPortos: true, writePortos: false, manageEidoverse: true },
      },
    };
    const manifest = await getAgentContextManifest();
    expect(manifest.tools.map((tool) => tool.name)).toContain('brain_search');

    const result = await callAgentContextTool('brain_search', {}, undefined, { requestId: 'agent-mcp:test' });
    expect(result.isError).toBeUndefined();
    expect(mocks.executeCosToolCall).toHaveBeenCalledWith(expect.objectContaining({
      call: expect.objectContaining({ requestId: 'agent-mcp:test', name: 'brain.search' }),
      authority: {
        scope: 'agent',
        capabilities: { readPortos: true, writePortos: false, manageEidoverse: true },
      },
    }));
  });

  it('metadata profile can match private workspace text without returning it', async () => {
    mocks.settings = { agentContext: { enabled: true, profile: 'metadata', scopes: ['workspaces'] } };
    mocks.listContexts.mockResolvedValue([{
      appId: 'private-project',
      appName: 'Secret Project',
      repoPath: '/home/alice/private-project',
      savedBranch: 'private-plan',
      taskCount: 2,
    }]);
    const result = await callAgentContextTool('search_context', { query: 'Secret' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.items[0]).toMatchObject({ title: 'Workspace', summary: 'Active workspace with 2 task(s).' });
    expect(JSON.stringify(result)).not.toContain('Secret Project');
    expect(JSON.stringify(result)).not.toContain('/home/alice');
    expect(JSON.stringify(result)).not.toContain('private-plan');
  });

  it('redacts high-confidence personal data in explicitly enabled summaries', async () => {
    mocks.settings = { agentContext: { enabled: true, profile: 'summary', scopes: ['brain'] } };
    mocks.getBrainProjections.mockResolvedValue([{
      id: 'project-1',
      title: 'Contact alice@example.com from /Users/alice/notes',
      description: 'Host 192.0.2.10 token sk-12345678901234567890',
      privateBody: 'never expose this projected field',
    }]);
    const result = await callAgentContextTool('list_context', { scope: 'brain' });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('[REDACTED EMAIL]');
    expect(serialized).toContain('[REDACTED IP]');
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('sk-12345678901234567890');
    expect(serialized).not.toContain('never expose this projected field');
  });

  it('rejects reads outside configured scopes', async () => {
    mocks.settings = { agentContext: { enabled: true, scopes: ['navigation'] } };
    const result = await callAgentContextTool('list_context', { scope: 'brain' });
    expect(result.isError).toBe(true);
    expect(mocks.getBrainProjections).not.toHaveBeenCalled();
  });

  it('bounds result count and makes source failures explicit', async () => {
    mocks.settings = { agentContext: { enabled: true, scopes: ['workspaces'] } };
    mocks.listContexts.mockResolvedValue(Array.from({ length: AGENT_CONTEXT_LIMITS.maxSourceItems + 1 }, (_, index) => ({
      appId: `app-${index}`,
      appName: `Example ${index}`,
      taskCount: index,
    })));
    const bounded = await callAgentContextTool('list_context', { scope: 'workspaces', limit: AGENT_CONTEXT_LIMITS.maxResults });
    expect(bounded.structuredContent.items).toHaveLength(AGENT_CONTEXT_LIMITS.maxResults);
    expect(bounded.structuredContent.truncated).toBe(true);
    expect(bounded.structuredContent.sourceTruncated).toBe(true);
    expect(bounded.structuredContent.sourceStatus).toBe('fresh');

    mocks.listContexts.mockRejectedValue(new Error('catalog unavailable'));
    const failed = await callAgentContextTool('list_context', { scope: 'workspaces' });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toBe('Context source unavailable for this request.');
  });

  it('resolves navigation and exposes identity presence metadata only', async () => {
    mocks.settings = { agentContext: { enabled: true, scopes: ['navigation', 'identity'] } };
    mocks.previewLegacyExport.mockResolvedValue({
      sections: { identity: { label: 'Identity', present: true, privateBody: 'never return this' } },
    });
    const navigation = await callAgentContextTool('resolve_navigation', { query: 'home' });
    expect(navigation.structuredContent.match).toMatchObject({ title: 'Dashboard', path: '/' });
    expect(navigation.structuredContent.sourceStatus).toBe('fresh');

    const identity = await callAgentContextTool('list_context', { scope: 'identity' });
    expect(identity.structuredContent.items[0].summary).toMatch(/raw records are excluded/);
    expect(JSON.stringify(identity)).not.toContain('never return this');
  });

  it('keeps redacted summaries within the advertised cap', () => {
    expect(redactAgentContextText('x'.repeat(1_000))).toHaveLength(AGENT_CONTEXT_LIMITS.maxSummaryChars);
  });
});
