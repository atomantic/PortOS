import { describe, it, expect, vi, afterEach } from 'vitest';
import { runChatCompletion } from './chatCompletionExchange.js';

function mockFetch() {
  const fn = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}
const sentBody = (fn) => JSON.parse(fn.mock.calls[0][1].body);

describe('runChatCompletion OpenRouter routing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the resolved provider object to OpenRouter', async () => {
    const fn = mockFetch();
    const provider = { id: 'or', endpoint: 'https://openrouter.ai/api/v1', providerRouting: { data_collection: 'deny', models: { 'a/b': { sort: 'price' } } } };
    await runChatCompletion({ provider, model: 'a/b', prompt: 'hi', temperature: 0, maxTokens: 10, timeout: 5000 });
    expect(sentBody(fn).provider).toEqual({ data_collection: 'deny', sort: 'price' });
  });

  it('keeps a non-OpenRouter payload byte-identical', async () => {
    const fn = mockFetch();
    const provider = { id: 'x', endpoint: 'http://localhost:1234/v1', providerRouting: { sort: 'price' } };
    await runChatCompletion({ provider, model: 'm', prompt: 'hi', temperature: 0, maxTokens: 10, timeout: 5000 });
    expect(Object.keys(sentBody(fn))).toEqual(['model', 'messages', 'temperature', 'max_tokens']);
  });
});
