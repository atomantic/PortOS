import { describe, expect, it } from 'vitest';
import { buildVideoGenSubmission } from './videoGenSubmission.js';

// #6499 — block streaming is a request-only field sent to the LOCAL backend,
// and only when it is both a real choice (the current model actually runs on
// an LTX-2/2.5 MLX runtime) and a non-default one ('auto' — the bridge's own
// default). Every other field the local payload needs is filled with the
// minimal values that keep the shared prompt/mode helpers from throwing.
const baseArgs = (overrides = {}) => ({
  isGrok: false, isFal: false, isReactor: false, remoteSubmissionFields: null,
  prompt: 'a fox running through a forest',
  negativePrompt: '',
  width: 768, height: 512, mode: 'text',
  numFrames: 121, fps: 24, steps: '', guidanceScale: '', seed: '', batchSize: 1,
  models: [],
  tiling: 'auto', textEncoderId: '', speedProfileId: '', draftDecode: '',
  disableAudio: false, noMusic: false, imageStrength: '', i2vReferenceMode: 'anchor',
  keyframesActive: false, keyframes: [], loraFamily: null, selectedLoras: [],
  icModeActive: false, icImageKind: false, icReferenceImageFiles: [], icStrength: 1, icSkipStage2: false,
  chainingActive: false, chunks: 1, chunkPrompts: [], contextFrames: 0,
  ...overrides,
});

describe('buildVideoGenSubmission — block streaming request (#6499)', () => {
  it('sends a non-default mode when the current model runs an LTX-2/2.5 MLX runtime', () => {
    const payload = buildVideoGenSubmission(baseArgs({
      currentModel: { runtime: 'ltx25' },
      streamingMode: 'stream',
    }));
    expect(payload.backend).toBe('local');
    expect(payload.streamingMode).toBe('stream');
  });

  it('omits the field for the default (auto) mode, even on an LTX-2/2.5 model', () => {
    const payload = buildVideoGenSubmission(baseArgs({
      currentModel: { runtime: 'ltx2' },
      streamingMode: 'auto',
    }));
    expect(payload.streamingMode).toBeUndefined();
  });

  it('omits the field entirely when the current model does not run an LTX-2/2.5 MLX runtime', () => {
    const payload = buildVideoGenSubmission(baseArgs({
      currentModel: { runtime: 'mlx_video' },
      streamingMode: 'stream',
    }));
    expect(payload.streamingMode).toBeUndefined();
  });

  it('omits the field when no model is selected yet', () => {
    const payload = buildVideoGenSubmission(baseArgs({
      currentModel: null,
      streamingMode: 'stream',
    }));
    expect(payload.streamingMode).toBeUndefined();
  });
});
