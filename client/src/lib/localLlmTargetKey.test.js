import { describe, it, expect } from 'vitest';
import { localLlmTargetKey } from './localLlmTargetKey.js';

describe('localLlmTargetKey', () => {
  it('joins backend and modelId with a newline delimiter', () => {
    expect(localLlmTargetKey({ backend: 'ollama', modelId: 'llama3.2' })).toBe('ollama\nllama3.2');
    expect(localLlmTargetKey({ backend: 'lmstudio', modelId: 'qwen2.5-7b' })).toBe('lmstudio\nqwen2.5-7b');
  });

  it('round-trips: same pair → same key, different pair → different key', () => {
    const a = localLlmTargetKey({ backend: 'ollama', modelId: 'mistral' });
    const aAgain = localLlmTargetKey({ backend: 'ollama', modelId: 'mistral' });
    const b = localLlmTargetKey({ backend: 'lmstudio', modelId: 'mistral' });
    expect(a).toBe(aAgain);
    expect(a).not.toBe(b);
  });

  it('ignores extra array-iteration args so it works as a `.map` callback', () => {
    const targets = [
      { backend: 'ollama', modelId: 'm1' },
      { backend: 'lmstudio', modelId: 'm2' },
    ];
    expect(targets.map(localLlmTargetKey)).toEqual(['ollama\nm1', 'lmstudio\nm2']);
  });
});
