import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  executeTasks: vi.fn(),
  cleanupMind: vi.fn(),
  worldStatus: vi.fn(),
  worldProject: vi.fn(),
  worldAugment: vi.fn(),
  worldSay: vi.fn(),
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
vi.mock('./persistentMindMaintenance.js', () => ({
  cleanupPersistentMind: (...args) => mocks.cleanupMind(...args),
}));
vi.mock('./eidoverseWorld.js', () => ({
  getEidoverseWorldStatus: (...args) => mocks.worldStatus(...args),
  projectEidoverseWorld: (...args) => mocks.worldProject(...args),
  augmentEidoverseWorld: (...args) => mocks.worldAugment(...args),
  sayInEidoverseWorld: (...args) => mocks.worldSay(...args),
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
  mocks.cleanupMind.mockResolvedValue({ ok: true, success: true, state: 'completed', historyEventsCleared: 8 });
  mocks.worldStatus.mockResolvedValue({ world: 'portos', presence: { connected: true } });
  mocks.worldProject.mockResolvedValue({ success: true, summary: { operationCount: 2 } });
  mocks.worldAugment.mockResolvedValue({ success: true, applied: 1 });
  mocks.worldSay.mockResolvedValue({ success: true, world: 'portos' });
});

describe('cosToolRegistry', () => {
  it('exports a compact canonical catalog and provider translations', () => {
    const catalog = getCosToolCatalog({ scope: 'mind', capabilities: { readPortos: true } });
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      'cos.create-task',
      'mind.cleanup',
      'eidoverse.status',
      'eidoverse.project',
      'eidoverse.augment',
      'eidoverse.say',
      'brain.search',
      'brain.capture',
    ]);
    expect(catalog.tools.find((tool) => tool.name === 'brain.search').granted).toBe(true);
    expect(catalog.tools.find((tool) => tool.name === 'brain.capture').granted).toBe(false);
    const openai = formatCosToolCatalog(catalog, 'openai');
    expect(openai.tools).toEqual([
      expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'eidoverse_status' }) }),
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

  it('keeps private-world management separate from generic PortOS writes and propagates cancellation', async () => {
    const signal = new AbortController().signal;
    await expect(executeCosToolCall({
      call: { requestId: 'world-status-denied', name: 'eidoverse.status', arguments: {} },
      authority: { scope: 'mind', capabilities: { manageEidoverse: true } },
    })).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
    await expect(executeCosToolCall({
      call: { requestId: 'world-project-write-only', name: 'eidoverse.project', arguments: {} },
      authority: { scope: 'mind', capabilities: { readPortos: true, writePortos: true } },
    })).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });

    const status = await executeCosToolCall({
      call: { requestId: 'world-status', name: 'eidoverse.status', arguments: {} },
      authority: { scope: 'mind', capabilities: { readPortos: true } },
      context: { signal },
    });
    const project = await executeCosToolCall({
      call: { requestId: 'world-project', name: 'eidoverse.project', arguments: {} },
      authority: { scope: 'mind', capabilities: { readPortos: true, manageEidoverse: true } },
      context: { signal },
    });
    const augment = await executeCosToolCall({
      call: {
        requestId: 'world-augment',
        name: 'eidoverse.augment',
        arguments: { operations: [{ verb: 'spawn', args: { id: 'example', lib: 'eidoverse/assets/example.glb' } }] },
      },
      authority: { scope: 'mind', capabilities: { manageEidoverse: true } },
      context: { signal },
    });
    const say = await executeCosToolCall({
      call: { requestId: 'world-say', name: 'eidoverse.say', arguments: { text: 'Example message' } },
      authority: { scope: 'mind', capabilities: { manageEidoverse: true } },
      context: { signal },
    });
    const agentAugment = await executeCosToolCall({
      call: {
        requestId: 'agent-world-augment',
        name: 'eidoverse.augment',
        arguments: { operations: [{ verb: 'remove', args: { id: 'example' } }] },
      },
      authority: { scope: 'agent', capabilities: { manageEidoverse: true } },
      context: { signal },
    });

    expect([status.state, project.state, augment.state, say.state, agentAugment.state])
      .toEqual(['completed', 'completed', 'completed', 'completed', 'completed']);
    expect(mocks.worldStatus).toHaveBeenCalledWith();
    expect(mocks.worldProject).toHaveBeenCalledWith({ signal });
    expect(mocks.worldAugment).toHaveBeenCalledWith(
      [{ verb: 'spawn', args: { id: 'example', lib: 'eidoverse/assets/example.glb' } }],
      { signal },
    );
    expect(mocks.worldSay).toHaveBeenCalledWith('Example message', { signal });
  });

  it('executes cleanup only with the dedicated mind capability and preserves current provenance', async () => {
    const signal = new AbortController().signal;
    const call = { requestId: 'cleanup-1', name: 'mind.cleanup', arguments: { scopes: ['history'], reason: 'Stale failures' } };
    await expect(executeCosToolCall({
      call,
      authority: { scope: 'mind', capabilities: { manageMind: false } },
    })).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });

    const result = await executeCosToolCall({
      call,
      authority: { scope: 'mind', capabilities: { manageMind: true } },
      context: {
        turnId: 'turn-current',
        wake: { kind: 'message', message: { id: 'message-current' } },
        signal,
      },
    });

    expect(result).toMatchObject({ state: 'completed', result: { historyEventsCleared: 8 } });
    expect(mocks.cleanupMind).toHaveBeenCalledWith({
      scopes: ['history'],
      reason: 'Stale failures',
      requestedBy: 'mind',
      preserveTurnId: 'turn-current',
      preserveMessageId: 'message-current',
    });
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
