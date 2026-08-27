import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  root: { config: { persistentMindPrompt: { identity: 'Example identity', instructions: 'Example instructions' } } },
  memories: [{ id: 'memory-1', type: 'fact', content: 'A durable fact.', sourceAgentId: 'cos-persistent-mind', status: 'active' }],
  runPrompt: vi.fn(),
  stopRun: vi.fn(),
  readTaskCatalog: vi.fn(),
  executeTaskRequests: vi.fn(),
}));

vi.mock('./cosState.js', () => ({ loadState: vi.fn(async () => mock.root) }));
vi.mock('./persistentMindContext.js', () => ({ readPersistentMindMemories: vi.fn(async () => mock.memories) }));
vi.mock('./promptRunner.js', () => ({ runPromptThroughProvider: (...args) => mock.runPrompt(...args) }));
vi.mock('./runner.js', () => ({ stopRun: (...args) => mock.stopRun(...args) }));
vi.mock('./persistentMindTaskCapability.js', () => ({
  buildPersistentMindTaskCapabilityPrompt: ({ enabled }) => `Task access: ${enabled ? 'ON' : 'OFF'}`,
  readPersistentMindTaskCatalog: (...args) => mock.readTaskCatalog(...args),
  executePersistentMindTaskRequests: (...args) => mock.executeTaskRequests(...args),
}));

const { createPersistentMindTurnAdapter, persistentMindHarnessInfo } = await import('./persistentMindAdapter.js');

const profile = { provider: { id: 'example-api', type: 'api' }, model: 'example-model', effort: 'high' };

beforeEach(() => {
  vi.clearAllMocks();
  mock.root.config.persistentMindCapabilities = { createTasks: true };
  mock.readTaskCatalog.mockResolvedValue({ apps: [{ id: 'portos' }], providers: [{ id: 'codex' }] });
  mock.executeTaskRequests.mockResolvedValue([]);
  mock.runPrompt.mockResolvedValue({ text: JSON.stringify({
    thinkingSummary: 'I connected the new request to the durable fact.',
    message: 'Here is the answer.',
    memoryCandidates: [{ content: 'Remember this.', type: 'fact', category: 'other', tags: [] }],
    selfWake: null,
  }) });
});

describe('persistent mind adapter', () => {
  it('prepares editable prompt and curated memory context without inference', async () => {
    const prepared = await createPersistentMindTurnAdapter().prepare({ profile });
    expect(prepared).toMatchObject({
      provider: profile.provider,
      identity: 'Example identity',
      instructions: 'Example instructions',
      memories: mock.memories,
    });
    expect(mock.runPrompt).not.toHaveBeenCalled();
  });

  it('runs the exact pinned non-interactive profile and returns visible trajectory events', async () => {
    const heartbeat = vi.fn(async () => true);
    const result = await createPersistentMindTurnAdapter().run({
      turnId: 'turn-1',
      wake: { kind: 'message', message: { id: 'message-1', text: 'Hello' } },
      ...profile,
      signal: new AbortController().signal,
      context: { text: '# Context' },
      heartbeat,
    });

    expect(mock.runPrompt).toHaveBeenCalledWith(expect.objectContaining({
      provider: profile.provider,
      model: 'example-model',
      effort: 'high',
      source: 'cos-persistent-mind',
      allowFallback: false,
    }));
    expect(heartbeat).toHaveBeenCalled();
    expect(result.events.map((event) => event.kind)).toEqual([
      'mind.thought', 'mind.reply', 'mind.memory.candidate',
    ]);
    expect(mock.runPrompt.mock.calls[0][0].prompt).toContain('Task access: ON');
  });

  it('executes bounded typed task requests through the supervised capability', async () => {
    const taskRequest = {
      description: 'Audit the local configuration contract',
      prompt: 'Inspect the repository and implement the bounded fix.',
      priority: 'HIGH',
      appId: 'portos',
      providerId: 'codex',
      model: 'gpt-5',
      effort: 'high',
      prCompletion: 'review-then-merge',
    };
    mock.runPrompt.mockResolvedValue({ text: JSON.stringify({
      thinkingSummary: 'This is concrete delegated work.',
      message: 'I am requesting the task now.',
      taskRequests: [taskRequest],
    }) });
    const recordCapabilityEvent = vi.fn(async () => true);
    const signal = new AbortController().signal;
    await createPersistentMindTurnAdapter().run({
      turnId: 'turn-task',
      wake: { kind: 'message', message: { id: 'message-task', text: 'Queue the audit.' } },
      ...profile,
      signal,
      context: { text: '# Context' },
      recordCapabilityEvent,
    });
    expect(mock.executeTaskRequests).toHaveBeenCalledWith({
      taskRequests: [taskRequest],
      turnId: 'turn-task',
      wake: expect.objectContaining({ kind: 'message' }),
      signal,
      recordCapabilityEvent,
    });
  });

  it('keeps slow provider calls alive with a bounded periodic heartbeat', async () => {
    vi.useFakeTimers();
    try {
      let resolveRun;
      mock.runPrompt.mockImplementation(() => new Promise((resolve) => { resolveRun = resolve; }));
      const heartbeat = vi.fn(async () => true);
      const pending = createPersistentMindTurnAdapter().run({
        turnId: 'turn-slow',
        wake: { kind: 'message', message: { id: 'message-slow', text: 'Wait for this.' } },
        ...profile,
        signal: new AbortController().signal,
        context: { text: '# Context' },
        heartbeat,
      });

      // The task-capability grant and bounded provider/app catalog are resolved
      // before inference starts; flush that read-only preflight too.
      await vi.advanceTimersByTimeAsync(0);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(heartbeat).toHaveBeenCalledTimes(2);
      resolveRun({ text: JSON.stringify({ thinkingSummary: 'Still working.', message: 'Done.' }) });
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps slow trajectory summaries alive with the same heartbeat', async () => {
    vi.useFakeTimers();
    try {
      let resolveRun;
      mock.runPrompt.mockImplementation(() => new Promise((resolve) => { resolveRun = resolve; }));
      const heartbeat = vi.fn(async () => true);
      const pending = createPersistentMindTurnAdapter().summarize({
        events: [{ id: 'event-1', kind: 'mind.reply', payload: { text: 'Earlier reply' } }],
        previousSummary: null,
        ...profile,
        signal: new AbortController().signal,
        heartbeat,
      });

      await Promise.resolve();
      expect(heartbeat).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(heartbeat).toHaveBeenCalledTimes(2);
      resolveRun({ text: 'Summary' });
      await expect(pending).resolves.toBe('Summary');
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes the provider harness tradeoff explicit', () => {
    expect(persistentMindHarnessInfo({ type: 'api' }).recommendation).toBe('recommended');
    expect(persistentMindHarnessInfo({ type: 'cli' }).recommendation).toBe('supported');
    expect(persistentMindHarnessInfo({ type: 'tui' }).recommendation).toBe('not-recommended');
  });
});
