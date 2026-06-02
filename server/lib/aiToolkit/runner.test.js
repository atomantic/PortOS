import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRunnerService } from './runner.js';

describe('AI Toolkit runner service', () => {
  const tempDirs = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('checks provider readiness through the injected hook before API fetches', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);

    const provider = {
      id: 'ollama',
      name: 'Ollama',
      endpoint: 'http://localhost:11434/v1',
      defaultModel: 'llama3'
    };
    const ensureProviderReady = vi.fn(async () => ({ success: false, error: 'service offline' }));
    const onComplete = vi.fn();
    const onRunFailed = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    const runner = createRunnerService({
      dataDir,
      hooks: {
        ensureProviderReady,
        onRunFailed
      }
    });

    await runner.executeApiRun(
      'run-ready-hook',
      provider,
      null,
      'hello',
      process.cwd(),
      [],
      undefined,
      onComplete
    );

    expect(ensureProviderReady).toHaveBeenCalledWith(provider);
    expect(fetch).not.toHaveBeenCalled();
    expect(onRunFailed).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ success: false }));

    const metadata = JSON.parse(
      await readFile(join(dataDir, 'runs', 'run-ready-hook', 'metadata.json'), 'utf8')
    );
    expect(metadata).toMatchObject({
      success: false,
      errorCategory: 'unknown'
    });
  });

  const stubStreamingFetch = () => {
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n`),
      encoder.encode('data: [DONE]\n')
    ];
    let i = 0;
    const body = {
      getReader: () => ({
        read: async () => (i < chunks.length
          ? { done: false, value: chunks[i++] }
          : { done: true, value: undefined })
      })
    };
    const fetch = vi.fn(async () => ({ ok: true, body }));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  const runReady = (overrides = {}) => ({
    id: 'ollama',
    name: 'Ollama',
    endpoint: 'http://localhost:11434/v1',
    defaultModel: 'llama3',
    ...overrides
  });

  it('sends num_ctx in the request body when the provider opts in', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const fetch = stubStreamingFetch();

    const runner = createRunnerService({
      dataDir,
      hooks: { ensureProviderReady: async () => ({ success: true }) }
    });
    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    await runner.executeApiRun('run-numctx', runReady({ numCtx: 32768 }), null, 'hi', process.cwd(), [], undefined, () => done());
    await completed;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body).num_ctx).toBe(32768);
  });

  it('omits num_ctx when the provider does not set it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const fetch = stubStreamingFetch();

    const runner = createRunnerService({
      dataDir,
      hooks: { ensureProviderReady: async () => ({ success: true }) }
    });
    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    await runner.executeApiRun('run-no-numctx', runReady(), null, 'hi', process.cwd(), [], undefined, () => done());
    await completed;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect('num_ctx' in JSON.parse(fetch.mock.calls[0][1].body)).toBe(false);
  });
});
