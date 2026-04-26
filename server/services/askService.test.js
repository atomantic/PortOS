import { describe, it, expect, vi, beforeEach } from 'vitest';

// All upstream services are mocked so the unit under test is the
// orchestration logic itself: parallel retrieval, ranking, prompt assembly,
// and stream-event shape.

vi.mock('./providers.js', () => ({
  getActiveProvider: vi.fn(),
  getProviderById: vi.fn(),
}));

vi.mock('./memoryBackend.js', () => ({
  hybridSearchMemories: vi.fn(),
  getMemory: vi.fn(),
}));

vi.mock('./memoryEmbeddings.js', () => ({
  generateQueryEmbedding: vi.fn(),
}));

vi.mock('./brainStorage.js', () => ({
  getInboxLog: vi.fn(),
  getProjects: vi.fn(),
  getIdeas: vi.fn(),
}));

vi.mock('./autobiography.js', () => ({
  getStories: vi.fn(),
}));

vi.mock('./identity.js', () => ({
  getGoals: vi.fn(),
}));

vi.mock('./character.js', () => ({
  getCharacter: vi.fn(),
}));

vi.mock('./calendarSync.js', () => ({
  getEvents: vi.fn(),
}));

const memoryBackend = await import('./memoryBackend.js');
const memoryEmbeddings = await import('./memoryEmbeddings.js');
const brainStorage = await import('./brainStorage.js');
const autobiography = await import('./autobiography.js');
const identity = await import('./identity.js');
const character = await import('./character.js');
const calendarSync = await import('./calendarSync.js');
const providers = await import('./providers.js');

const askService = await import('./askService.js');

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible defaults — each test overrides what it cares about.
  memoryEmbeddings.generateQueryEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  memoryBackend.hybridSearchMemories.mockResolvedValue({ memories: [] });
  memoryBackend.getMemory.mockResolvedValue(null);
  brainStorage.getInboxLog.mockResolvedValue([]);
  brainStorage.getProjects.mockResolvedValue([]);
  brainStorage.getIdeas.mockResolvedValue([]);
  autobiography.getStories.mockResolvedValue([]);
  identity.getGoals.mockResolvedValue({ goals: [] });
  character.getCharacter.mockResolvedValue({ name: 'Adam', class: 'Developer' });
  calendarSync.getEvents.mockResolvedValue({ events: [] });
});

describe('gatherSources', () => {
  it('returns memories with stable ids and tagged kind', async () => {
    memoryBackend.hybridSearchMemories.mockResolvedValue({
      memories: [{ id: 'mem-1', rrfScore: 0.9 }, { id: 'mem-2', rrfScore: 0.7 }],
    });
    memoryBackend.getMemory.mockImplementation((id) => Promise.resolve({
      id,
      content: `body of ${id}`,
      summary: `summary ${id}`,
      type: 'fact',
    }));

    const sources = await askService.gatherSources('what did i decide about X');
    expect(sources).toHaveLength(2);
    expect(sources[0].kind).toBe('memory');
    expect(sources[0].id).toBe('memory:mem-1');
  });

  it('keeps producing answers when one retriever throws', async () => {
    // Memory throws — brain notes still surface.
    memoryBackend.hybridSearchMemories.mockRejectedValue(new Error('vector backend down'));
    brainStorage.getIdeas.mockResolvedValue([
      { id: 'idea-1', title: 'Move workout to mornings', description: 'shift to AM for better adherence' },
    ]);

    const sources = await askService.gatherSources('move workout to mornings');
    expect(sources.length).toBeGreaterThan(0);
    expect(sources[0].kind).toBe('brain-note');
  });

  it('dedupes by source id when a retriever returns the same hit twice', async () => {
    // Hybrid memory search can occasionally return the same record twice
    // (BM25 + vector hits both surface it before RRF) — the merged source
    // list should only carry one copy regardless.
    memoryBackend.hybridSearchMemories.mockResolvedValue({
      memories: [
        { id: 'mem-dup', rrfScore: 0.9 },
        { id: 'mem-dup', rrfScore: 0.8 },
      ],
    });
    memoryBackend.getMemory.mockResolvedValue({
      id: 'mem-dup',
      content: 'workout decision',
      summary: 'workout',
    });

    const sources = await askService.gatherSources('workout');
    const memorySources = sources.filter((s) => s.id === 'memory:mem-dup');
    expect(memorySources).toHaveLength(1);
  });

  it('caps the result list to maxSources', async () => {
    // Generate 20 idea-style brain notes, all matching the question.
    brainStorage.getIdeas.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({
        id: `idea-${i}`,
        title: `workout idea ${i}`,
        description: 'workout details',
      })),
    );
    const sources = await askService.gatherSources('workout details', { maxSources: 3 });
    expect(sources).toHaveLength(3);
  });

  it('ranks active goals when lexical match is weak', async () => {
    identity.getGoals.mockResolvedValue({
      goals: [
        { id: 'g-1', title: 'Run a marathon', description: 'finish a 26.2', status: 'active', horizon: 'year' },
        { id: 'g-2', title: 'Watch movies', description: 'leisure', status: 'archived', horizon: 'month' },
      ],
    });
    const sources = await askService.gatherSources('marathon training');
    expect(sources.find((s) => s.id === 'goal:g-1')).toBeDefined();
  });
});

describe('buildPrompt', () => {
  it('composes persona + directive + sources + question', async () => {
    const sources = [
      { kind: 'memory', id: 'memory:1', title: 'Past decision', snippet: 'I decided to ship slice (a) first.' },
      { kind: 'goal', id: 'goal:g-1', title: 'Run a marathon', snippet: 'horizon: year · status: active' },
    ];
    const prompt = await askService.buildPrompt({ question: 'What should I do today?', mode: 'advise', sources });
    expect(prompt).toContain('digital twin');
    expect(prompt).toContain('What should I do today?');
    expect(prompt).toContain('[1] memory — Past decision');
    expect(prompt).toContain('[2] goal — Run a marathon');
    // 'advise' directive is distinct from 'ask' so a typo in mode wiring would catch.
    expect(prompt).toContain('advising');
  });

  it('inlines history for multi-turn context', async () => {
    const prompt = await askService.buildPrompt({
      question: 'Follow-up?',
      mode: 'ask',
      sources: [],
      history: [
        { role: 'user', content: 'previous question' },
        { role: 'assistant', content: 'previous answer' },
      ],
    });
    expect(prompt).toContain('previous question');
    expect(prompt).toContain('previous answer');
  });

  it('falls back to a generic persona when character is absent', async () => {
    character.getCharacter.mockResolvedValue(null);
    const preamble = await askService.buildPersonaPreamble();
    expect(preamble).toMatch(/digital twin/i);
  });
});

describe('runAsk', () => {
  // Minimal API-shaped provider; fetch is mocked to return the SSE response.
  function fakeStreamProvider() {
    return {
      id: 'fake',
      type: 'api',
      enabled: true,
      apiKey: 'k',
      endpoint: 'https://example.test/v1',
      defaultModel: 'fake-model',
      timeout: 5000,
    };
  }

  function buildSSEResponse(deltas) {
    const encoder = new TextEncoder();
    const frames = deltas.map((d) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`
    ).concat('data: [DONE]\n\n');
    return new Response(new ReadableStream({
      start(ctrl) {
        for (const f of frames) ctrl.enqueue(encoder.encode(f));
        ctrl.close();
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  it('emits sources, deltas, then done', async () => {
    providers.getActiveProvider.mockResolvedValue(fakeStreamProvider());
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(buildSSEResponse(['Hello, ', 'world.']));

    const events = [];
    for await (const evt of askService.runAsk({ question: 'hi' })) {
      events.push(evt);
    }
    fetchSpy.mockRestore();

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('sources');
    expect(types).toContain('delta');
    expect(types[types.length - 1]).toBe('done');
    const fullText = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    expect(fullText).toBe('Hello, world.');
  });

  it('emits an error event for an empty question', async () => {
    const events = [];
    for await (const evt of askService.runAsk({ question: '   ' })) events.push(evt);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
  });

  it('emits an error when no provider is available', async () => {
    providers.getActiveProvider.mockResolvedValue(null);
    const events = [];
    for await (const evt of askService.runAsk({ question: 'hi' })) events.push(evt);
    // Expect one sources event then a terminating error.
    expect(events.find((e) => e.type === 'error')).toBeDefined();
    expect(events.find((e) => e.type === 'done')).toBeUndefined();
  });
});
