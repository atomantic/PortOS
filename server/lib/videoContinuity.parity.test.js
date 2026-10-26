/**
 * Cross-package parity for the chained-render continuation contract.
 *
 * `server/lib/videoContinuity.js` is the source of truth — it defaults, clamps,
 * and picks the strategy. `client/src/lib/videoGenParams.js` carries a small
 * mirror of the parts the Continuity picker has to display: the default window
 * size, the option list, and which runtimes can use a window at all.
 *
 * This suite imports BOTH and asserts they agree, so an unmirrored server-side
 * change fails CI here rather than surfacing as a UI that quietly disagrees
 * with what renders. The concrete failures it prevents: the picker preselecting
 * one window while the server renders another (the user never sees which they
 * got), an option outside the route's accepted range 400ing only after Generate
 * is pressed, and the control appearing for a runtime whose renders ignore it.
 *
 * It lives server-side, matching `icLoraWeights.parity.test.js`, because the
 * pure client mirror loads fine under the node runner while the reverse isn't
 * guaranteed.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONTEXT_FRAMES, MIN_CONTEXT_FRAMES, MAX_CONTEXT_FRAMES,
  supportsContextWindow as serverSupportsContextWindow, publicContinuationCapability, continuationContract,
} from './videoContinuity.js';
import {
  DEFAULT_CONTEXT_FRAMES as CLIENT_DEFAULT_CONTEXT_FRAMES,
  CONTEXT_FRAME_OPTIONS, contextFrameOptionsForModel, frameOptionsForModel, videoChainChunkModes,
  supportsContextWindow as clientSupportsContextWindow,
} from '../../client/src/lib/videoGenParams.js';

describe('continuation context window — server/client parity', () => {
  it('mirrors the default window size', () => {
    expect(CLIENT_DEFAULT_CONTEXT_FRAMES).toBe(DEFAULT_CONTEXT_FRAMES);
  });

  it('offers the default as a selectable option', () => {
    // A default the picker can't display leaves the select with no matching
    // <option>, which renders as a blank control.
    expect(CONTEXT_FRAME_OPTIONS).toContain(DEFAULT_CONTEXT_FRAMES);
  });

  it('keeps every option inside the range the route accepts', () => {
    for (const n of CONTEXT_FRAME_OPTIONS) {
      expect(n).toBeGreaterThanOrEqual(MIN_CONTEXT_FRAMES);
      expect(n).toBeLessThanOrEqual(MAX_CONTEXT_FRAMES);
    }
  });

  it('offers 0 — last-frame chaining is a real choice, not "unset"', () => {
    expect(CONTEXT_FRAME_OPTIONS).toContain(0);
  });

  it('agrees on which runtimes can use a window', () => {
    for (const runtime of ['ltx2', 'ltx25', 'mlx_video', 'minimax_h3', 'minimax_h3_cuda', 'wan22', 'fastvideo', undefined]) {
      const model = { runtime, continuationCapability: publicContinuationCapability({ runtime }) };
      expect(clientSupportsContextWindow(model)).toBe(serverSupportsContextWindow(model));
      if (!serverSupportsContextWindow(model)) expect(contextFrameOptionsForModel(model)).toEqual([0]);
    }
    expect(clientSupportsContextWindow(null)).toBe(serverSupportsContextWindow(null));
  });
  it('honors a server refusal even for a legacy window runtime', () => {
    expect(clientSupportsContextWindow({ runtime: 'ltx2', continuationCapability: {
      temporalContext: false, unavailableReason: 'Pin unverified',
    } })).toBe(false);
  });

  it('keeps H3 history and output frame grids independent of LTX stride', () => {
    const model = { runtime: 'minimax_h3', frameStride: 4, frameOptions: [61, 121],
      continuationCapability: { temporalContext: true, historyFrames: 17, outputLayout: 'new-output-only' } };
    expect(videoChainChunkModes({ model, mode: 'image', chaining: true, contextFrames: 17 })).toEqual(['image', 'text']);
    expect(contextFrameOptionsForModel(model)).toEqual([0, 17]);
    expect(frameOptionsForModel(model, 125)).toEqual([61, 121]);
    expect(continuationContract(model.runtime).latentFrameStride).toBeUndefined();
  });

});
