import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  executeTasks: vi.fn(),
  cleanupMind: vi.fn(),
  worldStatus: vi.fn(),
  worldProject: vi.fn(),
  worldAugment: vi.fn(),
  worldSay: vi.fn(),
  listUserActions: vi.fn(),
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
vi.mock('./userActions.js', () => ({
  listUserActions: (...args) => mocks.listUserActions(...args),
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
      'user-actions.query',
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
      expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'user_actions_query' }) }),
      expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'eidoverse_status' }) }),
      expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'brain_search' }) }),
    ]);
    const mcp = formatCosToolCatalog(catalog, 'mcp');
    expect(mcp.tools[0].annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  it('includes only granted tools in the Persistent Mind prompt', () => {
    const prompt = buildPersistentMindToolPrompt({ readPortos: true });
    // Catalog entries are JSON.stringified as `"name":"<tool>"`. A granted
    // tool's input schema may list the same token as an enum (user-actions.query
    // type `brain.capture`, #5596) — that must not be mistaken for advertising
    // the ungranted write tool.
    expect(prompt).toContain('"name":"brain.search"');
    expect(prompt).not.toContain('"name":"brain.capture"');
  });

  it('exposes the operator-action ledger to mind and agent scopes only behind readPortos', async () => {
    const agentCatalog = getCosToolCatalog({ scope: 'agent', capabilities: { readPortos: true } });
    expect(agentCatalog.tools.find((tool) => tool.providerName === 'user_actions_query').granted).toBe(true);
    // scope 'agent' + granted is exactly what agentContextMcp's
    // semanticToolsForConfig re-exports over the loopback MCP surface.
    expect(formatCosToolCatalog(agentCatalog, 'mcp').tools.map((tool) => tool.name)).toContain('user_actions_query');
    const denied = getCosToolCatalog({ scope: 'agent', capabilities: { writePortos: true } });
    expect(denied.tools.find((tool) => tool.providerName === 'user_actions_query').granted).toBe(false);
    await expect(executeCosToolCall({
      call: { requestId: 'ua-denied', name: 'user-actions.query', arguments: {} },
      authority: { scope: 'mind', capabilities: { createTasks: true } },
    })).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
    expect(mocks.listUserActions).not.toHaveBeenCalled();
  });

  it('returns bounded ledger events with source reduced to route identity', async () => {
    mocks.listUserActions.mockResolvedValue([
      {
        id: 'evt-1', happenedAt: '2026-09-01T00:00:02.000Z', type: 'cos.schedule.trigger', actor: 'user',
        summary: "Ran scheduled task 'branch-reconcile' on demand", target: 'branch-reconcile', targetName: null,
        payload: { taskType: 'branch-reconcile', prompt: 'use sk-abcdefghijklmnopqrstuvwx for deploy' },
        source: { route: '/api/cos/schedule/trigger', method: 'POST', service: 'taskSchedule', file: '/home/alice/portos/server.js' },
      },
      {
        id: 'evt-2', happenedAt: '2026-09-01T00:00:01.000Z', type: 'settings.update', actor: 'user',
        summary: 'Updated settings with token ghp_abcdefghijklmnopqrstuv inside',
        targetName: 'uses sk-abcdefghijklmnopqrstuvwx here',
        payload: {}, source: { service: 'settings', fn: 'save' },
      },
      {
        id: 'evt-3', happenedAt: '2026-09-01T00:00:00.000Z', type: 'cos.task.create', actor: 'user',
        summary: 'Queued task', payload: {}, source: {},
      },
    ]);
    const result = await executeCosToolCall({
      call: { requestId: 'ua-read', name: 'user-actions.query', arguments: { actor: 'user', limit: 2 } },
      authority: { scope: 'mind', capabilities: { readPortos: true } },
    });
    // Fetches one extra row so a full page reports truncation honestly.
    expect(mocks.listUserActions).toHaveBeenCalledWith({ actor: 'user', limit: 3 });
    expect(result.state).toBe('completed');
    expect(result.result.truncated).toBe(true);
    expect(result.result.events).toHaveLength(2);
    expect(result.result.events[0]).toMatchObject({
      type: 'cos.schedule.trigger',
      target: 'branch-reconcile',
      source: { route: '/api/cos/schedule/trigger', method: 'POST' },
    });
    // A `{ service, fn }` source (and any filesystem path) never crosses out.
    expect(result.result.events[1].source).toEqual({});
    expect(JSON.stringify(result.result)).not.toContain('/home/alice');
    // Free-text projections get the value-side credential scrub — payload
    // string values included (record-time redaction is key-based only).
    expect(result.result.events[1].summary).toBe('Updated settings with token [REDACTED] inside');
    expect(result.result.events[1].targetName).toBe('uses [REDACTED] here');
    expect(result.result.events[0].payload.prompt).toBe('use [REDACTED] for deploy');
  });

  it('rejects an unparseable date filter with field attribution', async () => {
    mocks.listUserActions.mockResolvedValue([]);
    const result = await executeCosToolCall({
      call: { requestId: 'ua-bad-date', name: 'user-actions.query', arguments: { from: 'last tuesday-ish' } },
      authority: { scope: 'mind', capabilities: { readPortos: true } },
    });
    expect(result.state).toBe('failed');
    expect(result.error).toContain("Invalid 'from'");
    expect(mocks.listUserActions).not.toHaveBeenCalled();
  });

  it('clamps the ledger query limit to 100 and rejects unknown filters', async () => {
    mocks.listUserActions.mockResolvedValue([]);
    const result = await executeCosToolCall({
      call: { requestId: 'ua-clamp', name: 'user-actions.query', arguments: { limit: 500 } },
      authority: { scope: 'mind', capabilities: { readPortos: true } },
    });
    expect(result.state).toBe('completed');
    expect(result.result).toEqual({ events: [], truncated: false });
    expect(mocks.listUserActions).toHaveBeenCalledWith({ limit: 101 });
    await expect(executeCosToolCall({
      call: { requestId: 'ua-bad', name: 'user-actions.query', arguments: { sql: 'DROP TABLE' } },
      authority: { scope: 'mind', capabilities: { readPortos: true } },
    })).rejects.toMatchObject({ code: 'TOOL_VALIDATION_ERROR' });
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
