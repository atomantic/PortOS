import { describe, it, expect } from 'vitest';
import { buildOllamaNativeChatBody, ollamaNativeChatUrl } from './ollamaNativeChat.js';

describe('ollamaNativeChat', () => {
  // Endpoint spelling is user input; every Ollama shape must land on the same
  // native URL, and anything that is not an Ollama daemon must stay on /v1.
  it('resolves the native URL only for an Ollama daemon with a positive numCtx', () => {
    expect(ollamaNativeChatUrl({ id: 'ollama', endpoint: 'http://localhost:11434/v1/', numCtx: 8192 }))
      .toBe('http://localhost:11434/api/chat');
    expect(ollamaNativeChatUrl({ id: 'custom', type: 'api', endpoint: 'http://192.0.2.10:11434/v1', numCtx: '16384' }))
      .toBe('http://192.0.2.10:11434/api/chat');
    expect(ollamaNativeChatUrl({ id: 'ollama', endpoint: 'http://localhost:11434/v1', numCtx: null })).toBeNull();
    expect(ollamaNativeChatUrl({ id: 'ollama', endpoint: 'http://localhost:11434/v1', numCtx: 0 })).toBeNull();
    expect(ollamaNativeChatUrl({ id: 'lmstudio', endpoint: 'http://localhost:1234/v1', lmstudioBacked: true, numCtx: 8192 })).toBeNull();
  });

  // The native message format differs from OpenAI's content parts: images are
  // bare base64 strings beside the text, not data-URL parts inside it.
  it('converts OpenAI content parts with images into a native message', () => {
    const body = buildOllamaNativeChatBody({
      model: 'example-vision',
      provider: { numCtx: 8192 },
      messageContent: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: 'describe' },
      ],
    });
    expect(body.messages).toEqual([{ role: 'user', content: 'describe', images: ['AAAA'] }]);
    expect(body.options).toEqual({ num_ctx: 8192 });
    expect('think' in body).toBe(false);
  });
});
