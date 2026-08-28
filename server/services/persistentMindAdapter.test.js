import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  root: { config: { persistentMindPrompt: { identity: 'Example identity', instructions: 'Example instructions' } } },
  memories: [{ id: 'memory-1', type: 'fact', content: 'A durable fact.', sourceAgentId: 'cos-persistent-mind', status: 'active' }],
  runPrompt: vi.fn(),
  stopRun: vi.fn(),
  assertVision: vi.fn(),
  readTaskCatalog: vi.fn(),
  executeTaskRequests: vi.fn(),
  executeToolCall: vi.fn(),
  readVisibility: vi.fn(),
  createPersistentMindMemoryFromCandidate: vi.fn(async ({ candidateId, ...candidate }) => ({
    success: true,
    duplicate: false,
    memory: { id: `memory-${candidateId}`, ...candidate },
  })),
}));

vi.mock('./cosState.js', () => ({ loadState: vi.fn(async () => mock.root) }));
vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveScreenshot: vi.fn((filename) => filename ? `/tmp/portos-screenshots/${filename}` : null),
}));
vi.mock('./persistentMindContext.js', () => ({
  createPersistentMindMemoryFromCandidate: (...args) => mock.createPersistentMindMemoryFromCandidate(...args),
  readPersistentMindMemories: vi.fn(async () => mock.memories),
}));
vi.mock('./promptRunner.js', () => ({
  runPromptThroughProvider: (...args) => mock.runPrompt(...args),
  assertVisionRunUsedImages: (...args) => mock.assertVision(...args),
}));
vi.mock('./runner.js', () => ({ stopRun: (...args) => mock.stopRun(...args) }));
vi.mock('./persistentMindTaskCapability.js', () => ({
  buildPersistentMindTaskCapabilityPrompt: ({ enabled }) => `Task access: ${enabled ? 'ON' : 'OFF'}`,
  readPersistentMindTaskCatalog: (...args) => mock.readTaskCatalog(...args),
  executePersistentMindTaskRequests: (...args) => mock.executeTaskRequests(...args),
}));
vi.mock('./persistentMindVisibility.js', () => ({
  readPersistentMindVisibility: (...args) => mock.readVisibility(...args),
  buildPersistentMindVisibilityPrompt: () => 'Environment visibility: READY',
}));
vi.mock('./cosToolRegistry.js', () => ({
  buildPersistentMindToolPrompt: ({ readPortos, writePortos }) => `PortOS tools: read=${Boolean(readPortos)} write=${Boolean(writePortos)}`,
  executeCosToolCall: (...args) => mock.executeToolCall(...args),
  isCosTaskToolName: (name) => name === 'cos.create-task' || name === 'cos_create_task',
}));

const { createPersistentMindTurnAdapter, persistentMindHarnessInfo } = await import('./persistentMindAdapter.js');

const profile = { provider: { id: 'example-api', type: 'api' }, model: 'example-model', effort: 'high' };

beforeEach(() => {
  vi.clearAllMocks();
  mock.root.config.persistentMindCapabilities = { createTasks: true };
  mock.readTaskCatalog.mockResolvedValue({ apps: [{ id: 'portos' }], providers: [{ id: 'codex' }] });
  mock.readVisibility.mockResolvedValue({ readiness: 'ready', workspaces: [] });
  mock.executeTaskRequests.mockResolvedValue([]);
  mock.executeToolCall.mockResolvedValue({ state: 'completed', result: { ok: true, count: 1 } });
  mock.assertVision.mockImplementation((result, provider) => result?.provider || provider);
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
      'mind.thought', 'mind.reply', 'mind.memory.created',
    ]);
    expect(mock.createPersistentMindMemoryFromCandidate).toHaveBeenCalledWith({
      content: 'Remember this.', type: 'fact', category: 'other', tags: [], summary: '',
      candidateId: 'turn-1:0', turnId: 'turn-1',
    });
    expect(mock.runPrompt.mock.calls[0][0].prompt).toContain('Task access: ON');
    expect(mock.runPrompt.mock.calls[0][0].prompt).toContain('Environment visibility: READY');
    expect(mock.runPrompt.mock.calls[0][0].prompt).toContain('PortOS tools: read=false write=false');
  });

  it('executes semantic tool calls and feeds normalized results into a final provider round', async () => {
    mock.root.config.persistentMindCapabilities = { readPortos: true };
    mock.runPrompt
      .mockResolvedValueOnce({ text: JSON.stringify({
        thinkingSummary: 'I need the catalog result.',
        toolCalls: [{ name: 'catalog.search', arguments: { query: 'example' } }],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        thinkingSummary: 'I used the catalog result.',
        message: 'I found one match.',
        toolCalls: [],
      }) });
    const recordCapabilityEvent = vi.fn(async () => true);
    await createPersistentMindTurnAdapter().run({
      turnId: 'turn-tools',
      wake: { kind: 'message', message: { id: 'message-tools', text: 'Find the example.' } },
      ...profile,
      signal: new AbortController().signal,
      context: { text: '# Context' },
      recordCapabilityEvent,
    });
    expect(mock.executeToolCall).toHaveBeenCalledWith(expect.objectContaining({
      call: expect.objectContaining({ name: 'catalog.search', requestId: expect.stringMatching(/^mind-tool-/) }),
      authority: { scope: 'mind', capabilities: expect.objectContaining({ readPortos: true }) },
    }));
    expect(mock.runPrompt).toHaveBeenCalledTimes(2);
    expect(mock.runPrompt.mock.calls[1][0].prompt).toContain('Completed tool results');
    expect(recordCapabilityEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'request' }));
    expect(recordCapabilityEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'result' }));
  });

  it('never executes a new tool request from the final provider round', async () => {
    mock.root.config.persistentMindCapabilities = { readPortos: true };
    const taskRequest = {
      description: 'Deferred task',
      prompt: 'Do not queue this non-terminal request.',
      priority: 'MEDIUM',
      appId: 'portos',
      providerId: 'codex',
      model: 'gpt-5',
      effort: 'high',
      prCompletion: 'review-then-merge',
    };
    mock.runPrompt.mockResolvedValue({ text: JSON.stringify({
      thinkingSummary: '',
      message: '',
      taskRequests: [taskRequest],
      toolCalls: [{ name: 'catalog.search', arguments: { query: 'example' } }],
    }) });
    const recordCapabilityEvent = vi.fn(async () => true);
    const result = await createPersistentMindTurnAdapter().run({
      turnId: 'turn-round-limit',
      wake: { kind: 'message', message: { id: 'message-round-limit', text: 'Keep searching.' } },
      ...profile,
      signal: new AbortController().signal,
      context: { text: '# Context' },
      recordCapabilityEvent,
    });
    expect(mock.runPrompt).toHaveBeenCalledTimes(4);
    expect(mock.executeToolCall).toHaveBeenCalledTimes(3);
    expect(mock.executeTaskRequests).not.toHaveBeenCalled();
    expect(recordCapabilityEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'result',
      data: expect.objectContaining({ tool: 'cos.create-task', success: false }),
    }));
    expect(result.events.find((event) => event.kind === 'mind.reply')?.data.displayText).toMatch(/round limit/);
    expect(result.events.find((event) => event.kind === 'mind.reply')?.data.displayText).toMatch(/not queued/);
  });

  it('preserves completed results across stateless provider rounds', async () => {
    mock.root.config.persistentMindCapabilities = { readPortos: true };
    mock.executeToolCall
      .mockResolvedValueOnce({ state: 'completed', result: { marker: 'first-result' } })
      .mockResolvedValueOnce({ state: 'completed', result: { marker: 'second-result' } });
    mock.runPrompt
      .mockResolvedValueOnce({ text: JSON.stringify({
        thinkingSummary: 'I need the first lookup.',
        toolCalls: [{ requestId: 'lookup-1', name: 'catalog.search', arguments: { query: 'first' } }],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        thinkingSummary: 'I need the second lookup.',
        toolCalls: [{ requestId: 'lookup-2', name: 'catalog.search', arguments: { query: 'second' } }],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        thinkingSummary: 'I used both lookups.',
        message: 'Both results are reflected here.',
        toolCalls: [],
      }) });

    await createPersistentMindTurnAdapter().run({
      turnId: 'turn-cumulative-tools',
      wake: { kind: 'message', message: { id: 'message-cumulative-tools', text: 'Run both lookups.' } },
      ...profile,
      signal: new AbortController().signal,
      context: { text: '# Context' },
    });

    const finalPrompt = mock.runPrompt.mock.calls[2][0].prompt;
    expect(finalPrompt).toContain('first-result');
    expect(finalPrompt).toContain('second-result');
  });

  it('namespaces provider request ids by turn', async () => {
    mock.root.config.persistentMindCapabilities = { readPortos: true };
    mock.runPrompt
      .mockResolvedValueOnce({ text: JSON.stringify({
        thinkingSummary: 'First lookup.',
        toolCalls: [{ requestId: 'call_1', name: 'catalog.search', arguments: { query: 'example' } }],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ thinkingSummary: 'Done.', message: 'First done.', toolCalls: [] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        thinkingSummary: 'Second lookup.',
        toolCalls: [{ requestId: 'call_1', name: 'catalog.search', arguments: { query: 'example' } }],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ thinkingSummary: 'Done again.', message: 'Second done.', toolCalls: [] }) });

    for (const turnId of ['turn-provider-id-a', 'turn-provider-id-b']) {
      await createPersistentMindTurnAdapter().run({
        turnId,
        wake: { kind: 'message', message: { id: `message-${turnId}`, text: 'Look it up.' } },
        ...profile,
        signal: new AbortController().signal,
        context: { text: '# Context' },
      });
    }

    const requestIds = mock.executeToolCall.mock.calls.map(([input]) => input.call.requestId);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toMatch(/^mind-tool-/);
    expect(requestIds[1]).toMatch(/^mind-tool-/);
    expect(requestIds[0]).not.toBe(requestIds[1]);
  });

  it('keeps fallback request ids stable when replayed calls are reordered', async () => {
    mock.root.config.persistentMindCapabilities = { readPortos: true };
    const firstOrder = [
      { name: 'catalog.search', arguments: { query: 'first' } },
      { name: 'catalog.search', arguments: { query: 'second' } },
    ];
    mock.runPrompt
      .mockResolvedValueOnce({ text: JSON.stringify({ thinkingSummary: 'First replay.', toolCalls: firstOrder }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ thinkingSummary: 'Done.', message: 'Done.', toolCalls: [] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ thinkingSummary: 'Second replay.', toolCalls: [...firstOrder].reverse() }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ thinkingSummary: 'Done again.', message: 'Done again.', toolCalls: [] }) });

    for (let replay = 0; replay < 2; replay += 1) {
      await createPersistentMindTurnAdapter().run({
        turnId: 'turn-reordered-replay',
        wake: { kind: 'message', message: { id: 'message-reordered-replay', text: 'Replay.' } },
        ...profile,
        signal: new AbortController().signal,
        context: { text: '# Context' },
      });
    }

    const byQuery = (calls) => Object.fromEntries(calls.map(([input]) => [input.call.arguments.query, input.call.requestId]));
    expect(byQuery(mock.executeToolCall.mock.calls.slice(0, 2))).toEqual(byQuery(mock.executeToolCall.mock.calls.slice(2, 4)));
  });

  it('stops remaining semantic calls when the turn is interrupted', async () => {
    mock.root.config.persistentMindCapabilities = { writePortos: true };
    const controller = new AbortController();
    mock.executeToolCall.mockImplementationOnce(async () => {
      controller.abort('stop-after-first');
      return { state: 'completed', result: { ok: true } };
    });
    mock.runPrompt.mockResolvedValueOnce({ text: JSON.stringify({
      thinkingSummary: 'Run the bounded writes.',
      toolCalls: [
        { name: 'brain.capture', arguments: { text: 'first' } },
        { name: 'brain.capture', arguments: { text: 'second' } },
      ],
    }) });

    await expect(createPersistentMindTurnAdapter().run({
      turnId: 'turn-interrupted-tools',
      wake: { kind: 'message', message: { id: 'message-interrupted-tools', text: 'Capture both.' } },
      ...profile,
      signal: controller.signal,
      context: { text: '# Context' },
    })).rejects.toThrow('stop-after-first');
    expect(mock.executeToolCall).toHaveBeenCalledTimes(1);
  });

  it('feeds a normalized tool error back to the provider instead of aborting the turn', async () => {
    mock.root.config.persistentMindCapabilities = { readPortos: true };
    mock.executeToolCall.mockRejectedValueOnce(new Error('Tool is unavailable'));
    mock.runPrompt
      .mockResolvedValueOnce({ text: JSON.stringify({
        thinkingSummary: 'I will try a lookup.',
        toolCalls: [{ name: 'catalog.search', arguments: { query: 'example' } }],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        thinkingSummary: 'The lookup failed safely.',
        message: 'I could not complete that lookup.',
        toolCalls: [],
      }) });
    const recordCapabilityEvent = vi.fn(async () => true);

    const result = await createPersistentMindTurnAdapter().run({
      turnId: 'turn-tool-error',
      wake: { kind: 'message', message: { id: 'message-tool-error', text: 'Look it up.' } },
      ...profile,
      signal: new AbortController().signal,
      context: { text: '# Context' },
      recordCapabilityEvent,
    });

    expect(result.events.find((event) => event.kind === 'mind.reply')?.data.displayText).toBe('I could not complete that lookup.');
    expect(mock.runPrompt.mock.calls[1][0].prompt).toContain('Tool is unavailable');
    expect(recordCapabilityEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'result',
      data: expect.objectContaining({ success: false }),
    }));
  });

  it('shares the five-task limit across provider rounds and task tool calls', async () => {
    mock.root.config.persistentMindCapabilities = { createTasks: true, readPortos: true };
    const taskRequest = (index) => ({
      description: `Task ${index}`,
      prompt: `Implement task ${index}.`,
      priority: 'MEDIUM',
      appId: 'portos',
      providerId: 'codex',
      model: 'gpt-5',
      effort: 'high',
      prCompletion: 'review-then-merge',
    });
    mock.runPrompt
      .mockResolvedValueOnce({ text: JSON.stringify({
        thinkingSummary: 'First batch.',
        taskRequests: [taskRequest(1), taskRequest(2), taskRequest(3)],
        toolCalls: [
          { name: 'cos.create-task', arguments: taskRequest(4) },
          { name: 'catalog.search', arguments: { query: 'example' } },
        ],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        thinkingSummary: 'Second batch.',
        taskRequests: [taskRequest(5), taskRequest(6), taskRequest(7)],
        toolCalls: [
          { name: 'cos.create-task', arguments: taskRequest(8) },
          { name: 'cos.create-task', arguments: taskRequest(9) },
        ],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        thinkingSummary: 'The bounded task batch is complete.',
        message: 'I stayed within the task limit.',
        taskRequests: [taskRequest(10), taskRequest(11), taskRequest(12), taskRequest(13), taskRequest(14)],
        toolCalls: [],
      }) });

    const recordCapabilityEvent = vi.fn(async () => true);
    const result = await createPersistentMindTurnAdapter().run({
      turnId: 'turn-shared-task-limit',
      wake: { kind: 'message', message: { id: 'message-shared-task-limit', text: 'Queue the bounded batch.' } },
      ...profile,
      signal: new AbortController().signal,
      context: { text: '# Context' },
      recordCapabilityEvent,
    });

    const directTaskCount = mock.executeTaskRequests.mock.calls
      .reduce((total, [input]) => total + input.taskRequests.length, 0);
    const taskToolCount = mock.executeToolCall.mock.calls
      .filter(([input]) => input.call.name === 'cos.create-task').length;
    expect(directTaskCount + taskToolCount).toBe(5);
    expect(directTaskCount).toBe(2);
    expect(mock.runPrompt.mock.calls[1][0].prompt).toContain('intermediate round were not queued');
    expect(result.events.find((event) => event.kind === 'mind.reply')?.data.displayText).toContain('task request limit of 5');
    expect(recordCapabilityEvent.mock.calls.filter(([event]) => event.kind === 'result' && event.data.success === false)).toHaveLength(3);
  });

  it('passes every current-message image to the pinned provider and verifies consumption', async () => {
    const imageProfile = { provider: { id: 'codex', type: 'cli', command: 'codex' }, model: 'gpt-5', effort: 'high' };
    const wake = {
      kind: 'message',
      message: {
        id: 'message-images',
        text: 'Compare these.',
        images: [
          { filename: 'mind-example-one.png' },
          { filename: 'mind-example-two.jpg' },
        ],
      },
    };
    await createPersistentMindTurnAdapter().run({
      turnId: 'turn-images', wake, ...imageProfile,
      signal: new AbortController().signal,
      context: { text: '# Context' },
    });
    expect(mock.runPrompt).toHaveBeenCalledWith(expect.objectContaining({
      screenshots: expect.arrayContaining([
        expect.stringContaining('mind-example-one.png'),
        expect.stringContaining('mind-example-two.jpg'),
      ]),
      allowFallback: false,
    }));
    expect(mock.assertVision).toHaveBeenCalledWith(expect.any(Object), imageProfile.provider);
    expect(mock.runPrompt.mock.calls[0][0].prompt).toContain('[2 images attached]');
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
