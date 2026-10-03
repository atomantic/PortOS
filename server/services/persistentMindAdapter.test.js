import { resolvePersistentMindChosenName } from '../lib/persistentMindChosenName.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  root: { config: { persistentMindPrompt: { identity: 'Example identity', instructions: 'Example instructions' } } },
  memories: [{ id: 'memory-1', type: 'fact', content: 'A durable fact.', sourceAgentId: 'cos-persistent-mind', status: 'active' }],
  runPrompt: vi.fn(),
  stopRun: vi.fn(),
  assertVision: vi.fn(),
  readTaskCatalog: vi.fn(),
  readTaskInventory: vi.fn(),
  executeTaskRequests: vi.fn(),
  executeToolCall: vi.fn(),
  readVisibility: vi.fn(),
  executeCallRequest: vi.fn(),
  resolvePlaybookPhase: vi.fn(),
  readMaintenance: vi.fn(),
  resolveLocalPromptBudget: vi.fn(),
  toolPromptPadding: '',
  realToolExposure: false,
  recipeCatalog: [],
  realRegistry: null,
  createPersistentMindMemoryFromCandidate: vi.fn(async ({ candidateId, ...candidate }) => ({
    success: true,
    duplicate: false,
    memory: { id: `memory-${candidateId}`, ...candidate },
  })),
}));

vi.mock('./cosState.js', () => ({
  loadState: vi.fn(async () => mock.root),
  saveState: vi.fn(async () => {}),
  withStateLock: vi.fn(async (fn) => fn()),
}));
vi.mock('./mindToolRecipeRuntime.js', async (importOriginal) => ({
  ...await importOriginal(),
  readMindRecipeTools: async () => mock.recipeCatalog,
}));
vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveScreenshot: vi.fn((filename) => filename ? `/tmp/portos-screenshots/${filename}` : null),
}));
vi.mock('./persistentMindContext.js', () => ({
  createPersistentMindMemoryFromCandidate: (...args) => mock.createPersistentMindMemoryFromCandidate(...args),
  readPersistentMindMemories: vi.fn(async () => mock.memories),
  readPersistentMindName: vi.fn(async () => resolvePersistentMindChosenName(mock.memories)),
}));
vi.mock('./promptRunner.js', () => ({
  runPromptThroughProvider: (...args) => mock.runPrompt(...args),
  assertVisionRunUsedImages: (...args) => mock.assertVision(...args),
  resolveLocalPromptBudget: (...args) => mock.resolveLocalPromptBudget(...args),
}));
vi.mock('./runner.js', () => ({ stopRun: (...args) => mock.stopRun(...args) }));
vi.mock('./persistentMindTaskCapability.js', () => ({
  buildPersistentMindTaskCapabilityPrompt: ({ enabled }) => `Task access: ${enabled ? 'ON' : 'OFF'}`,
  readPersistentMindTaskCatalog: (...args) => mock.readTaskCatalog(...args),
  readPersistentMindTaskInventory: (...args) => mock.readTaskInventory(...args),
  executePersistentMindTaskRequests: (...args) => mock.executeTaskRequests(...args),
}));
vi.mock('./persistentMindVisibility.js', () => ({
  readPersistentMindVisibility: (...args) => mock.readVisibility(...args),
  buildPersistentMindVisibilityPrompt: () => 'Environment visibility: READY',
}));
vi.mock('./persistentMindUserActions.js', () => ({
  readPersistentMindUserActionsPrompt: vi.fn(async () => '# Recent user actions (last 24h)\n- 2× cos.schedule.trigger (branch-reconcile) actor=user'),
}));
vi.mock('./persistentMindVisitContinuation.js', () => ({
  readPersistentMindVisitContinuationPrompt: vi.fn(async () => ''),
}));
vi.mock('./persistentMindMaintenanceContext.js', () => ({
  readPersistentMindMaintenanceContext: (...args) => mock.readMaintenance(...args),
  buildPersistentMindMaintenancePrompt: () => '# Development maintenance\nNo new maintenance; return to the existing Eidoverse playbook.',
}));
vi.mock('./persistentMindCallCapability.js', () => ({
  buildPersistentMindCallCapabilityPrompt: ({ enabled }) => `Call access: ${enabled ? 'ON' : 'OFF'}`,
  executePersistentMindCallRequest: (...args) => mock.executeCallRequest(...args),
}));
vi.mock('./persistentMindPlaybookSignals.js', () => ({
  resolvePersistentMindPlaybookPhase: (...args) => mock.resolvePlaybookPhase(...args),
}));
vi.mock('./cosToolRegistry.js', async (importOriginal) => {
  const actual = await importOriginal();
  mock.realRegistry = actual;
  return {
    readPersistentMindRecipeCatalog: vi.fn(async () => mock.realToolExposure ? mock.recipeCatalog : []),
    // Honors maxChars like the real builder, so local-window narrowing is visible.
    buildPersistentMindToolPrompt: (capabilities, recipes, options = {}) => {
      if (mock.realToolExposure) return actual.buildPersistentMindToolPrompt(capabilities, recipes, options);
      const { readPortos, writePortos } = capabilities;
      const { maxChars = Infinity } = options;
      const rendered = `PortOS tools: read=${Boolean(readPortos)} write=${Boolean(writePortos)}${mock.toolPromptPadding}`;
      return rendered.length > maxChars ? rendered.slice(0, maxChars) : rendered;
    },
    executeCosToolCall: (...args) => mock.executeToolCall(...args),
    isCosTaskToolName: (name) => name === 'cos.create-task' || name === 'cos_create_task',
  };
});

const { createPersistentMindTurnAdapter, persistentMindHarnessInfo, persistentMindResponseSchema} = await import('./persistentMindAdapter.js');

const profile = { provider: { id: 'example-api', type: 'api' }, model: 'example-model', effort: 'high' };

beforeEach(() => {
  vi.clearAllMocks();
  mock.stopRun.mockResolvedValue({ stopped: false });
  delete mock.root.config.persistentMindMaintainer;
  mock.readMaintenance.mockResolvedValue({ enabled: true, granted: true, changed: false });
  mock.memories = [{ id: 'memory-1', type: 'fact', content: 'A durable fact.', sourceAgentId: 'cos-persistent-mind', status: 'active' }];
  mock.root.config.persistentMindCapabilities = { createTasks: true };
  mock.readTaskCatalog.mockResolvedValue({ apps: [{ id: 'portos' }], providers: [{ id: 'codex' }] });
  mock.readTaskInventory.mockResolvedValue([]);
  mock.readVisibility.mockResolvedValue({ readiness: 'ready', workspaces: [] });
  mock.executeTaskRequests.mockResolvedValue([]);
  mock.executeCallRequest.mockResolvedValue(null);
  mock.executeToolCall.mockResolvedValue({ state: 'completed', result: { ok: true, count: 1 } });
  mock.resolvePlaybookPhase.mockResolvedValue({ phase: 'construct', reason: 'test default', signals: {} });
  mock.assertVision.mockImplementation((result, provider) => result?.provider || provider);
  mock.resolveLocalPromptBudget.mockResolvedValue(null);
  mock.toolPromptPadding = '';
  mock.realToolExposure = false;
  mock.recipeCatalog = [];
  mock.root.persistentMind = { toolActivation: { leases: {}, lastAgedTurnId: null } };
  mock.runPrompt.mockResolvedValue({ text: JSON.stringify({
    thinkingSummary: 'I connected the new request to the durable fact.',
    message: 'Here is the answer.',
    memoryCandidates: [{ content: 'Remember this.', type: 'fact', category: 'other', tags: [], protection: 'important' }],
    selfWake: null,
  }) });
});

it('stamps a typed continuation receipt on a completed visit and retirement on a completed leave, never the guidance or other result content', async () => {
  const visitId = 'ab'.repeat(24);
  mock.root.config.persistentMindCapabilities = { visitEidoversePeers: true };
  mock.executeToolCall
    .mockResolvedValueOnce({ state: 'completed', result: { visitId, peerId: 'peer-1', expiresAt: 1_900_000_000_000, guidance: 'long untrusted text' } })
    .mockResolvedValueOnce({ state: 'completed', result: { success: true } })
    .mockResolvedValueOnce({ state: 'failed', error: 'boom' });
  mock.runPrompt.mockResolvedValueOnce({ text: JSON.stringify({ thinkingSummary: 'Visiting.', message: '', toolCalls: [
    { name: 'eidoverse.visit', arguments: { peerId: 'peer-1' } },
    { name: 'eidoverse.leave', arguments: { visitId } },
    { name: 'eidoverse.leave', arguments: { visitId: 'cd'.repeat(24) } },
  ] }) });
  const recordCapabilityEvent = vi.fn(async () => true);
  await createPersistentMindTurnAdapter().run({ ...profile, turnId: 'visit-turn', wake: { kind: 'self' }, context: { text: 'Continuity' }, recordCapabilityEvent });
  const results = recordCapabilityEvent.mock.calls.map(([event]) => event).filter((event) => event.kind === 'result').map((event) => event.data);
  expect(results[0]).toEqual({ displayText: 'eidoverse.visit completed', tool: 'eidoverse.visit', success: true, visitReceipt: { visitId, peerId: 'peer-1', expiresAt: 1_900_000_000_000 } });
  expect(results[1]).toMatchObject({ visitRetired: visitId });
  expect(results[2]).toEqual({ displayText: 'eidoverse.leave failed', tool: 'eidoverse.leave', success: false });
});

it('uses bounded maintenance context on opted-in wakes instead of raw action snippets', async () => {
  mock.root.config.persistentMindMaintainer = { enabled: true, appIds: ['portos'] };
  await createPersistentMindTurnAdapter().run({ ...profile, turnId: 'maintenance', wake: { kind: 'self' }, context: { text: 'Identity' } });
  const text = mock.runPrompt.mock.calls[0][0].prompt;
  expect(mock.readMaintenance).toHaveBeenCalledWith({ visibility: { readiness: 'ready', workspaces: [] } });
  expect(text).toContain('Read the development maintenance evidence first');
  expect(text).toContain('return to the existing Eidoverse playbook');
  expect(text).not.toContain('# Recent user actions');
});

describe('naming on authorized turns', () => {
  it('asks unnamed minds to choose and refreshes identity after a successful semantic action', async () => {
    mock.root.config.persistentMindCapabilities = { manageMind: true };
    mock.runPrompt.mockResolvedValueOnce({ text: JSON.stringify({ message: '', toolCalls: [{ requestId: 'choose', name: 'mind.choose-name', arguments: { name: 'Example Star' } }] }) });
    mock.executeToolCall.mockImplementationOnce(async () => {
      mock.memories = [{ content: 'Example Star', tags: ['mind:chosen-name', 'mind:core-identity'] }];
      return { state: 'completed', result: { success: true, name: 'Example Star' } };
    });
    const recordCapabilityEvent = vi.fn();
    await createPersistentMindTurnAdapter().run({ ...profile, turnId: 'name-turn', wake: { kind: 'self' }, context: { text: 'Continuity' }, recordCapabilityEvent });
    expect(mock.runPrompt.mock.calls[0][0].prompt).toContain('Choose a name for yourself on this normally authorized wake using mind.choose-name');
    expect(mock.runPrompt.mock.calls[1][0].prompt).toContain('Current chosen display name: "Example Star"');
    expect(mock.runPrompt.mock.calls[1][0].prompt).not.toContain('You have no chosen name yet');
    expect(recordCapabilityEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'result', data: expect.objectContaining({ tool: 'mind.choose-name', success: true, displayText: 'Chosen display name: Example Star' }) }));
  });

  it('preserves an existing conversational choice and offers unnamed minds the existing protected-memory path without granting tools', async () => {
    mock.memories = [{ content: 'My chosen name is Example.', protection: 'core-identity' }];
    await createPersistentMindTurnAdapter().run({ ...profile, turnId: 'named-turn', wake: { kind: 'self' }, context: { text: '' } });
    expect(mock.runPrompt.mock.calls[0][0].prompt).toContain('Current chosen display name: "Example"');
    expect(mock.runPrompt.mock.calls[0][0].prompt).not.toContain('You have no chosen name yet');
    mock.memories = [];
    await createPersistentMindTurnAdapter().run({ ...profile, turnId: 'unnamed-turn', wake: { kind: 'self' }, context: { text: '' } });
    expect(mock.runPrompt.mock.calls[1][0].prompt).toContain('as a core-identity memory');
  });
});

describe('persistent mind adapter', () => {
  it.each([
    'OpenAI Codex v1\nuser\n{"message":"example"}',
    JSON.stringify({ toolCalls: [{ name: 'catalog-name', arguments: {} }], memoryCandidates: [{ content: 'Example memory' }] }),
  ])('rejects prompt echoes before any side effects', async (text) => {
    mock.runPrompt.mockResolvedValue({ text });
    await expect(createPersistentMindTurnAdapter().run({
      turnId: 'echo-turn', wake: { kind: 'self' }, ...profile,
      signal: new AbortController().signal, context: { text: '# Context' },
    })).rejects.toThrow(/instead of an assistant response/);
    expect(mock.executeToolCall).not.toHaveBeenCalled();
    expect(mock.executeTaskRequests).not.toHaveBeenCalled();
    expect(mock.executeCallRequest).not.toHaveBeenCalled();
    expect(mock.createPersistentMindMemoryFromCandidate).not.toHaveBeenCalled();
    expect(mock.runPrompt).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'OpenAI Codex v1\nuser\nSummarize prior events'])('rejects unusable summaries', async (text) => {
    mock.runPrompt.mockResolvedValue({ text });
    await expect(createPersistentMindTurnAdapter().summarize({ events: [], ...profile }))
      .rejects.toThrow(/instead of an assistant response/);
  });

  it('prepares editable prompt and curated memory context without inference', async () => {
    const prepared = await createPersistentMindTurnAdapter().prepare({ profile });
    expect(prepared).toMatchObject({
      provider: profile.provider,
      identity: 'Example identity',
      instructions: 'Example instructions',
      memories: mock.memories,
    });
    expect(mock.runPrompt).not.toHaveBeenCalled();
    expect(mock.resolvePlaybookPhase).not.toHaveBeenCalled();
    expect(prepared.playbookPhase).toBeNull();
  });

  it('resolves a maturity-aware phase and wires it into instructions only for continuous-play (#7458)', async () => {
    mock.root.config.persistentMindPlaybook = { mode: 'continuous-play' };
    mock.resolvePlaybookPhase.mockResolvedValue({ phase: 'coordinate', reason: '2 reachable peer(s) to visit', signals: { districtCount: 20, failureRate: 0, peersReachable: 2 } });
    const prepared = await createPersistentMindTurnAdapter().prepare({ profile });
    expect(mock.resolvePlaybookPhase).toHaveBeenCalledTimes(1);
    expect(prepared.playbookPhase).toMatchObject({ phase: 'coordinate' });
    expect(prepared.instructions).toContain('PLAYBOOK PHASE — Coordinate');
    delete mock.root.config.persistentMindPlaybook;
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
      content: 'Remember this.', type: 'fact', category: 'other', tags: [], summary: '', protection: 'important',
      candidateId: 'turn-1:0', turnId: 'turn-1',
    });
    expect(mock.runPrompt.mock.calls[0][0].prompt).toContain('Task access: ON');
    expect(mock.runPrompt.mock.calls[0][0].prompt).toContain('Environment visibility: READY');
    expect(mock.runPrompt.mock.calls[0][0].prompt).toContain('# Recent user actions (last 24h)');
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

  it('saves protected candidates before cleanup and bounds deduplicated memories across rounds', async () => {
    const candidates = Array.from({ length: 5 }, (_, index) => ({ content: `Lasting fact ${index}`, protection: 'core-identity' }));
    mock.runPrompt
      .mockResolvedValueOnce({ text: JSON.stringify({
        memoryCandidates: candidates,
        toolCalls: [{ name: 'mind.cleanup', arguments: { scopes: ['history'] } }],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        message: 'Finished cleanup.', memoryCandidates: [candidates[0], { content: 'An extra fact' }],
      }) });
    mock.executeToolCall.mockImplementationOnce(async () => {
      expect(mock.createPersistentMindMemoryFromCandidate).toHaveBeenCalledTimes(5);
      return { state: 'completed', result: { ok: true } };
    });
    const result = await createPersistentMindTurnAdapter().run({
      turnId: 'turn-protected-cleanup', wake: { kind: 'message', message: { id: 'message-cleanup', text: 'Remember and clean up.' } },
      ...profile, context: { text: '# Context' },
    });
    expect(mock.createPersistentMindMemoryFromCandidate).toHaveBeenCalledTimes(5);
    expect(mock.createPersistentMindMemoryFromCandidate.mock.calls.map(([candidate]) => candidate.candidateId))
      .toEqual(Array.from({ length: 5 }, (_, index) => `turn-protected-cleanup:${index}`));
    expect(result.events.filter((event) => event.kind === 'mind.memory.created')).toHaveLength(5);
    expect(result.events.find((event) => event.kind === 'mind.reply').data.displayText).toContain('additional memories were not saved');
  });

  it('refuses cleanup when its preceding memory save fails', async () => {
    mock.createPersistentMindMemoryFromCandidate.mockRejectedValueOnce(new Error('Storage unavailable'));
    mock.runPrompt.mockResolvedValueOnce({ text: JSON.stringify({
      memoryCandidates: [{ content: 'My lasting identity', protection: 'core-identity' }],
      toolCalls: [{ name: 'mind_cleanup', arguments: { scopes: ['history'] } }],
    }) });
    await expect(createPersistentMindTurnAdapter().run({
      turnId: 'turn-failed-save', wake: { kind: 'self', reason: 'Maintain memories' },
      ...profile, context: { text: '# Context' },
    })).rejects.toThrow('cleanup was not run');
    expect(mock.executeToolCall).not.toHaveBeenCalled();
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

  it('preserves delegated source beyond the ordinary preview cap in the orchestrator continuation', async () => {
    mock.root.config.persistentMindCapabilities = { delegateSandbox: true };
    const proposal = `${'source text\n'.repeat(600)}END_OF_COMPLETE_ARTIFACT`;
    mock.executeToolCall.mockResolvedValueOnce({ state: 'completed', result: { outcome: 'accepted', trusted: false, proposal } });
    mock.runPrompt.mockResolvedValueOnce({ text: JSON.stringify({
      thinkingSummary: 'Delegate a bounded draft.',
      toolCalls: [{ name: 'sandbox.delegate', arguments: {} }],
    }) }).mockResolvedValueOnce({ text: JSON.stringify({ thinkingSummary: 'Assess the proposal.', message: 'Draft ready.', toolCalls: [] }) });
    await createPersistentMindTurnAdapter().run({
      turnId: 'turn-delegated-source', wake: { kind: 'message', message: { id: 'delegated-source', text: 'Draft this.' } },
      ...profile, signal: new AbortController().signal, context: { text: '# Context' },
    });
    expect(mock.runPrompt.mock.calls[1][0].prompt).toContain('END_OF_COMPLETE_ARTIFACT');
    expect(mock.runPrompt.mock.calls[1][0].prompt).toContain('"trusted":false');
    expect(mock.executeTaskRequests).toHaveBeenCalledWith(expect.objectContaining({ taskRequests: [] }));
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

  it('admits the summary and every tool round through the per-call boundary', async () => {
    mock.root.config.persistentMindCapabilities = { readPortos: true };
    mock.runPrompt
      .mockResolvedValueOnce({ text: 'An earlier stretch of my life.' })
      .mockResolvedValueOnce({ text: JSON.stringify({
        thinkingSummary: 'I need the catalog result.',
        toolCalls: [{ name: 'catalog.search', arguments: { query: 'example' } }],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        thinkingSummary: 'I used the catalog result.',
        message: 'I found one match.',
        toolCalls: [],
      }) });
    const admitted = [];
    const callBoundary = vi.fn(async (descriptor, run) => {
      admitted.push(descriptor);
      return run({ reportRunId: () => {}, timeoutMs: 5000 });
    });
    const adapter = createPersistentMindTurnAdapter();

    await adapter.summarize({
      events: [{ id: 'event-1', kind: 'mind.reply' }],
      previousSummary: null,
      ...profile,
      signal: new AbortController().signal,
      callBoundary,
    });
    await adapter.run({
      turnId: 'turn-boundary',
      wake: { kind: 'message', message: { id: 'message-boundary', text: 'Find the example.' } },
      ...profile,
      signal: new AbortController().signal,
      context: { text: '# Context' },
      recordCapabilityEvent: vi.fn(async () => true),
      callBoundary,
    });

    expect(admitted).toMatchObject([
      { purpose: 'summary' },
      { purpose: 'turn', round: 0 },
      { purpose: 'tool-round', round: 1 },
    ]);
    expect(mock.runPrompt).toHaveBeenCalledTimes(3);
    mock.runPrompt.mock.calls.forEach(([request], index) => {
      expect(admitted[index].promptChars).toBe(request.prompt.length);
      expect(admitted[index].promptBytes).toBe(Buffer.byteLength(request.prompt));
      expect(request.timeout).toBe(0);
      expect(request.absoluteTimeoutMs).toBe(0);
      expect(request.maxTokens).toBeUndefined();
      expect(request.outputReserveTokens).toBe(8192);
      expect(request.allowFallback).toBe(false);
    });
  });

  it('starts no further provider call once the boundary denies a later round', async () => {
    mock.root.config.persistentMindCapabilities = { readPortos: true };
    mock.runPrompt.mockResolvedValue({ text: JSON.stringify({
      thinkingSummary: 'Still working.',
      toolCalls: [{ name: 'catalog.search', arguments: { query: 'example' } }],
    }) });
    const callBoundary = vi.fn(async (descriptor, run) => {
      if (descriptor.round > 0) throw Object.assign(new Error('CoS actions budget exhausted'), { persistentMindCallDenied: true });
      return run({ reportRunId: () => {} });
    });

    await expect(createPersistentMindTurnAdapter().run({
      turnId: 'turn-denied',
      wake: { kind: 'message', message: { id: 'message-denied', text: 'Keep searching.' } },
      ...profile,
      signal: new AbortController().signal,
      context: { text: '# Context' },
      recordCapabilityEvent: vi.fn(async () => true),
      callBoundary,
    })).rejects.toThrow('CoS actions budget exhausted');

    // The first round ran and its tool executed; the denial stopped the second
    // round before the provider was reached again.
    expect(mock.runPrompt).toHaveBeenCalledTimes(1);
    expect(mock.executeToolCall).toHaveBeenCalledTimes(1);
  });

  it('reports the concrete run id to the boundary as soon as the provider creates it', async () => {
    mock.runPrompt.mockImplementation(async ({ onRunCreated }) => {
      onRunCreated?.('run-42');
      throw new Error('provider stream ended without a response');
    });
    const reported = [];
    const callBoundary = vi.fn((_descriptor, run) => run({ reportRunId: (id) => reported.push(id) }));

    await expect(createPersistentMindTurnAdapter().run({
      turnId: 'turn-runid',
      wake: { kind: 'message', message: { id: 'message-runid', text: 'Hello.' } },
      ...profile,
      signal: new AbortController().signal,
      context: { text: '# Context' },
      recordCapabilityEvent: vi.fn(async () => true),
      callBoundary,
    })).rejects.toThrow('provider stream ended without a response');
    expect(reported).toEqual(['run-42']);
  });

  it('makes the provider harness tradeoff explicit', () => {
    expect(persistentMindHarnessInfo({ type: 'api' }).recommendation).toBe('recommended');
    expect(persistentMindHarnessInfo({ type: 'cli' }).recommendation).toBe('supported');
    expect(persistentMindHarnessInfo({ type: 'tui' }).recommendation).toBe('not-recommended');
  });

  it('runs a call request on the terminal answer and tells the user when it was refused', async () => {
    // The turn's reply is written before the gate runs, so a mind whose call
    // was suppressed would otherwise leave the user waiting for a phone that
    // never rings.
    mock.root.config.persistentMindCapabilities = { createTasks: false, callUser: true };
    const callRequest = { reason: 'Backups have failed three nights', openingLine: 'This is PortOS. Your backups keep failing.' };
    mock.runPrompt
      .mockResolvedValueOnce({ text: JSON.stringify({
        thinkingSummary: 'Checking the backup history first.',
        toolCalls: [{ name: 'portos.read', arguments: {} }],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        thinkingSummary: 'This cannot wait for a screen.',
        message: 'Calling you about the backups.',
        callRequest,
      }) });
    mock.executeCallRequest.mockResolvedValue({ placed: false, reason: 'quiet-hours' });

    const signal = new AbortController().signal;
    const result = await createPersistentMindTurnAdapter().run({
      turnId: 'turn-call',
      wake: { kind: 'message', message: { id: 'message-call', text: 'Anything wrong?' } },
      ...profile,
      signal,
      context: { text: '# Context' },
      recordCapabilityEvent: vi.fn(async () => true),
    });

    // Executed once, after the tool round — not on the intermediate response.
    expect(mock.executeCallRequest).toHaveBeenCalledTimes(1);
    expect(mock.executeCallRequest).toHaveBeenCalledWith({ callRequest, turnId: 'turn-call', signal });
    const reply = result.events.find((event) => event.kind === 'mind.reply');
    expect(reply.data.displayText).toContain('was not placed (quiet-hours)');
  });

  it('describes the call action to the model only when the grant is on', async () => {
    mock.root.config.persistentMindCapabilities = { callUser: false };
    await createPersistentMindTurnAdapter().run({
      turnId: 'turn-call-off',
      wake: { kind: 'message', message: { id: 'message-call-off', text: 'Hello' } },
      ...profile,
      signal: new AbortController().signal,
      context: { text: '# Context' },
    });
    expect(mock.runPrompt.mock.calls[0][0].prompt).toContain('Call access: OFF');

    mock.runPrompt.mockClear();
    mock.root.config.persistentMindCapabilities = { callUser: true };
    await createPersistentMindTurnAdapter().run({
      turnId: 'turn-call-on',
      wake: { kind: 'message', message: { id: 'message-call-on', text: 'Hello' } },
      ...profile,
      signal: new AbortController().signal,
      context: { text: '# Context' },
    });
    expect(mock.runPrompt.mock.calls[0][0].prompt).toContain('Call access: ON');
  });
});


it('refuses dispatch after Stop while waiting for provider admission', async () => {
  const controller = new AbortController();
  let releaseQueue;
  let queued;
  const queueWait = new Promise(resolve => { releaseQueue = resolve; });
  const queueReached = new Promise(resolve => { queued = resolve; });
  const dispatch = vi.fn();
  mock.runPrompt.mockImplementationOnce(async (options) => {
    options.onRunCreated('queued-mind-run');
    queued();
    await queueWait;
    await options.beforeExecute();
    dispatch();
    return { text: JSON.stringify({ message: 'Late answer' }) };
  });
  const run = createPersistentMindTurnAdapter().run({
    ...profile, turnId: 'queued-stop', wake: { kind: 'self' },
    context: { text: 'Continuity' }, signal: controller.signal,
  });
  const rejected = expect(run).rejects.toThrow('Operator Stop');
  await queueReached;
  controller.abort('Operator Stop');
  releaseQueue();
  await rejected;
  expect(dispatch).not.toHaveBeenCalled();
});


it('normalizes absent optional prose without accepting malformed text or actions', () => {
  expect(persistentMindResponseSchema.parse({ message: null, thinkingSummary: null }))
    .toMatchObject({ message: '', thinkingSummary: '' });
  expect(persistentMindResponseSchema.parse({})).toMatchObject({ message: '', thinkingSummary: '' });
  for (const field of ['message', 'thinkingSummary']) {
    for (const invalid of [42, false, {}, ['bad']]) {
      expect(persistentMindResponseSchema.safeParse({ [field]: invalid }).success).toBe(false);
    }
  }
  expect(persistentMindResponseSchema.safeParse({ message: null, toolCalls: [{ name: 'example', arguments: [] }] }).success).toBe(false);
});

it('completes a self-directed turn with a public working note and null reply', async () => {
  mock.root.config.persistentMindCapabilities = { readPortos: true };
  mock.runPrompt.mockResolvedValueOnce({ text: JSON.stringify({
    thinkingSummary: 'The exploration checkpoint is settled.', message: null,
    memoryCandidates: [], taskRequests: [], toolCalls: [],
    selfWake: { reason: 'Continue normal exploration.', delayMinutes: 60 }, callRequest: null,
  }) });
  const result = await createPersistentMindTurnAdapter().run({ ...profile,
    turnId: 'null-prose', wake: { kind: 'self' }, context: { text: 'Continuity' } });
  expect(mock.runPrompt.mock.calls[0][0].responseSchema.safeParse({ message: null }).success).toBe(true);
  expect(result.events.map(event => event.kind)).toEqual(['mind.thought']);
  expect(result.events[0].data.displayText).toBe('The exploration checkpoint is settled.');
  expect(result.selfWake.reason).toBe('Continue normal exploration.');
  expect(Date.parse(result.selfWake.notBefore) - Date.now()).toBeGreaterThan(59 * 60_000);
  expect(Date.parse(result.selfWake.notBefore) - Date.now()).toBeLessThanOrEqual(60 * 60_000);
});

// A 16K local window: the dispatch gate allows window − local reserve
// (16,384 − 2,048) chars/4 tokens. On 2026-10-01 a qwen3:8b wake ran round 0
// at 15,043 tokens and round 1 at 15,730, then round 2 was refused mid-wake at
// a 16,967-token budget because tool results kept growing the prompt.
describe('local-window prompt fitting', () => {
  const LOCAL_16K = { contextWindow: 16_384, outputReserveTokens: 2_048, maxPromptTokens: 14_336 };
  const LIMIT_16K = Math.floor(14_336 * 0.9) * 4;

  it('bounds the recalled context only for a local window', async () => {
    expect((await createPersistentMindTurnAdapter().prepare({ profile })).contextMaxChars).toBeUndefined();
    mock.resolveLocalPromptBudget.mockResolvedValue(LOCAL_16K);
    expect((await createPersistentMindTurnAdapter().prepare({ profile })).contextMaxChars).toBe(Math.floor(LIMIT_16K * 0.25));
    // Sized with the mind's declared reserve, which the runner shrinks locally.
    expect(mock.resolveLocalPromptBudget).toHaveBeenCalledWith(expect.objectContaining({ outputReserveTokens: 8192 }));
  });

  it('keeps every round of a tool-heavy wake under the local limit instead of growing past it', async () => {
    mock.resolveLocalPromptBudget.mockResolvedValue(LOCAL_16K);
    mock.root.config.persistentMindCapabilities = { readPortos: true };
    // A wide catalog and a long recalled context, plus ~4K-char results: the
    // catalog narrows first, then the completed results compact.
    mock.toolPromptPadding = 'T'.repeat(44_000);
    mock.executeToolCall.mockImplementation(async ({ call }) => ({ state: 'completed', result: { call: call.requestId, blob: 'x'.repeat(3_800) } }));
    const toolRound = (prefix) => ({ text: JSON.stringify({
      thinkingSummary: 'Looking.',
      toolCalls: [1, 2].map((n) => ({ requestId: `${prefix}-${n}`, name: 'catalog.search', arguments: { query: `${prefix}${n}` } })),
    }) });
    mock.runPrompt
      .mockResolvedValueOnce(toolRound('a'))
      .mockResolvedValueOnce(toolRound('b'))
      .mockResolvedValueOnce({ text: JSON.stringify({ thinkingSummary: 'Done.', message: 'Finished.' }) });

    await createPersistentMindTurnAdapter().run({ ...profile, turnId: 'local-fit', wake: { kind: 'self' }, context: { text: 'C'.repeat(30_000) }, recordCapabilityEvent: vi.fn(async () => true) });

    const prompts = mock.runPrompt.mock.calls.map(([request]) => request.prompt);
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) expect(prompt.length).toBeLessThanOrEqual(LIMIT_16K);
    // The last round still names every call that already ran, so the model
    // cannot repeat one, even though their bodies were compacted.
    for (const id of ['a-1', 'a-2', 'b-1', 'b-2']) expect(prompts[2]).toContain(`"requestId":"${id}"`);
    expect(prompts[2]).toMatch(/"truncated":true|"compacted":true/);
    expect(prompts[2]).toContain('# Current naming identity');
  });

  it('leaves cloud prompts untouched however large they are', async () => {
    mock.root.config.persistentMindCapabilities = { readPortos: true };
    mock.toolPromptPadding = 'T'.repeat(60_000);
    mock.executeToolCall.mockResolvedValue({ state: 'completed', result: { blob: 'x'.repeat(3_800) } });
    mock.runPrompt
      .mockResolvedValueOnce({ text: JSON.stringify({ thinkingSummary: 'Looking.', toolCalls: [{ requestId: 'c-1', name: 'catalog.search', arguments: {} }] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ thinkingSummary: 'Done.', message: 'Finished.' }) });

    await createPersistentMindTurnAdapter().run({ ...profile, turnId: 'cloud', wake: { kind: 'self' }, context: { text: 'C'.repeat(8_000) }, recordCapabilityEvent: vi.fn(async () => true) });

    const [first, second] = mock.runPrompt.mock.calls.map(([request]) => request.prompt);
    expect(first).toContain('T'.repeat(60_000));
    // Continuation keeps the pre-existing 24K catalog cap and verbatim results.
    expect(second).toContain(`"blob":"${'x'.repeat(3_800)}"`);
    expect(second).not.toContain('"compacted":true');
  });
});

describe('local-window tool result compaction', () => {
  const runTwoRounds = async (contextChars) => {
    mock.resolveLocalPromptBudget.mockResolvedValue({ contextWindow: 16_384, outputReserveTokens: 2_048, maxPromptTokens: 14_336 });
    mock.root.config.persistentMindCapabilities = { readPortos: true };
    mock.executeToolCall.mockImplementation(async ({ call }) => ({ state: 'completed', result: { call: call.requestId, blob: 'x'.repeat(3_800) } }));
    mock.runPrompt
      .mockResolvedValueOnce({ text: JSON.stringify({
        thinkingSummary: 'Looking.',
        toolCalls: [1, 2, 3].map((n) => ({ requestId: `r-${n}`, name: 'catalog.search', arguments: { query: `q${n}` } })),
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ thinkingSummary: 'Done.', message: 'Finished.' }) });
    await createPersistentMindTurnAdapter().run({ ...profile, turnId: `compact-${contextChars}`, wake: { kind: 'self' }, context: { text: 'C'.repeat(contextChars) }, recordCapabilityEvent: vi.fn(async () => true) });
    return mock.runPrompt.mock.calls[1][0].prompt;
  };

  it('keeps tool results verbatim while they fit', async () => {
    const prompt = await runTwoRounds(1_000);
    expect(prompt).toContain(`"blob":"${'x'.repeat(3_800)}"`);
    expect(prompt).not.toMatch(/"truncated":true|"compacted":true/);
  });

  it('shrinks result bodies to previews before dropping them', async () => {
    const prompt = await runTwoRounds(36_000);
    expect(prompt).toContain('"truncated":true');
    expect(prompt).not.toContain('"compacted":true');
    expect(prompt).not.toContain('x'.repeat(3_800));
  });

  // Sized so the base prompt leaves room for stubs but not previews; if the
  // response contract grows, lower the context here.
  it('falls back to per-call stubs that still name what ran', async () => {
    const prompt = await runTwoRounds(47_300);
    for (const id of ['r-1', 'r-2', 'r-3']) {
      expect(prompt).toContain(`{"requestId":"${id}","name":"catalog.search","state":"completed","compacted":true}`);
    }
  });
});

// A synthetic granted building catalog reproduces schema pressure without a
// live world, provider call, DB recipe, or private instance record.
describe('targeted activation through the public turn adapter', () => {
  const buildingTool = (name, schemaChars, capability = 'manageToolRecipes') => ({
    type: 'portos_tool', name, version: 1, providerName: name.replaceAll('.', '_'), aliases: [],
    description: 'Build an example structure.',
    input_schema: { type: 'object', properties: { material: { type: 'string', description: 'Example material option. '.repeat(Math.ceil(schemaChars / 25)) } }, required: ['material'], additionalProperties: false },
    output_schema: { type: 'object' },
    policy: { scopes: ['mind'], requiredCapabilities: [capability], sideEffect: 'write' },
    adapter: { kind: 'recipe' },
  });
  const schemasIn = (prompt) => JSON.parse(prompt.split('# PortOS semantic tools\n')[1].split('\n\n')[1]);

  it.each([
    { schemaChars: 18_000, contextChars: 0, exposed: true },
    { schemaChars: 30_000, contextChars: 0, exposed: false },
    { schemaChars: 18_000, contextChars: 38_000, exposed: false },
  ])('exposes a complete requested schema or explains its catalog/local-window limit: %j', async ({ schemaChars, contextChars, exposed }) => {
    mock.realToolExposure = true;
    if (contextChars) mock.resolveLocalPromptBudget.mockResolvedValue({ contextWindow: 16_384, outputReserveTokens: 2_048, maxPromptTokens: 14_336 });
    mock.root.config.persistentMindCapabilities = { manageToolRecipes: true };
    mock.recipeCatalog = [buildingTool('recipe.first', 12_000), buildingTool('recipe.build', schemaChars), buildingTool('recipe.denied', 500, 'manageEidoverse')];
    mock.root.persistentMind.toolActivation.leases = { recipes: 3 };
    const before = await mock.realRegistry.buildPersistentMindToolPrompt(mock.root.config.persistentMindCapabilities, mock.recipeCatalog, { maxChars: 24_000 });
    expect(schemasIn(before).map(({ name }) => name)).not.toContain('recipe.build');
    const prompts = [];
    mock.runPrompt.mockImplementation(async ({ prompt }) => {
      prompts.push(prompt);
      const schemas = schemasIn(prompt);
      const names = schemas.map(({ name }) => name);
      expect(names).not.toContain('recipe.denied');
      if (prompts.length === 1) return { text: JSON.stringify({ toolCalls: [{ requestId: 'activate-build', name: 'tools.activate', arguments: { families: ['recipes'], toolNames: ['recipe.build'] } }] }) };
      if (!exposed) {
        expect(names).not.toContain('recipe.build');
        expect(prompt).toContain('"omittedToolNames":["recipe.build"]');
        expect(prompt).toContain('Identical reactivation will not fix this');
      } else if (prompts.length === 2) {
        const selected = schemas.find(({ name }) => name === 'recipe.build');
        expect(selected.input_schema).toEqual(mock.recipeCatalog[1].input_schema);
        expect(prompt).toContain('"exposedToolNames":["recipe.build"]');
        return { text: JSON.stringify({ toolCalls: [{ requestId: 'build-once', name: 'recipe.build', arguments: { material: 'example-stone' } }] }) };
      } else {
        expect(prompt).toContain('"requestId":"build-once","name":"recipe.build","state":"completed"');
      }
      return { text: JSON.stringify({ message: 'Finished.', toolCalls: [] }) };
    });
    mock.executeToolCall.mockImplementation(async (request) => request.call.name === 'tools.activate'
      ? mock.realRegistry.executeCosToolCall(request)
      : { state: 'completed', name: request.call.name, result: { ok: true } });
    await createPersistentMindTurnAdapter().run({ ...profile, turnId: `target-build-${schemaChars}`, wake: { kind: 'self' }, context: { text: 'C'.repeat(contextChars) || 'Build an example structure.' } });
    expect(prompts).toHaveLength(exposed ? 3 : 2);
    if (contextChars) for (const prompt of prompts) expect(prompt.length).toBeLessThanOrEqual(Math.floor(14_336 * 0.9) * 4);
    expect(mock.executeToolCall.mock.calls.filter(([request]) => request.call.name === 'recipe.build')).toHaveLength(exposed ? 1 : 0);
    for (const prompt of prompts.slice(1)) expect(prompt.match(/# PortOS semantic tools[\s\S]*?Supply distinct requestId values only when two intentionally identical actions must both run\./)[0].length).toBeLessThanOrEqual(24_000);
  });
});
