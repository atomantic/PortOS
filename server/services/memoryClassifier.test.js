import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// With no shipped seed (#8444), an install without data/memory-classifier-config.json
// must get the endpoint derived from LM_STUDIO_URL rather than a hard-coded localhost.
describe('memoryClassifier', () => {
  let tempDir;
  let oldLmStudioUrl;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memory-classifier-test-'));
    oldLmStudioUrl = process.env.LM_STUDIO_URL;
    vi.resetModules();
    vi.doMock('../lib/fileUtils.js', async () => {
      const actual = await vi.importActual('../lib/fileUtils.js');
      return { ...actual, PATHS: { ...actual.PATHS, data: tempDir } };
    });
  });

  afterEach(() => {
    vi.doUnmock('../lib/fileUtils.js');
    vi.resetModules();
    if (oldLmStudioUrl === undefined) delete process.env.LM_STUDIO_URL;
    else process.env.LM_STUDIO_URL = oldLmStudioUrl;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses LM_STUDIO_URL when no config file exists', async () => {
    process.env.LM_STUDIO_URL = 'http://192.0.2.10:1234/v1/';
    const { getConfig } = await import('./memoryClassifier.js');
    const config = await getConfig();
    expect(config.endpoint).toBe('http://192.0.2.10:1234/v1/chat/completions');
  });

  it('falls back to localhost when LM_STUDIO_URL is unset', async () => {
    delete process.env.LM_STUDIO_URL;
    const { getConfig } = await import('./memoryClassifier.js');
    const config = await getConfig();
    expect(config.endpoint).toBe('http://localhost:1234/v1/chat/completions');
  });

  it('sends agent output verbatim, without expanding patterns or placeholders inside it', async () => {
    const fetchWithTimeout = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"memories":[],"rejected":[]}' } }] }),
      text: async () => ''
    });
    vi.doMock('../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout }));
    vi.doMock('./promptService.js', () => ({
      getStageTemplate: vi.fn().mockResolvedValue('Out: {{agentOutput}} | Known: {{existingMemories}} | {{unknown}}')
    }));
    vi.doMock('./memoryBackend.js', () => ({ getMemories: vi.fn().mockResolvedValue({ memories: [] }) }));
    const output = `printf $'a' && echo $& $$ {{existingMemories}} ${'x'.repeat(100)}`;

    try {
      const { classifyMemories } = await import('./memoryClassifier.js');
      await classifyMemories({ id: 'task-1', description: 'd' }, output);
    } finally {
      vi.doUnmock('../lib/fetchWithTimeout.js');
      vi.doUnmock('./promptService.js');
      vi.doUnmock('./memoryBackend.js');
    }

    const chat = fetchWithTimeout.mock.calls.find(([url]) => url.endsWith('/chat/completions'));
    const prompt = JSON.parse(chat[1].body).messages.at(-1).content;
    expect(prompt).toBe(`Out: ${output} | Known: No existing memories yet. | {{unknown}}`);
  });

  it('omits raw model response text from parse-failure logs (#17199)', async () => {
    const fixtureSentence = 'Personal note about a private appointment';
    const rawResponse = `Not valid JSON: ${fixtureSentence}`;

    vi.doMock('../lib/fetchWithTimeout.js', () => ({
      fetchWithTimeout: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: rawResponse } }] }),
        text: async () => JSON.stringify({ choices: [{ message: { content: rawResponse } }] })
      })
    }));
    vi.doMock('./promptService.js', () => ({
      getStageTemplate: vi.fn().mockResolvedValue('Classify: {{taskDescription}} {{agentOutput}} {{existingMemories}}')
    }));
    vi.doMock('./memoryBackend.js', () => ({
      getMemories: vi.fn().mockResolvedValue({ memories: [] })
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { classifyMemories } = await import('./memoryClassifier.js');
      const result = await classifyMemories(
        { id: 'task-1', description: 'Check logs' },
        'x'.repeat(120)
      );

      expect(result).toEqual({
        memories: [],
        rejected: [],
        usedLLM: true,
        error: 'Failed to parse LLM response',
        fallbackAvailable: true
      });

      const logged = logSpy.mock.calls.map(args => args.join(' '));
      const parseFailLog = logged.find(line => line.includes('Failed to parse LLM response'));
      expect(parseFailLog).toBeDefined();
      expect(parseFailLog).toContain(`${rawResponse.length} chars`);
      expect(logged.join('\n')).not.toContain(fixtureSentence);
    } finally {
      logSpy.mockRestore();
      vi.doUnmock('../lib/fetchWithTimeout.js');
      vi.doUnmock('./promptService.js');
      vi.doUnmock('./memoryBackend.js');
    }
  });

  describe('classification and availability', () => {
    const baseUrl = 'http://192.0.2.10:1234';
    const endpoint = `${baseUrl}/v1/chat/completions`;
    const configuredModel = 'example-model';
    const accepted = {
      type: 'fact',
      content: 'The reading group meets on the first Monday of each month.',
      confidence: 0.7
    };
    const task = { id: 'task-1', description: 'Record reading group notes' };
    const output = 'The reading group discussed the next meeting and agreed to keep the recurring schedule throughout the year.';
    const rejected = [{ reason: 'Unrelated to the meeting' }];
    const fetchWithTimeout = vi.fn();
    const getMemories = vi.fn();
    const getStageTemplate = vi.fn();
    let classifier;

    function mockClassification(content, models = [{ id: configuredModel, type: 'llm', state: 'loaded' }]) {
      fetchWithTimeout.mockImplementation(async (url, options) => {
        if (url === `${baseUrl}/v1/models` || url === `${baseUrl}/api/v0/models`) return Response.json({ data: models });
        if (url === `${baseUrl}/api/v1/models/load`) return Response.json({});
        if (url !== endpoint) throw new Error(`Unexpected classifier request: ${url}`);
        const prompt = JSON.parse(options.body).messages.at(-1).content;
        const response = typeof content === 'function' ? content(prompt) : content;
        return Response.json({ choices: [{ message: { content: response } }] });
      });
    }

    beforeEach(async () => {
      fetchWithTimeout.mockReset();
      getMemories.mockReset().mockResolvedValue({ memories: [] });
      getStageTemplate.mockReset().mockResolvedValue('Existing memories:\n{{existingMemories}}\nNotes: {{agentOutput}}');
      vi.doMock('../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout }));
      vi.doMock('./promptService.js', () => ({ getStageTemplate }));
      vi.doMock('./memoryBackend.js', () => ({ getMemories }));
      classifier = await import('./memoryClassifier.js');
      await classifier.updateConfig({ endpoint, model: configuredModel });
    });

    afterEach(() => {
      vi.doUnmock('../lib/fetchWithTimeout.js');
      vi.doUnmock('./promptService.js');
      vi.doUnmock('./memoryBackend.js');
    });

    it.each([
      ['null', null],
      ['number', 42],
      ['string', 'Unstructured memory candidate'],
      ['boolean', false],
      ['array', [accepted]],
      ['missing type', { ...accepted, type: undefined }],
      ['missing content', { ...accepted, content: undefined }],
      ['non-numeric confidence', { ...accepted, confidence: '0.9' }],
      ['low confidence', { ...accepted, confidence: 0.69 }],
      ['short content', { ...accepted, content: 'Too brief' }],
      ['quoted task echo', { ...accepted, content: 'Task "Read the notes": A recurring meeting schedule.' }],
      ['short completion echo', { ...accepted, content: 'The reading group task was completed yesterday.' }],
      ['file path', { ...accepted, content: 'The notes were recorded in examples/meeting.json.' }],
      ['CSS dimensions', { ...accepted, content: 'The meeting banner is 250px wide.' }],
      ['CSS color', { ...accepted, content: 'The meeting banner color is #aabbcc.' }],
      ['port', { ...accepted, content: 'The meeting dashboard runs on port 1234.' }],
      ['architecture fact', { ...accepted, content: 'The meeting dashboard uses React for rendering.' }],
      ['positive status assessment', { ...accepted, content: 'The audit reported no changes needed for the dashboard.' }],
      ['one-time code observation', { ...accepted, content: 'The dashboard module has 250 lines.' }]
    ])('filters %s while retaining valid memories and model rejections', async (_label, candidate) => {
      const preference = {
        type: 'preference',
        content: 'The group prefers meeting.md with the heading color #aabbcc.',
        confidence: 0.9
      };
      mockClassification(JSON.stringify({ memories: [accepted, candidate, preference], rejected }));
      await expect(classifier.classifyMemories(task, output)).resolves.toEqual({
        memories: [accepted, preference],
        rejected,
        usedLLM: true
      });
    });

    it('ignores a matching schema example in the echoed prompt', async () => {
      getStageTemplate.mockResolvedValue('Example output: {"memories":[],"rejected":[]}\nNotes: {{agentOutput}}');
      mockClassification(prompt => `${prompt}\n${JSON.stringify({ memories: [accepted], rejected })}`);

      await expect(classifier.classifyMemories(task, output)).resolves.toEqual({
        memories: [accepted],
        rejected,
        usedLLM: true
      });
    });

    it('only injects shared content and summaries from active and pending memory', async () => {
      getMemories
        .mockResolvedValueOnce({
          memories: [
            { type: 'fact', content: 'Private recall.', sourceAgentId: 'cos-persistent-mind' },
            { type: 'fact', content: 'The group meets monthly.', summary: 'Unused summary.' }
          ]
        })
        .mockResolvedValueOnce({
          memories: [
            { type: 'fact', summary: 'Private continuation.', tags: ['mind:continuation-note'] },
            { type: 'preference', summary: 'The group prefers evening meetings.' }
          ]
        });
      mockClassification(JSON.stringify({ memories: [], rejected: [] }));

      await classifier.classifyMemories(task, output);

      expect(getMemories).toHaveBeenNthCalledWith(1, {
        status: 'active', sortBy: 'importance', sortOrder: 'desc', limit: 30, excludePersistentMind: true
      });
      expect(getMemories).toHaveBeenNthCalledWith(2, { status: 'pending_approval', limit: 30, excludePersistentMind: true });
      const [, request] = fetchWithTimeout.mock.lastCall;
      expect(JSON.parse(request.body).messages.at(-1).content).toBe(
        `Existing memories:\n- [fact] The group meets monthly.\n- [preference] The group prefers evening meetings.\nNotes: ${output}`
      );
    });

    it.each([
      ['prefers a matching loaded LLM', 'loaded', 'publisher/example-model', false],
      ['uses another loaded LLM when the match is unloaded', 'not-loaded', 'other-model', false],
      ['loads the configured LLM when none is loaded', 'not-loaded', 'publisher/example-model', true]
    ])('%s', async (_label, preferredState, expectedModel, shouldLoad) => {
      mockClassification(JSON.stringify({ memories: [], rejected: [] }), [
        { id: 'embedding-model', type: 'embeddings', state: 'loaded' },
        { id: 'other-model', type: 'llm', state: shouldLoad ? 'not-loaded' : 'loaded' },
        { id: 'publisher/example-model', type: 'llm', state: preferredState }
      ]);

      await expect(classifier.classifyMemories(task, output)).resolves.toMatchObject({ usedLLM: true });

      const loadUrl = `${baseUrl}/api/v1/models/load`;
      expect(fetchWithTimeout.mock.calls.map(([url]) => url)).toEqual([
        `${baseUrl}/v1/models`, `${baseUrl}/api/v0/models`, ...(shouldLoad ? [loadUrl] : []), endpoint
      ]);
      if (shouldLoad) {
        expect(fetchWithTimeout.mock.calls[2][1]).toMatchObject({
          method: 'POST',
          body: JSON.stringify({ model: expectedModel })
        });
      }
      expect(JSON.parse(fetchWithTimeout.mock.lastCall[1].body).model).toBe(expectedModel);
    });

    it('skips the health request when disabled', async () => {
      await classifier.updateConfig({ enabled: false });

      await expect(classifier.getClassifierAvailability()).resolves.toEqual({ available: false, disabled: true });
      expect(fetchWithTimeout).not.toHaveBeenCalled();
    });

    it.each([200, 503])('reports availability from the models endpoint with HTTP %i', async status => {
      fetchWithTimeout.mockResolvedValue(new Response(null, { status }));

      await expect(classifier.getClassifierAvailability()).resolves.toEqual({ available: status === 200, disabled: false });
      expect(fetchWithTimeout).toHaveBeenCalledExactlyOnceWith(
        `${baseUrl}/v1/models`, { method: 'GET' }, expect.any(Number)
      );
    });

    it('reports unavailable when the models endpoint cannot be reached', async () => {
      fetchWithTimeout.mockRejectedValue(new Error('Connection refused'));

      await expect(classifier.getClassifierAvailability()).resolves.toEqual({ available: false, disabled: false });
    });
  });
});
