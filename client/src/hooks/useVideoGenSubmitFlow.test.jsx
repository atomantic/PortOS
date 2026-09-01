import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useVideoGenSubmitFlow } from './useVideoGenSubmitFlow.js';

const submissionState = (prompt) => ({
  chainingActive: false,
  chunkPrompts: [],
  currentModel: { runtime: 'mlx_video' },
  disableAudio: false,
  icModeActive: false,
  icReferenceImageFiles: [],
  isGrok: false,
  keyframes: [],
  keyframesActive: false,
  mode: 'text',
  negativePrompt: '',
  noMusic: false,
  prompt,
  selectedLoras: [],
  selectedUniverse: null,
  stylePreset: null,
});

describe('useVideoGenSubmitFlow', () => {
  it('keeps a stable submit callback that reads the latest form snapshot', () => {
    const { result, rerender } = renderHook(
      ({ prompt }) => useVideoGenSubmitFlow(submissionState(prompt)),
      { initialProps: { prompt: 'first prompt' } },
    );
    const build = result.current.buildGeneratePayload;
    expect(build().prompt).toBe('first prompt');

    rerender({ prompt: 'updated prompt' });
    expect(result.current.buildGeneratePayload).toBe(build);
    expect(build().prompt).toBe('updated prompt');
  });

  it('layers the selected universe style into the video payload', () => {
    const state = {
      ...submissionState('a quiet harbor'),
      negativePrompt: 'lowres',
      selectedUniverse: {
        id: 'u-1',
        name: 'Example Universe',
        influences: { embrace: ['inky linework'], avoid: ['glossy'] },
      },
      stylePreset: { prompt: 'film noir', negativePrompt: 'pastel' },
    };
    const { result } = renderHook(() => useVideoGenSubmitFlow(state));

    expect(result.current.envelopedPrompt).toBe('inky linework. film noir. a quiet harbor');
    expect(result.current.buildGeneratePayload()).toMatchObject({
      prompt: 'inky linework. film noir. a quiet harbor',
      negativePrompt: 'lowres, glossy, pastel',
    });
  });
});
