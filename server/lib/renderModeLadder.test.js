/**
 * `renderModeLadder.js` is a dependency-free leaf hoisted out of
 * `services/imageGen/cloudProviderConfig.js` (#6815) specifically so the
 * client can import it directly instead of hand-copying the ladder — the
 * hand copy in `VisualGenSettings.jsx` is what drifted and prompted this
 * split. `cloudProviderConfig.test.js` already exercises `isModeUsable` /
 * `pickUsableMode` / `renderTargetDefaults` exhaustively through the
 * re-export, so this file does not repeat that matrix. It instead pins the
 * two things unique to this module's own boundary: the candidate ORDER
 * `imageModeCandidates` declares (never tested elsewhere — the callers all
 * inline their own array), and that resolving through this leaf directly
 * (not proxied through the service layer) reproduces the exact fall-through
 * behavior the "Auto" label bug (#6815) depended on.
 */

import { describe, it, expect } from 'vitest';
import {
  imageModeCandidates, isModeUsable, pickUsableMode, renderTargetDefaults,
} from './renderModeLadder.js';
import { IMAGE_GEN_MODE } from './generationModes.js';
import { RENDER_TARGET } from './renderTargets.js';

const settingsWith = (imageGen, renderDefaults) => ({ imageGen, renderDefaults });

describe('imageModeCandidates (#6815)', () => {
  it('declares the candidate order: record pin, then target pin, then install default', () => {
    const settings = settingsWith(
      { mode: IMAGE_GEN_MODE.GROK },
      { [RENDER_TARGET.PIPELINE_VISUAL]: { imageMode: IMAGE_GEN_MODE.AGY } },
    );
    const record = { imageMode: IMAGE_GEN_MODE.CODEX };
    expect(imageModeCandidates(settings, RENDER_TARGET.PIPELINE_VISUAL, record)).toEqual([
      IMAGE_GEN_MODE.CODEX, // record pin
      IMAGE_GEN_MODE.AGY, // render-target pin
      IMAGE_GEN_MODE.GROK, // install-wide default
    ]);
  });

  it('normalizes an absent record and an unset target pin to null rather than dropping the slot', () => {
    const settings = settingsWith({ mode: IMAGE_GEN_MODE.CODEX }, {});
    expect(imageModeCandidates(settings, RENDER_TARGET.PIPELINE_VISUAL)).toEqual([
      null, null, IMAGE_GEN_MODE.CODEX,
    ]);
  });

  it('collapses the `auto` sentinel on a target pin to null (renderTargetDefaults normalization)', () => {
    const settings = settingsWith(
      { mode: IMAGE_GEN_MODE.CODEX },
      { [RENDER_TARGET.PIPELINE_VISUAL]: { imageMode: 'auto' } },
    );
    expect(imageModeCandidates(settings, RENDER_TARGET.PIPELINE_VISUAL, { imageMode: 'auto' })).toEqual([
      null, null, IMAGE_GEN_MODE.CODEX,
    ]);
  });
});

describe('pickUsableMode + imageModeCandidates composed (the "Auto" label bug, #6815)', () => {
  // This is the exact scenario the issue describes: a record pinned to a
  // backend that is DISABLED (or was pinned before this install had it
  // configured at all) must fall through to the next rung rather than
  // sticking — a pin is a preference, not a guarantee.
  it('falls through a disabled record pin to the render-target pin', () => {
    const settings = settingsWith(
      { agy: { enabled: false }, codex: { enabled: true } },
      { [RENDER_TARGET.PIPELINE_VISUAL]: { imageMode: IMAGE_GEN_MODE.CODEX } },
    );
    const record = { imageMode: IMAGE_GEN_MODE.AGY };
    const resolved = pickUsableMode(settings, imageModeCandidates(settings, RENDER_TARGET.PIPELINE_VISUAL, record));
    expect(resolved).toBe(IMAGE_GEN_MODE.CODEX);
  });

  it('falls through a disabled render-target pin to the install-wide default', () => {
    const settings = settingsWith(
      { grok: { enabled: false }, codex: { enabled: true }, mode: IMAGE_GEN_MODE.CODEX },
      { [RENDER_TARGET.PIPELINE_VISUAL]: { imageMode: IMAGE_GEN_MODE.GROK } },
    );
    const resolved = pickUsableMode(settings, imageModeCandidates(settings, RENDER_TARGET.PIPELINE_VISUAL));
    expect(resolved).toBe(IMAGE_GEN_MODE.CODEX);
  });

  it('reaches the cloud-then-local tail (auto-default) when no pin or install default exists', () => {
    const settings = settingsWith({ codex: { enabled: true } }, {});
    // No record, no target pin, no install default — nothing but the tail.
    const resolved = pickUsableMode(settings, imageModeCandidates(settings, RENDER_TARGET.PIPELINE_VISUAL));
    expect(resolved).toBe(IMAGE_GEN_MODE.CODEX);
  });

  it('lands on local when nothing in the whole ladder is usable', () => {
    const settings = settingsWith({}, {});
    const resolved = pickUsableMode(settings, imageModeCandidates(settings, RENDER_TARGET.PIPELINE_VISUAL));
    expect(resolved).toBe(IMAGE_GEN_MODE.LOCAL);
  });

  it('an explicit per-request mode (prepended by the caller) outranks every pin', () => {
    // The caller's own explicit override is NOT part of imageModeCandidates —
    // it is prepended ahead of the ladder, and is not usability-gated away
    // from a record pin the way a pin is gated against another pin.
    const settings = settingsWith(
      { agy: { enabled: true }, codex: { enabled: true } },
      { [RENDER_TARGET.PIPELINE_VISUAL]: { imageMode: IMAGE_GEN_MODE.AGY } },
    );
    const record = { imageMode: IMAGE_GEN_MODE.AGY };
    const resolved = pickUsableMode(settings, [
      IMAGE_GEN_MODE.CODEX,
      ...imageModeCandidates(settings, RENDER_TARGET.PIPELINE_VISUAL, record),
    ]);
    expect(resolved).toBe(IMAGE_GEN_MODE.CODEX);
  });
});

describe('isModeUsable (leaf boundary)', () => {
  // cloudProviderConfig.test.js exhaustively covers this predicate through the
  // re-export; this is a minimal smoke test that imports it directly from the
  // dependency-free leaf, which has no `resolveCloudProviderConfig` to call —
  // it derives usability from `QUEUEABLE_IMAGE_MODES` + the enable toggle only.
  it('local is always usable, cloud modes are gated on their enable toggle, external never is', () => {
    const settings = settingsWith({ codex: { enabled: true }, grok: { enabled: false } }, {});
    expect(isModeUsable(settings, IMAGE_GEN_MODE.LOCAL)).toBe(true);
    expect(isModeUsable(settings, IMAGE_GEN_MODE.CODEX)).toBe(true);
    expect(isModeUsable(settings, IMAGE_GEN_MODE.GROK)).toBe(false);
    expect(isModeUsable(settings, IMAGE_GEN_MODE.EXTERNAL)).toBe(false);
  });
});

describe('renderTargetDefaults (leaf boundary)', () => {
  it('reads the render-target pin straight from settings.renderDefaults', () => {
    const settings = settingsWith({}, {
      [RENDER_TARGET.SPRITE_REFERENCE]: { imageMode: IMAGE_GEN_MODE.AGY, imageModel: 'gemini-3.5-pro' },
    });
    expect(renderTargetDefaults(settings, RENDER_TARGET.SPRITE_REFERENCE)).toEqual({
      imageMode: IMAGE_GEN_MODE.AGY, imageModel: 'gemini-3.5-pro', videoMode: null, videoModel: null,
    });
  });
});
