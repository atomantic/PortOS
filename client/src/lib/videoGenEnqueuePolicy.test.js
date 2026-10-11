import { describe, expect, it } from 'vitest';
import { videoGenEnqueuePolicy } from './videoGenEnqueuePolicy.js';

// A render that is ready everywhere: connected local machine, nothing gated.
const READY = {
  prompt: 'a fox in the rain',
  remixHandoffPending: false,
  promptOverLimit: false,
  isRemote: false,
  remoteBlocked: null,
  rendersOffMachine: false,
  notConnected: false,
  byovRuntime: undefined,
  byovLabel: undefined,
  byovGateBlocked: false,
  byovRuntimeMissing: false,
  blockedAsset: undefined,
  extendModeBlocked: false,
  a2vModeBlocked: false,
  a2vDurationError: null,
  modelRuntime: 'ltx2',
  audioFile: null,
  icLoraModeBlocked: false,
  keyframesBlocked: false,
  keyframesError: null,
};
const QUEUE_READY = 'Submit this configuration to its server queue; local, Grok, and remote lanes run independently';
const QUEUE_GENERIC = 'Complete the required inputs before queueing';
const run = (overrides) => videoGenEnqueuePolicy({ ...READY, ...overrides });

describe('videoGenEnqueuePolicy', () => {
  it('allows a ready local render with no titles or caption', () => {
    expect(run({})).toEqual({
      canEnqueue: true, generateTitle: undefined, queueTitle: QUEUE_READY, optionsHint: null,
    });
  });

  it.each([
    ['empty prompt', { prompt: '   ' }],
    ['remix handoff pending', { remixHandoffPending: true }],
    ['prompt over the reactor limit', { promptOverLimit: true }],
  ])('always disables on %s with no specific reason', (_name, overrides) => {
    for (const where of [{}, { rendersOffMachine: true }, { isRemote: true }]) {
      expect(run({ ...overrides, ...where })).toMatchObject({
        canEnqueue: false, generateTitle: undefined, queueTitle: QUEUE_GENERIC, optionsHint: null,
      });
    }
  });

  it('disables a remote target only on remoteBlocked and uses it as the reason', () => {
    const local = { notConnected: true, extendModeBlocked: true, byovGateBlocked: true, byovRuntime: 'x' };
    expect(run({ isRemote: true, ...local })).toMatchObject({ canEnqueue: true, generateTitle: undefined });
    expect(run({ isRemote: true, remoteBlocked: 'Peer is offline', ...local })).toEqual({
      canEnqueue: false, generateTitle: 'Peer is offline', queueTitle: 'Peer is offline', optionsHint: null,
    });
  });

  it('disables a not-connected local render without naming a reason', () => {
    expect(run({ notConnected: true })).toMatchObject({
      canEnqueue: false, generateTitle: undefined, queueTitle: QUEUE_GENERIC,
    });
  });

  it('tells a missing BYOV runtime from one still being probed', () => {
    const byov = { byovGateBlocked: true, byovRuntime: 'example_rt' };
    expect(run({ ...byov, byovRuntimeMissing: true, byovLabel: 'Example RT' })).toMatchObject({
      canEnqueue: false,
      generateTitle: 'Example RT runtime is not installed — use the install banner above',
    });
    expect(run({ ...byov, byovRuntimeMissing: true })).toMatchObject({
      generateTitle: 'example_rt runtime is not installed — use the install banner above',
    });
    expect(run(byov)).toMatchObject({
      canEnqueue: false, generateTitle: 'Checking example_rt runtime status…',
    });
  });

  it('keeps an off-machine render enabled with an empty title while a BYOV runtime is still selected', () => {
    expect(run({
      rendersOffMachine: true, byovGateBlocked: true, byovRuntimeMissing: true, byovRuntime: 'example_rt',
      blockedAsset: { label: 'selected model weights' }, extendModeBlocked: true, notConnected: true,
    })).toEqual({
      canEnqueue: true, generateTitle: undefined, queueTitle: QUEUE_READY, optionsHint: null,
    });
  });

  it('names a blocked download in every surface', () => {
    expect(run({ blockedAsset: { label: 'shared text encoder' } })).toEqual({
      canEnqueue: false,
      generateTitle: 'Download the shared text encoder before generating',
      queueTitle: 'Download the shared text encoder before queueing',
      optionsHint: 'Open Options to download the shared text encoder',
    });
  });

  it('names extend, IC-LoRA and keyframe blocks', () => {
    expect(run({ extendModeBlocked: true })).toMatchObject({
      canEnqueue: false,
      generateTitle: 'Pick a prior render and wait for the last frame to extract before generating',
      queueTitle: 'Pick a prior render and wait for the last frame to extract before queueing',
      optionsHint: 'Open Options to pick a prior render and wait for its last frame',
    });
    expect(run({ icLoraModeBlocked: true })).toMatchObject({
      canEnqueue: false,
      generateTitle: 'Add the reference media required by this mode before generating',
      optionsHint: 'Open Options to add the reference media required by this mode',
    });
    expect(run({ keyframesBlocked: true, keyframesError: 'Add a second keyframe' })).toMatchObject({
      canEnqueue: false,
      generateTitle: 'Add a second keyframe',
      optionsHint: 'Open Options: Add a second keyframe',
    });
  });

  it('explains audio-to-video blocks in order: duration, model, audio, image', () => {
    const a2v = { a2vModeBlocked: true, modelRuntime: 'ltx2' };
    const reason = (overrides) => run({ ...a2v, ...overrides }).generateTitle;
    expect(reason({ a2vDurationError: 'Audio is too long' })).toBe('Audio is too long');
    expect(reason({ modelRuntime: 'minimax_h3' }))
      .toBe('a2v mode requires an audio-to-video model — pick one from the Model dropdown');
    expect(reason({})).toBe('Pick an audio file before generating');
    expect(reason({ audioFile: { name: 'voice.wav' } })).toBe('Pick a reference image before generating with this model');
    expect(run({ ...a2v, a2vDurationError: 'Audio is too long' }).optionsHint)
      .toBe('Open Options: Audio is too long');
    expect(run({ ...a2v, a2vDurationError: 'Audio is too long' }).canEnqueue).toBe(false);
  });

  it('reports the first disabling row when several apply', () => {
    expect(run({
      blockedAsset: { label: 'Control weight' }, extendModeBlocked: true, icLoraModeBlocked: true,
    })).toMatchObject({
      generateTitle: 'Download the Control weight before generating',
      optionsHint: 'Open Options to download the Control weight',
    });
    // An earlier row without a hint does not hide a later hinted row's caption.
    expect(run({ notConnected: true, extendModeBlocked: true }).optionsHint)
      .toBe('Open Options to pick a prior render and wait for its last frame');
  });
});
