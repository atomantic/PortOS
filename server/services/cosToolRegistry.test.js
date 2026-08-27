import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  executeTasks: vi.fn(),
}));

const specs = [
  {
    type: 'function',
    function: {
      name: 'brain_search',
      description: 'Search Brain records. Longer voice-only instructions are omitted.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'brain_capture',
      description: 'Capture a Brain record.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  },
];

vi.mock('./voice/tools.js', () => ({
  getToolSpecs: () => specs,
  getToolSpecsForIntent: () => ({ specs, activeGroups: new Set() }),
  dispatchTool: (...args) => mocks.dispatch(...args),
}));
vi.mock('./persistentMindTaskCapability.js', () => ({
  executePersistentMindTaskRequests: (...args) => mocks.executeTasks(...args),
}));

import {
  __testing,
  buildPersistentMindToolPrompt,
  executeCosToolCall,
  formatCosToolCatalog,
  getCosToolCatalog,
} from './cosToolRegistry.js';

beforeEach(() => {
  vi.clearAllMocks();
  __testing.toolCalls.clear();
  __testing.toolCallFingerprints.clear();
  mocks.dispatch.mockResolvedValue({ ok: true });
  mocks.executeTasks.mockResolvedValue([{ success: true, task: { id: 'task-1' }, duplicate: false }]);
});

describe('cosToolRegistry', () => {
  it('exports a compact canonical catalog and provider translations', () => {
    const catalog = getCosToolCatalog({ scope: 'mind', capabilities: { readPortos: true } });
    expect(catalog.tools.map((tool) => tool.name)).toEqual(['cos.create-task', 'brain.search', 'brain.capture']);
    expect(catalog.tools.find((tool) => tool.name === 'brain.search').granted).toBe(true);
    expect(catalog.tools.find((tool) => tool.name === 'brain.capture').granted).toBe(false);
    const openai = formatCosToolCatalog(catalog, 'openai');
    expect(openai.tools).toEqual([
      expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'brain_search' }) }),
    ]);
    const mcp = formatCosToolCatalog(catalog, 'mcp');
    expect(mcp.tools[0].annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  it('includes only granted tools in the Persistent Mind prompt', () => {
    const prompt = buildPersistentMindToolPrompt({ readPortos: true });
    expect(prompt).toContain('brain.search');
    expect(prompt).not.toContain('brain.capture');
  });

  it('validates arguments and executes an allowed read', async () => {
    const signal = new AbortController().signal;
    const result = await executeCosToolCall({
      call: { requestId: 'read-1', name: 'brain.search', arguments: { query: 'example' } },
      authority: { scope: 'ui', authenticated: false },
      context: { signal },
    });
    expect(result.state).toBe('completed');
    expect(mocks.dispatch).toHaveBeenCalledWith('brain_search', { query: 'example' }, { sideEffects: [], signal });
  });

  it('blocks untrusted HTTP mutations and ungranted mind tools', async () => {
    await expect(executeCosToolCall({
      call: { requestId: 'write-1', name: 'brain.capture', arguments: { text: 'example' } },
      authority: { scope: 'ui', authenticated: false },
    })).rejects.toMatchObject({ code: 'TOOL_AUTH_REQUIRED' });
    await expect(executeCosToolCall({
      call: { requestId: 'write-2', name: 'brain.capture', arguments: { text: 'example' } },
      authority: { scope: 'mind', capabilities: { writePortos: false } },
    })).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
  });

  it('coalesces a repeated request id and rejects changed arguments', async () => {
    const first = await executeCosToolCall({
      call: { requestId: 'same-1', name: 'brain.search', arguments: { query: 'one' } },
      authority: { scope: 'ui' },
    });
    const replay = await executeCosToolCall({
      call: { requestId: 'same-1', name: 'brain.search', arguments: { query: 'one' } },
      authority: { scope: 'ui' },
    });
    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    await expect(executeCosToolCall({
      call: { requestId: 'same-1', name: 'brain.search', arguments: { query: 'two' } },
      authority: { scope: 'ui' },
    })).rejects.toMatchObject({ code: 'TOOL_IDEMPOTENCY_CONFLICT' });
  });

  it('fails closed when a retained result is evicted', async () => {
    await executeCosToolCall({
      call: { requestId: 'evicted-write', name: 'brain.capture', arguments: { text: 'example' } },
      authority: { scope: 'mind', capabilities: { writePortos: true } },
    });
    for (let index = 0; index < 500; index += 1) {
      await executeCosToolCall({
        call: { requestId: `fill-${index}`, name: 'brain.search', arguments: { query: String(index) } },
        authority: { scope: 'ui' },
      });
    }
    expect(__testing.toolCalls.has('evicted-write')).toBe(false);
    expect(__testing.toolCallFingerprints.get('evicted-write')?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(__testing.toolCallFingerprints.get('evicted-write')?.fingerprint).not.toContain('example');
    await expect(executeCosToolCall({
      call: { requestId: 'evicted-write', name: 'brain.capture', arguments: { text: 'example' } },
      authority: { scope: 'mind', capabilities: { writePortos: true } },
    })).rejects.toMatchObject({ code: 'TOOL_IDEMPOTENCY_EXPIRED' });
    expect(mocks.dispatch.mock.calls.filter(([name]) => name === 'brain_capture')).toHaveLength(1);
  });

  it('promotes adapter-declared failures to the normalized envelope', async () => {
    mocks.executeTasks.mockResolvedValueOnce([{ success: false, error: 'Queue unavailable' }]);
    const result = await executeCosToolCall({
      call: {
        requestId: 'failed-task',
        name: 'cos.create-task',
        arguments: {
          description: 'Example task', prompt: 'Do the example work.', priority: 'MEDIUM',
          appId: 'portos', providerId: 'codex', model: '', effort: '', prCompletion: 'review-then-merge',
        },
      },
      authority: { scope: 'mind', capabilities: { createTasks: true } },
    });
    expect(result).toMatchObject({
      state: 'failed',
      error: 'Queue unavailable',
      result: { ok: false, state: 'failed', error: 'Queue unavailable' },
    });
  });
});
