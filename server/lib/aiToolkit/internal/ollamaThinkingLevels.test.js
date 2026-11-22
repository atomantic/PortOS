import { describe, expect, it } from 'vitest';
import { ollamaThinkLevel, ollamaThinkingLevelsForModel } from './ollamaThinkingLevels.js';
import { buildOllamaNativeChatBody } from './ollamaNativeChat.js';
import { effortLevelsForProvider } from '../../provider/providerModels.js';

const ollama = { id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1', numCtx: 131072 };

describe('Ollama thinking levels', () => {
  it('lists levels only for families whose template takes one', () => {
    expect(ollamaThinkingLevelsForModel('inkling-2-mini:26b-a5b-nvfp4')).toContain('low');
    expect(ollamaThinkingLevelsForModel('gpt-oss:20b')).toEqual(['low', 'medium', 'high']);
    expect(ollamaThinkingLevelsForModel('qwen3.6:35b')).toBeNull();
  });
  it('turns a supported effort into the think level and ignores others', () => {
    expect(ollamaThinkLevel('inkling-2-mini:26b-a5b-nvfp4', 'low')).toBe('low');
    expect(ollamaThinkLevel('gpt-oss:20b', 'max')).toBeNull();
    expect(ollamaThinkLevel('qwen3.6:35b', 'low')).toBeNull();
  });
  it('offers the levels as the effort ladder of an Ollama API provider', () => {
    expect(effortLevelsForProvider(ollama, 'inkling-2-mini:26b-a5b-nvfp4')).toContain('high');
    expect(effortLevelsForProvider(ollama, 'qwen3.6:35b')).toBeNull();
  });
  it('sends a level string as the native think field', () => {
    const body = buildOllamaNativeChatBody({ model: 'm', messageContent: 'hi', provider: ollama, generation: { think: 'low' } });
    expect(body.think).toBe('low');
    expect(buildOllamaNativeChatBody({ model: 'm', messageContent: 'hi', provider: ollama, generation: { think: false } }).think).toBe(false);
    expect(buildOllamaNativeChatBody({ model: 'm', messageContent: 'hi', provider: ollama, generation: {} })).not.toHaveProperty('think');
  });
});
