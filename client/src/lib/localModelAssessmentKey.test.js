import { describe, expect, it } from 'vitest';
import {
  decodeLocalModelAssessmentKey,
  encodeLocalModelAssessmentKey,
  localModelAssessmentPath,
} from './localModelAssessmentKey';

describe('local model assessment selection keys', () => {
  it('round-trips slash-containing model ids with backend-default tuning', () => {
    const entry = {
      backend: 'llama',
      modelId: 'hf.co/example-org/model/Q4_K_M',
      tuningKey: '',
    };
    const key = encodeLocalModelAssessmentKey(entry);

    expect(key).toMatch(/^v1-[A-Za-z0-9_-]+$/);
    expect(decodeLocalModelAssessmentKey(key)).toEqual({
      backend: 'llama',
      modelId: 'hf.co/example-org/model/Q4_K_M',
      tuningKey: null,
    });
    expect(localModelAssessmentPath(entry)).toBe(`/models/performance/results/${key}`);
  });

  it('keeps distinct launch tunings distinct', () => {
    const base = { backend: 'llama', modelId: 'example/model:7b' };
    const defaultKey = encodeLocalModelAssessmentKey(base);
    const tunedKey = encodeLocalModelAssessmentKey({ ...base, tuningKey: 'ubatchSize=512&flashAttn=true' });

    expect(tunedKey).not.toBe(defaultKey);
    expect(decodeLocalModelAssessmentKey(tunedKey)).toEqual({
      backend: 'llama',
      modelId: 'example/model:7b',
      tuningKey: 'ubatchSize=512&flashAttn=true',
    });
  });

  it.each([undefined, '', 'v2-invalid', 'v1-not-base64', 'v1-e30'])('rejects an invalid key: %s', (key) => {
    expect(decodeLocalModelAssessmentKey(key)).toBeNull();
  });
});
