import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cosEvents } from './cos/cosEvents.js';
import { getDomainAutonomyMode } from './cos/cosState.js';
import { getDomainBudgetStatus, recordDomainUsage } from './domainUsage.js';
import { createMemory, getMemories, searchMemories, withPendingMemories } from './memoryBackend.js';
import { classifyMemories, getConfig } from './memoryClassifier.js';
import { getSettings } from './settings.js';
import { getProviderById } from './provider/providers.js';
import { runPromptThroughProvider } from './promptRunner.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { generateMemoryEmbedding } from './memoryEmbeddings.js';
import { extractAndStoreMemories } from './memoryExtractor.js';
import * as notifications from './notifications.js';

vi.mock('./cos/cosState.js', () => ({ getDomainAutonomyMode: vi.fn() }));
vi.mock('./domainUsage.js', () => ({
  getDomainBudgetStatus: vi.fn(),
  recordDomainUsage: vi.fn()
}));
vi.mock('./memoryBackend.js', () => ({
  createMemory: vi.fn(),
  withPendingMemories: vi.fn(),
  getMemories: vi.fn(),
  searchMemories: vi.fn()
}));
vi.mock('./memoryClassifier.js', () => ({ classifyMemories: vi.fn(), getConfig: vi.fn() }));
vi.mock('./settings.js', () => ({ getSettings: vi.fn() }));
vi.mock('./provider/providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('./promptRunner.js', () => ({ runPromptThroughProvider: vi.fn() }));
vi.mock('./promptService.js', () => ({ getStageTemplate: async () => 'Analyze {{agentOutput}}' }));
vi.mock('../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: vi.fn() }));
vi.mock('./memoryEmbeddings.js', () => ({ generateMemoryEmbedding: vi.fn() }));
vi.mock('./review.js', () => ({ createMemoryApprovalItem: vi.fn() }));
vi.mock('./notifications.js', async () => ({
  NOTIFICATION_TYPES: (await import('../lib/notificationTypes.js')).NOTIFICATION_TYPES,
  PRIORITY_LEVELS: { MEDIUM: 'medium' },
  exists: vi.fn(),
  addNotification: vi.fn()
}));

const agentId = 'agent-example';
const taskId = 'task-example';
const task = { id: taskId, description: 'Review a sample report', metadata: { app: 'example-app' } };
const output = 'The sample report review is complete.';
const fallbackOutput = [
  '<MEMORY type="learning" category="communication" confidence="0.92">',
  'Reviewers benefit from a written recap before group discussion.',
  'Tags: reviews, communication',
  '</MEMORY>',
  'The user prefers a written decision log for every handoff.',
  'The user wants a status badge with 16px spacing.',
  'The user pushed back on unexplained changes to team priorities.'
].join('\n');
const embedding = [0.1, 0.2, 0.3];
const approvalNeeded = vi.fn();
const extracted = vi.fn();

function preference(content, confidence) {
  return { type: 'preference', category: 'workflow', content, confidence, tags: ['workflow'] };
}

describe('extractAndStoreMemories', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getDomainAutonomyMode.mockResolvedValue('execute');
    getDomainBudgetStatus.mockResolvedValue({ withinBudget: true });
    recordDomainUsage.mockResolvedValue(undefined);
    getConfig.mockResolvedValue({ fallbackToPatterns: true });
    generateMemoryEmbedding.mockResolvedValue(embedding);
    getMemories.mockResolvedValue({ memories: [] });
    searchMemories.mockResolvedValue({ memories: [] });
    createMemory.mockImplementation(async data => ({
      ...data,
      id: `memory-${createMemory.mock.calls.length}`,
      status: data.status || 'active'
    }));
    withPendingMemories.mockImplementation(async (ids, publish) => {
      const created = await Promise.all(createMemory.mock.results.map(result => result.value));
      return publish(created.filter(memory => ids.includes(memory.id)));
    });
    notifications.exists.mockResolvedValue(false);
    cosEvents.on('memory:approval-needed', approvalNeeded);
    cosEvents.on('memory:extracted', extracted);
  });

  afterEach(() => {
    cosEvents.off('memory:approval-needed', approvalNeeded);
    cosEvents.off('memory:extracted', extracted);
    vi.useRealTimers();
  });

  it.each([
    { mode: 'off', withinBudget: true, skipped: 'domain-off' },
    { mode: 'execute', withinBudget: false, skipped: 'domain-budget' }
  ])('skips all extraction side effects for $skipped', async ({ mode, withinBudget, skipped }) => {
    getDomainAutonomyMode.mockResolvedValue(mode);
    getDomainBudgetStatus.mockResolvedValue({ withinBudget, exceeded: 'actions' });
    classifyMemories.mockResolvedValue({ usedLLM: true, memories: [preference('Written summaries before meetings', 0.9)] });

    await expect(extractAndStoreMemories(agentId, taskId, output, task)).resolves.toEqual({
      created: 0, pendingApproval: 0, memories: [], pendingMemories: [], skipped
    });

    expect(getDomainAutonomyMode).toHaveBeenCalledWith('memory');
    if (mode === 'off') {
      expect(getDomainBudgetStatus).not.toHaveBeenCalled();
    } else {
      expect(getDomainBudgetStatus).toHaveBeenCalledExactlyOnceWith('memory');
    }
    expect(classifyMemories).not.toHaveBeenCalled();
    expect(generateMemoryEmbedding).not.toHaveBeenCalled();
    expect(getMemories).not.toHaveBeenCalled();
    expect(searchMemories).not.toHaveBeenCalled();
    expect(createMemory).not.toHaveBeenCalled();
    expect(notifications.addNotification).not.toHaveBeenCalled();
    expect(approvalNeeded).not.toHaveBeenCalled();
    expect(extracted).not.toHaveBeenCalled();
    expect(recordDomainUsage).not.toHaveBeenCalled();
  });

  it('stores and queues memories from the assigned Ollama model without contacting LM Studio', async () => {
    classifyMemories.mockImplementation((await vi.importActual('./memoryClassifier.js')).classifyMemories);
    const provider = { id: 'ollama', type: 'api', enabled: true, defaultModel: 'unselected-model' };
    getSettings.mockResolvedValue({ memoryClassifier: { providerId: provider.id, model: 'qwen3:8b' } });
    getProviderById.mockResolvedValue(provider);
    const active = preference('Written summaries before meetings', 0.9);
    const pending = preference('One owner for each follow-up', 0.8);
    runPromptThroughProvider.mockResolvedValue({ text: JSON.stringify({ memories: [active, pending] }) });

    await expect(extractAndStoreMemories(agentId, taskId, fallbackOutput, task)).resolves.toMatchObject({
      created: 1, pendingApproval: 1,
      memories: [expect.objectContaining({ ...active, status: 'active' })],
      pendingMemories: [expect.objectContaining({ ...pending, status: 'pending_approval' })],
    });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
    expect(runPromptThroughProvider).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      provider, model: 'qwen3:8b', prompt: `Analyze ${fallbackOutput}`, toolFree: true, allowFallback: false,
    }));
  });

  it.each([true, false])('skips the disabled classifier and honors fallbackToPatterns=%s', async fallbackToPatterns => {
    classifyMemories.mockImplementation((await vi.importActual('./memoryClassifier.js')).classifyMemories);
    getSettings.mockResolvedValue({ memoryClassifier: { providerId: 'none', model: null } });
    getConfig.mockResolvedValue({ fallbackToPatterns });

    await expect(extractAndStoreMemories(agentId, taskId, fallbackOutput, task)).resolves.toMatchObject({
      created: fallbackToPatterns ? 1 : 0,
      pendingApproval: fallbackToPatterns ? 2 : 0,
    });
    expect(getProviderById).not.toHaveBeenCalled();
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('keeps agent output away from a provider that loses tool-free eligibility after selection', async () => {
    classifyMemories.mockImplementation((await vi.importActual('./memoryClassifier.js')).classifyMemories);
    getSettings.mockResolvedValue({ memoryClassifier: { providerId: 'unsafe' } });
    getProviderById.mockResolvedValue({ id: 'unsafe', type: 'cli', command: 'codex', enabled: true });

    await expect(extractAndStoreMemories(agentId, taskId, fallbackOutput, task)).resolves.toMatchObject({
      created: 1, pendingApproval: 2,
    });
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('activates high-confidence memories, queues medium confidence, and charges elapsed classification time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1000);
    const high = preference('Written summaries before meetings', 0.85);
    const medium = preference('One owner for each follow-up', 0.7);
    const low = preference('Short agendas for planning sessions', 0.699);
    classifyMemories.mockImplementation(async () => {
      vi.setSystemTime(1250);
      return { usedLLM: true, memories: [high, medium, low] };
    });

    const result = await extractAndStoreMemories(agentId, taskId, output, task);

    expect(classifyMemories).toHaveBeenCalledExactlyOnceWith(task, output);
    expect(createMemory).toHaveBeenCalledTimes(2);
    expect(createMemory).toHaveBeenNthCalledWith(1, expect.objectContaining({
      ...high, sourceAgentId: agentId, sourceTaskId: taskId, sourceAppId: 'example-app'
    }), embedding);
    expect(createMemory).toHaveBeenNthCalledWith(2, expect.objectContaining({
      ...medium, status: 'pending_approval'
    }), embedding);
    expect(result).toEqual({
      created: 1,
      pendingApproval: 1,
      memories: [expect.objectContaining({ content: high.content, status: 'active' })],
      pendingMemories: [expect.objectContaining({ content: medium.content, status: 'pending_approval' })]
    });
    expect(recordDomainUsage).toHaveBeenCalledExactlyOnceWith('memory', { actions: 1, ms: 250 });
  });

  it('queues high-confidence memories in dry-run mode', async () => {
    getDomainAutonomyMode.mockResolvedValue('dry-run');
    const high = preference('Written summaries before meetings', 0.95);
    classifyMemories.mockResolvedValue({ usedLLM: true, memories: [high] });

    const result = await extractAndStoreMemories(agentId, taskId, output, task);

    expect(createMemory).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ...high, status: 'pending_approval' }), embedding
    );
    expect(result).toEqual({
      created: 0,
      pendingApproval: 1,
      memories: [],
      pendingMemories: [expect.objectContaining({ content: high.content, status: 'pending_approval' })]
    });
  });

  it('embeds and stores a normalized duplicate in the same batch only once', async () => {
    const first = preference('Written summaries before meetings', 0.9);
    const duplicate = preference('  WRITTEN summaries   before meetings  ', 0.95);
    classifyMemories.mockResolvedValue({ usedLLM: true, memories: [first, duplicate] });

    const result = await extractAndStoreMemories(agentId, taskId, output, task);

    expect(generateMemoryEmbedding).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(first));
    expect(createMemory).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(first), embedding);
    expect(result.created).toBe(1);
  });

  it('suppresses a memory when active vector search finds a match at the dedup threshold', async () => {
    classifyMemories.mockResolvedValue({ usedLLM: true, memories: [preference('Written summaries before meetings', 0.9)] });
    searchMemories.mockResolvedValue({
      memories: [{ id: 'active-match', summary: 'Send a written recap ahead of meetings', relevance: 0.82 }]
    });

    const result = await extractAndStoreMemories(agentId, taskId, output, task);

    expect(searchMemories).toHaveBeenCalledExactlyOnceWith(embedding, { minRelevance: 0.82, limit: 3, excludePersistentMind: true });
    expect(createMemory).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 0, pendingApproval: 0, memories: [], pendingMemories: [] });
    expect(extracted).toHaveBeenCalledExactlyOnceWith({
      agentId, taskId, count: 0, pendingApproval: 0, skippedDuplicates: 1
    });
  });

  it('stores a shared memory when the only active and pending matches are private', async () => {
    const candidate = preference('Written summaries before meetings', 0.9);
    const privateMatch = { id: 'private-match', sourceAgentId: 'cos-persistent-mind', summary: candidate.content };
    classifyMemories.mockResolvedValue({ usedLLM: true, memories: [candidate] });
    searchMemories.mockImplementation(async (_embedding, { excludePersistentMind }) => ({
      memories: excludePersistentMind ? [] : [privateMatch],
    }));
    getMemories.mockImplementation(async ({ excludePersistentMind }) => ({
      memories: excludePersistentMind ? [] : [privateMatch],
    }));

    const result = await extractAndStoreMemories(agentId, taskId, output, task);

    expect(createMemory).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(candidate), embedding);
    expect(result.created).toBe(1);
  });

  it('logs the matched memory ID without duplicate prose', async () => {
    classifyMemories.mockResolvedValue({ usedLLM: true, memories: [preference('Example private content', 0.9)] });
    searchMemories.mockResolvedValue({
      memories: [{ id: 'active-match', summary: 'Example private summary', relevance: 0.82 }]
    });

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await extractAndStoreMemories(agentId, taskId, output, task);

      expect(log).toHaveBeenCalledWith('🧠 Skipping duplicate memory (matches active-match)');
      expect(log.mock.calls.flat().join(' ')).not.toMatch(/example private/i);
    } finally {
      log.mockRestore();
    }
  });

  it('suppresses a pending duplicate using the normalized summary prefix even without an embedding', async () => {
    const summary = 'Written summaries before meetings should include decisions, their owners, and review dates';
    const duplicate = preference(`${summary} so attendees can prepare`, 0.84);
    const distinct = preference('Review deadlines belong in the weekly planning agenda', 0.84);
    classifyMemories.mockResolvedValue({ usedLLM: true, memories: [duplicate, distinct] });
    generateMemoryEmbedding.mockResolvedValue(null);
    getMemories.mockResolvedValue({
      memories: [{ id: 'pending-match', summary: summary.toUpperCase().replace(' ', '   ') }]
    });

    const result = await extractAndStoreMemories(agentId, taskId, output, task);

    expect(getMemories).toHaveBeenCalledExactlyOnceWith({ status: 'pending_approval', limit: 1000, excludePersistentMind: true });
    expect(searchMemories).not.toHaveBeenCalled();
    expect(createMemory).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ...distinct, status: 'pending_approval' }), null
    );
    expect(result.pendingApproval).toBe(1);
    expect(extracted).toHaveBeenCalledExactlyOnceWith({
      agentId, taskId, count: 0, pendingApproval: 1, skippedDuplicates: 1
    });
  });

  it.each([
    { scenario: 'a successful empty verdict', verdict: { usedLLM: true, memories: [], rejected: ['Routine output'] } },
    { scenario: 'a parse failure with fallback disabled', verdict: { usedLLM: true, error: 'Parse failed', fallbackAvailable: false } },
    { scenario: 'an unavailable classifier with fallback disabled', verdict: { usedLLM: false, skipped: 'classifier-unavailable' }, fallbackToPatterns: false },
    { scenario: 'a skipped classification with fallback disabled', verdict: { usedLLM: false, skipped: 'output-too-short' }, fallbackToPatterns: false }
  ])('stores nothing and sends no approval for $scenario', async ({ verdict, fallbackToPatterns = true }) => {
    classifyMemories.mockResolvedValue(verdict);
    getConfig.mockResolvedValue({ fallbackToPatterns });

    await expect(extractAndStoreMemories(agentId, taskId, fallbackOutput, task)).resolves.toEqual({
      created: 0, pendingApproval: 0, memories: [], pendingMemories: []
    });
    expect(createMemory).not.toHaveBeenCalled();
    expect(approvalNeeded).not.toHaveBeenCalled();
    expect(notifications.addNotification).not.toHaveBeenCalled();
  });

  it.each([
    { scenario: 'an unavailable classifier', verdict: { usedLLM: false, skipped: 'classifier-unavailable' } },
    { scenario: 'an LLM failure', verdict: { usedLLM: false, error: 'LLM call failed', fallbackAvailable: true } },
    { scenario: 'a parse failure', verdict: { usedLLM: true, error: 'Parse failed', fallbackAvailable: true } }
  ])('falls back to structured blocks and user preference patterns after $scenario', async ({ verdict }) => {
    classifyMemories.mockResolvedValue(verdict);

    const result = await extractAndStoreMemories(agentId, taskId, fallbackOutput, task);

    expect(createMemory).toHaveBeenCalledTimes(3);
    expect(result.memories).toEqual([expect.objectContaining({
      type: 'learning',
      category: 'communication',
      content: 'Reviewers benefit from a written recap before group discussion.',
      confidence: 0.92,
      tags: ['reviews', 'communication'],
      status: 'active'
    })]);
    expect(result.pendingMemories).toEqual([
      expect.objectContaining({
        type: 'preference',
        category: 'preferences',
        content: 'User prefers a written decision log for every handoff',
        tags: ['user-preference'],
        status: 'pending_approval'
      }),
      expect.objectContaining({
        type: 'preference',
        category: 'values',
        content: 'User pushed back on: unexplained changes to team priorities',
        tags: ['user-feedback', 'values'],
        status: 'pending_approval'
      })
    ]);
  });

  it('emits both extraction events and creates approval notifications only for unnotified memories', async () => {
    const first = preference('Written summaries before meetings', 0.8);
    const second = preference('One owner for each follow-up', 0.8);
    const active = preference('Explicit review deadlines for decisions', 0.9);
    classifyMemories.mockResolvedValue({ usedLLM: true, memories: [first, second, active] });
    notifications.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const { pendingMemories: [firstPending, secondPending] } =
      await extractAndStoreMemories(agentId, taskId, output, task);

    const approvalType = notifications.NOTIFICATION_TYPES.MEMORY_APPROVAL;
    expect(notifications.exists.mock.calls).toEqual([
      [approvalType, 'memoryId', firstPending.id],
      [approvalType, 'memoryId', secondPending.id]
    ]);
    expect(notifications.addNotification).toHaveBeenCalledExactlyOnceWith({
      type: approvalType,
      title: 'Memory needs approval',
      description: first.content,
      priority: 'medium',
      link: '/cos/memory',
      metadata: {
        memoryId: firstPending.id,
        category: 'memory-approval',
        actionKind: 'memory.approval',
        sourceOwned: true,
        memoryType: 'preference',
        agentId,
        taskId
      }
    });
    expect(approvalNeeded).toHaveBeenCalledExactlyOnceWith({
      agentId,
      taskId,
      memories: [
        { id: firstPending.id, type: 'preference', content: first.content, confidence: 0.8 },
        { id: secondPending.id, type: 'preference', content: second.content, confidence: 0.8 }
      ]
    });
    expect(extracted).toHaveBeenCalledExactlyOnceWith({
      agentId, taskId, count: 1, pendingApproval: 2, skippedDuplicates: 0
    });
  });
});
