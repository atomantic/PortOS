import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the prompt runner so the test never tries to spawn a CLI / API provider.
const resolveProviderAndModelMock = vi.fn();
const runPromptThroughProviderMock = vi.fn();
vi.mock('../lib/promptRunner.js', () => ({
  assertProvider: (provider, { message, code, status = 503 } = {}) => {
    if (provider) return;
    const err = new Error(message || 'No AI provider available');
    if (code) { err.status = status; err.code = code; }
    throw err;
  },
  resolveProviderAndModel: (...a) => resolveProviderAndModelMock(...a),
  runPromptThroughProvider: (...a) => runPromptThroughProviderMock(...a),
}));

// universeBuilder.js pulls in fileUtils + collectionStore; stub those so the
// service import doesn't try to touch real disk just to read
// stripPromptControlChars.
vi.mock('../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  readJSONFile: vi.fn(async (_p, fallback) => fallback),
}));
vi.mock('./instances.js', async () => {
  const { mockNoPeers } = await import('../lib/mockPathsDataRoot.js');
  return mockNoPeers();
});
vi.mock('./sharing/peerSync.js', async () => {
  const { mockNoPeerSync } = await import('../lib/mockPathsDataRoot.js');
  return mockNoPeerSync();
});

const { mergeFieldsWithAI } = await import('./recordMergeAI.js');

const PROVIDER = { id: 'codex', name: 'Codex', type: 'cli' };

beforeEach(() => {
  resolveProviderAndModelMock.mockReset();
  runPromptThroughProviderMock.mockReset();
  resolveProviderAndModelMock.mockResolvedValue({ provider: PROVIDER, selectedModel: 'gpt-5-codex' });
});

describe('mergeFieldsWithAI', () => {
  it('returns the parsed `merged` map when the LLM responds with valid JSON', async () => {
    runPromptThroughProviderMock.mockResolvedValue({
      text: JSON.stringify({ merged: { starterPrompt: 'Unified prompt', logline: 'Unified logline' } }),
      runId: 'run-1',
    });

    const result = await mergeFieldsWithAI({
      kind: 'universe',
      survivor: { name: 'Dup', starterPrompt: 'A', logline: 'L1' },
      loser: { name: 'Dup', starterPrompt: 'B', logline: 'L2' },
      fields: ['starterPrompt', 'logline'],
    });

    expect(result.merged).toEqual({ starterPrompt: 'Unified prompt', logline: 'Unified logline' });
    expect(result.skipped).toEqual([]);
    expect(result.runId).toBe('run-1');
    expect(result.llm).toEqual({ provider: 'codex', model: 'gpt-5-codex' });

    const promptArg = runPromptThroughProviderMock.mock.calls[0][0].prompt;
    expect(promptArg).toContain('starterPrompt');
    expect(promptArg).toContain('A');
    expect(promptArg).toContain('B');
  });

  it('skips non-string fields (e.g. number / object scalars) and reports them in `skipped`', async () => {
    runPromptThroughProviderMock.mockResolvedValue({
      text: JSON.stringify({ merged: { starterPrompt: 'Unified' } }),
      runId: 'run-2',
    });

    const result = await mergeFieldsWithAI({
      kind: 'series',
      survivor: { starterPrompt: 'A', issueCountTarget: 6, arc: { beats: [] } },
      loser: { starterPrompt: 'B', issueCountTarget: 12, arc: { beats: ['x'] } },
      fields: ['starterPrompt', 'issueCountTarget', 'arc'],
    });

    expect(result.merged).toEqual({ starterPrompt: 'Unified' });
    expect(result.skipped).toEqual(['issueCountTarget', 'arc']);
  });

  it('skips empty-string fields — AI merge only handles non-empty text on BOTH sides', async () => {
    runPromptThroughProviderMock.mockResolvedValue({
      text: JSON.stringify({ merged: { logline: 'Unified' } }),
      runId: 'run-3',
    });

    const result = await mergeFieldsWithAI({
      kind: 'universe',
      survivor: { starterPrompt: 'A', logline: 'L1' },
      loser: { starterPrompt: '   ', logline: 'L2' }, // whitespace-only counts as empty
      fields: ['starterPrompt', 'logline'],
    });

    expect(result.merged).toEqual({ logline: 'Unified' });
    expect(result.skipped).toContain('starterPrompt');
  });

  it('throws MERGE_AI_NO_MERGEABLE_FIELDS when no field has both sides as non-empty strings', async () => {
    await expect(mergeFieldsWithAI({
      kind: 'universe',
      survivor: { starterPrompt: '' },
      loser: { starterPrompt: 'B' },
      fields: ['starterPrompt'],
    })).rejects.toMatchObject({ code: 'MERGE_AI_NO_MERGEABLE_FIELDS' });

    // No LLM call should have been made.
    expect(runPromptThroughProviderMock).not.toHaveBeenCalled();
  });

  it('throws MERGE_AI_NO_PROVIDER when no provider is configured', async () => {
    resolveProviderAndModelMock.mockResolvedValueOnce({ provider: null, selectedModel: null });

    await expect(mergeFieldsWithAI({
      kind: 'universe',
      survivor: { starterPrompt: 'A' },
      loser: { starterPrompt: 'B' },
      fields: ['starterPrompt'],
    })).rejects.toMatchObject({ code: 'MERGE_AI_NO_PROVIDER' });
  });

  it('throws LLM_INVALID_JSON when the LLM returns garbage', async () => {
    runPromptThroughProviderMock.mockResolvedValue({ text: 'not json at all', runId: 'run-bad' });

    await expect(mergeFieldsWithAI({
      kind: 'universe',
      survivor: { starterPrompt: 'A' },
      loser: { starterPrompt: 'B' },
      fields: ['starterPrompt'],
    })).rejects.toMatchObject({ code: 'LLM_INVALID_JSON' });
  });

  it('passes providerId + model through to resolveProviderAndModel', async () => {
    runPromptThroughProviderMock.mockResolvedValue({
      text: JSON.stringify({ merged: { starterPrompt: 'Unified' } }),
      runId: 'run-4',
    });

    await mergeFieldsWithAI({
      kind: 'universe',
      survivor: { starterPrompt: 'A' },
      loser: { starterPrompt: 'B' },
      fields: ['starterPrompt'],
      providerId: 'claude-code',
      model: 'claude-opus-4-7',
    });

    expect(resolveProviderAndModelMock).toHaveBeenCalledWith({
      providerId: 'claude-code',
      model: 'claude-opus-4-7',
    });
  });
});
