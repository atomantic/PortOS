import { describe, it, expect } from 'vitest';
import {
  videoModelMemoryGb, computeFflfSafeFrames, isModelAllowedForMode,
  VIDEO_EDGE_BOUNDS, videoEdgeBoundsForModel, FRAME_OPTIONS, FPS_OPTIONS,
  WAN_FRAME_OPTIONS, frameOptionsForModel, fpsOptionsForModel,
  normalizeFramesForModel, normalizeFpsForModel,
  supportsVideoAudioControls, supportsVideoAudioPromptControls,
  IC_LORA_MODES, IC_LORA_MODE_VALUES, isIcLoraMode, icLoraSpecForMode,
  icResolutionIssue,
  DEFAULT_SPEED_PROFILE_ID, isDefaultSpeedProfileId, speedProfilesForModel,
  speedProfilesForMode, normalizeSpeedProfileForModel,
  speedProfileIdFromRecord, selectedSpeedProfile, videoChainChunkModes,
  DEFAULT_DRAFT_DECODE_ID, isFullDecodeId, draftDecodeOptionsForModel,
  supportsDraftDecode, normalizeDraftDecodeForModel, draftDecodeFromRecord,
  resolveDraftDecodeForModel,
} from './videoGenParams.js';

describe('videoModelMemoryGb', () => {
  it('prefers an explicit positive memoryGb field', () => {
    expect(videoModelMemoryGb({ memoryGb: 24, name: '~48 GB' })).toBe(24);
  });
  it('falls back to a "~NN GB" hint in the name', () => {
    expect(videoModelMemoryGb({ name: 'LTX 2.3 (~12.5 GB)' })).toBe(12.5);
    expect(videoModelMemoryGb({ name: 'Wan 2.2 (~17 GiB)' })).toBe(17);
  });
  it('returns +Infinity when neither is present so it never spuriously fits a budget', () => {
    expect(videoModelMemoryGb({ name: 'mystery model' })).toBe(Number.POSITIVE_INFINITY);
    expect(videoModelMemoryGb(null)).toBe(Number.POSITIVE_INFINITY);
  });
  it('ignores a non-positive memoryGb and falls through', () => {
    expect(videoModelMemoryGb({ memoryGb: 0, name: '~8 GB' })).toBe(8);
  });
});

describe('computeFflfSafeFrames', () => {
  it('returns numFrames unchanged when it already fits the budget', () => {
    expect(computeFflfSafeFrames(768, 512, 121, 768 * 512 * 200)).toBe(121);
  });
  it('is fail-open (returns numFrames) when the budget is unknown', () => {
    expect(computeFflfSafeFrames(768, 512, 121, undefined)).toBe(121);
    expect(computeFflfSafeFrames(768, 512, 121, 0)).toBe(121);
  });
  it('clamps down to the LTX 8k+1 latent boundary when over budget', () => {
    // budget fits ~50 pixel-frames → safeLatent = floor((50-1)/8)=6 → 6*8+1=49
    const budget = 768 * 512 * 50;
    const out = computeFflfSafeFrames(768, 512, 121, budget);
    expect(out).toBe(49);
    expect((out - 1) % 8).toBe(0);
    expect(out).toBeLessThan(121);
  });
  it('returns numFrames for degenerate (0) dimensions', () => {
    expect(computeFflfSafeFrames(0, 512, 121, 1000)).toBe(121);
  });
});

describe('isModelAllowedForMode', () => {
  it('rejects a null model', () => {
    expect(isModelAllowedForMode(null, 'text')).toBe(false);
  });
  it('allows general runtimes for the modes their entry resolves', () => {
    // The server resolves supportedModes onto EVERY entry at load
    // (server/lib/videoModeProfiles.js) — these are the mlx_video / ltx2 rows.
    const mlx = { runtime: 'mlx_video', supportedModes: ['text', 'image', 'fflf', 'extend'] };
    const ltx2 = { runtime: 'ltx2', supportedModes: ['text', 'image', 'fflf', 'extend'] };
    expect(isModelAllowedForMode(mlx, 'text')).toBe(true);
    expect(isModelAllowedForMode(ltx2, 'image')).toBe(true);
  });
  it('rejects every mode for a model that resolved no supportedModes (#3737)', () => {
    // "Declares nothing" used to mean "supports everything", which offered FFLF
    // on runtimes that silently drop the second keyframe. Post-backfill an
    // absent list can only mean a payload that never came from the registry.
    expect(isModelAllowedForMode({ runtime: 'mlx_video' }, 'text')).toBe(false);
    expect(isModelAllowedForMode({ runtime: 'mlx_video', supportedModes: [] }, 'text')).toBe(false);
  });
  it('filters Wan models by their declared text/image capabilities', () => {
    const ti2v = { runtime: 'wan22', supportedModes: ['text', 'image'] };
    const i2v = { runtime: 'wan22', supportedModes: ['image'] };
    expect(isModelAllowedForMode(ti2v, 'text')).toBe(true);
    expect(isModelAllowedForMode(ti2v, 'image')).toBe(true);
    expect(isModelAllowedForMode(i2v, 'text')).toBe(false);
    expect(isModelAllowedForMode(i2v, 'image')).toBe(true);
    expect(isModelAllowedForMode(ti2v, 'fflf')).toBe(false);
  });
  it('filters any model with an explicit supportedModes contract', () => {
    const h3 = { runtime: 'minimax_h3', supportedModes: ['text'] };
    expect(isModelAllowedForMode(h3, 'text')).toBe(true);
    expect(isModelAllowedForMode(h3, 'image')).toBe(false);
    expect(isModelAllowedForMode(h3, 'fflf')).toBe(false);
  });
  it('requires the ltx2 runtime for a2v', () => {
    expect(isModelAllowedForMode({ runtime: 'ltx2' }, 'a2v')).toBe(true);
    expect(isModelAllowedForMode({ runtime: 'mlx_video' }, 'a2v')).toBe(false);
  });
});

describe('constants', () => {
  it('VIDEO_EDGE_BOUNDS mirrors the server 64..2048 grid', () => {
    expect(VIDEO_EDGE_BOUNDS).toEqual({ min: 64, max: 2048, step: 64 });
    expect(videoEdgeBoundsForModel({ resolutionStep: 32 })).toEqual({ min: 64, max: 2048, step: 32 });
    expect(videoEdgeBoundsForModel({ resolutionStep: 0 })).toEqual(VIDEO_EDGE_BOUNDS);
  });
  it('frame/fps option lists are on the expected boundaries', () => {
    expect(FRAME_OPTIONS[0]).toBe(25);
    expect(FRAME_OPTIONS.every((f) => (f - 1) % 8 === 0)).toBe(true);
    expect(FPS_OPTIONS).toEqual([16, 24, 30]);
    expect(WAN_FRAME_OPTIONS.every((f) => (f - 1) % 4 === 0)).toBe(true);
  });
  it('selects and normalizes model-aware Wan frame/fps values', () => {
    const wan = { frameStride: 4, fpsOptions: [16, 20, 24] };
    expect(frameOptionsForModel(wan)).toBe(WAN_FRAME_OPTIONS);
    expect(fpsOptionsForModel(wan)).toEqual([16, 20, 24]);
    expect(normalizeFramesForModel(97, wan)).toBe(97);
    expect(normalizeFramesForModel(109, wan)).toBe(109);
    expect(frameOptionsForModel(wan, 109)).toContain(109);
    expect(normalizeFramesForModel(98, wan)).toBe(97);
    expect(normalizeFpsForModel(30, wan)).toBe(24);
  });
  it('uses an explicit model frame list and fixed fps for MiniMax H3', () => {
    const h3 = { frameOptions: [124, 141, 158], fpsOptions: [24] };
    expect(frameOptionsForModel(h3)).toEqual([124, 141, 158]);
    expect(frameOptionsForModel(h3, 175)).toEqual([124, 141, 158]);
    expect(normalizeFramesForModel(140, h3)).toBe(141);
    expect(normalizeFpsForModel(30, h3)).toBe(24);
  });
  it('keeps muting separate from prompt-audio steering', () => {
    expect(supportsVideoAudioControls({ runtime: 'mlx_video' })).toBe(true);
    expect(supportsVideoAudioControls({ supportsDisableAudio: false })).toBe(false);
    expect(supportsVideoAudioPromptControls({ supportsDisableAudio: false })).toBe(true);
    expect(supportsVideoAudioPromptControls({ supportsAudioPrompting: false })).toBe(false);
  });
});

describe('IC-LoRA remix modes (#3100)', () => {
  it('mirrors the server registry shape', () => {
    expect(IC_LORA_MODE_VALUES).toEqual(['ic-control', 'ic-colorize', 'ic-ingredients']);
    for (const spec of IC_LORA_MODES) {
      // The `ic-` prefix drives the download-id router in useModelDownloadStatus.
      expect(spec.mode.startsWith('ic-')).toBe(true);
      expect(spec.maxReferences).toBeGreaterThanOrEqual(spec.minReferences);
      expect(spec.referenceDownscaleFactor).toBeGreaterThanOrEqual(1);
      // The panel renders these two directly — an empty one ships blank copy.
      expect(spec.uploadLabel).toBeTruthy();
      expect(spec.description).toBeTruthy();
      // Drives which input surface the panel renders (single clip vs the 2-8
      // gallery row list), so an unrecognized value would render nothing.
      expect(['video', 'image']).toContain(spec.referenceKind);
    }
  });

  it('mirrors the Ingredients bounds + image kind (#3112)', () => {
    // The 2-8 count is the weight's contract, mirrored here so the form blocks
    // before a POST the route would reject; the parity test in
    // server/lib/icLoraWeights.parity.test.js is what keeps the two in step.
    const ing = icLoraSpecForMode('ic-ingredients');
    expect(ing.minReferences).toBe(2);
    expect(ing.maxReferences).toBe(8);
    expect(ing.referenceKind).toBe('image');
    // Factor 1 → no divisibility rule at all, so an odd resolution is legal.
    expect(icResolutionIssue(ing, 705, 449)).toBeNull();
  });
  it('identifies IC modes', () => {
    expect(isIcLoraMode('ic-control')).toBe(true);
    expect(isIcLoraMode('ic-colorize')).toBe(true);
    expect(isIcLoraMode('text')).toBe(false);
    expect(isIcLoraMode(undefined)).toBe(false);
  });
  it('resolves a spec by mode, null otherwise', () => {
    expect(icLoraSpecForMode('ic-control')?.label).toBe('Control');
    expect(icLoraSpecForMode('ic-colorize')?.label).toBe('Colorize');
    expect(icLoraSpecForMode('extend')).toBeNull();
  });
  it('requires the ltx2 runtime for IC modes', () => {
    for (const mode of IC_LORA_MODE_VALUES) {
      expect(isModelAllowedForMode({ runtime: 'ltx2' }, mode)).toBe(true);
      expect(isModelAllowedForMode({ runtime: 'mlx_video' }, mode)).toBe(false);
      expect(isModelAllowedForMode({ runtime: 'wan22' }, mode)).toBe(false);
    }
  });
  it('keeps each mode on its own resolution rule (Control 2, Colorize 1)', () => {
    // Mirrors server/lib/icLoraWeights.js, where each factor is READ from that
    // weight's safetensors metadata — a drift here would let the form accept a
    // resolution the server rejects with IC_LORA_RESOLUTION_NOT_DIVISIBLE, or
    // reject one the server would happily render.
    expect(icLoraSpecForMode('ic-control').referenceDownscaleFactor).toBe(2);
    expect(icLoraSpecForMode('ic-colorize').referenceDownscaleFactor).toBe(1);
  });
  it('gives each mode a distinct upload label so the panel reads correctly', () => {
    // The panel is fully spec-driven; a shared label would tell a Colorize user
    // to upload a depth/pose clip.
    const labels = IC_LORA_MODES.map((m) => m.uploadLabel);
    expect(new Set(labels).size).toBe(labels.length);
    expect(icLoraSpecForMode('ic-colorize').uploadLabel).toMatch(/B&W/);
  });
});

// Speed profiles (#4875) — the client-side half of the sentinel + option list.
// Cross-package agreement with the server is pinned separately by
// server/lib/videoSpeedProfiles.parity.test.js.
describe('speed profiles', () => {
  const FAST = { id: 'fast', name: 'Fast', steps: 8, guidance: 1.0, modes: ['text', 'image'] };
  const model = { runtime: 'ltx25', speedProfiles: [FAST] };

  it('reads the server-decorated list and tolerates a model without one', () => {
    expect(speedProfilesForModel(model)).toEqual([FAST]);
    expect(speedProfilesForModel({})).toEqual([]);
    expect(speedProfilesForModel(null)).toEqual([]);
    // A malformed entry must not reach the <option> map as a keyless row.
    expect(speedProfilesForModel({ speedProfiles: [FAST, {}, null] })).toEqual([FAST]);
  });

  it('snaps an unknown or stale selection back to the default', () => {
    expect(normalizeSpeedProfileForModel('fast', model)).toBe('fast');
    expect(normalizeSpeedProfileForModel('turbo', model)).toBe(DEFAULT_SPEED_PROFILE_ID);
    // The case that matters: switching to a model that declares nothing.
    expect(normalizeSpeedProfileForModel('fast', {})).toBe(DEFAULT_SPEED_PROFILE_ID);
  });

  it('reads a record back, treating absence as the default', () => {
    expect(speedProfileIdFromRecord('fast')).toBe('fast');
    for (const v of [undefined, null, '', 7]) {
      expect(speedProfileIdFromRecord(v)).toBe(DEFAULT_SPEED_PROFILE_ID);
    }
  });

  it('treats absence, empty string and the default id as one request', () => {
    for (const v of [undefined, null, '', DEFAULT_SPEED_PROFILE_ID]) {
      expect(isDefaultSpeedProfileId(v)).toBe(true);
    }
    expect(isDefaultSpeedProfileId('fast')).toBe(false);
  });

  // The mode filter is what keeps the picker from offering — and the Steps/CFG
  // lock from honoring — a profile the server would decline.
  it('offers a profile only for the modes it declares', () => {
    expect(speedProfilesForMode(model, 'text')).toEqual([FAST]);
    expect(speedProfilesForMode(model, 'image')).toEqual([FAST]);
    expect(speedProfilesForMode(model, 'fflf')).toEqual([]);
    expect(speedProfilesForMode(model, 'extend')).toEqual([]);
    // An absent mode is the default text render.
    expect(speedProfilesForMode(model, null)).toEqual([FAST]);
    // A profile with no declared modes falls back to the two-stage set, NOT to
    // "unrestricted" — the server's decline check applies exactly that
    // fallback, and reading it permissively here would offer a profile on fflf
    // that the server then declines.
    const noModes = { speedProfiles: [{ id: 'any' }] };
    expect(speedProfilesForMode(noModes, 'text')).toEqual([{ id: 'any' }]);
    expect(speedProfilesForMode(noModes, 'image')).toEqual([{ id: 'any' }]);
    expect(speedProfilesForMode(noModes, 'fflf')).toEqual([]);
  });

  // The bug this guards: with TWO profiles, resolving the selection against the
  // unfiltered list would lock Steps/CFG to one this mode declines.
  it('resolves the active profile against the mode-filtered set', () => {
    const twoProfiles = { speedProfiles: [FAST, { id: 'blitz', steps: 4, guidance: 1, modes: ['fflf'] }] };
    expect(selectedSpeedProfile('blitz', twoProfiles, 'fflf')?.id).toBe('blitz');
    expect(selectedSpeedProfile('blitz', twoProfiles, 'text')).toBeNull();
    expect(selectedSpeedProfile('fast', twoProfiles, 'text')?.id).toBe('fast');
  });

  // Mirrors the server's own inference for an absent mode
  // (`rest.mode || (rest.sourceImagePath ? 'image' : 'text')`) — the two must
  // not disagree the moment a profile ships supporting 'text' but not 'image'.
  it('infers the first chunk mode exactly as the server does when mode is absent', () => {
    const ltx = { runtime: 'ltx25' };
    const modes = (o) => videoChainChunkModes({ model: ltx, chaining: false, ...o });
    expect(modes({ mode: null })).toEqual(['text']);
    expect(modes({ mode: null, hasSourceImage: true })).toEqual(['image']);
    // An explicit mode always wins over the inference.
    expect(modes({ mode: 'fflf', hasSourceImage: true })).toEqual(['fflf']);
  });

  it('derives the chunk modes a chain will actually run in', () => {
    const ltx = { runtime: 'ltx25' };
    const nonLtx = { runtime: 'wan22' };
    // Window continuity needs BOTH a positive window and an extend pipeline.
    expect(videoChainChunkModes({ model: ltx, mode: 'text', chaining: true, contextFrames: 22 }))
      .toEqual(['text', 'extend']);
    expect(videoChainChunkModes({ model: ltx, mode: 'text', chaining: true, contextFrames: 0 }))
      .toEqual(['text', 'image']);
    expect(videoChainChunkModes({ model: nonLtx, mode: 'text', chaining: true, contextFrames: 22 }))
      .toEqual(['text', 'image']);
    // Not chaining → one chunk, whatever the continuity setting says.
    expect(videoChainChunkModes({ model: ltx, mode: 'text', chaining: false, contextFrames: 22 }))
      .toEqual(['text']);
  });

  // resolveContextFrames reads absent / '' / non-finite as the 22-frame
  // DEFAULT, not as zero. Reading it as a frame hop here would show the Fast
  // picker (and grey out Steps/CFG) for a chain the server declines wholesale.
  it('treats an omitted contextFrames as the windowed default, exactly as the server does', () => {
    const ltx = { runtime: 'ltx25' };
    const modes = (contextFrames) => videoChainChunkModes({ model: ltx, mode: 'text', chaining: true, contextFrames });
    for (const absent of [undefined, null, '', Number.NaN, 'nonsense']) {
      expect(modes(absent)).toEqual(['text', 'extend']);
    }
    // An explicit 0 is a REAL value — it opts back into last-frame chaining.
    expect(modes(0)).toEqual(['text', 'image']);
    expect(modes('0')).toEqual(['text', 'image']);
    expect(modes(22)).toEqual(['text', 'extend']);
  });

  // The exact expression the submit builder uses
  // (`selectedSpeedProfile(id, model, videoChainChunkModes(...))?.id`). It must
  // agree with the PICKER's gate, or the form posts a schedule it already
  // decided doesn't apply — which the route then persists, echoes back on
  // reload, and seeds into a Retry as a profile the render never used.
  describe('submit gate matches the picker gate', () => {
    const model = { runtime: 'ltx25', speedProfiles: [FAST] };
    const submitted = (ctx) => selectedSpeedProfile(
      ctx.speedProfileId, model, videoChainChunkModes({ model, ...ctx }),
    )?.id;

    it('posts the profile for a request it really applies to', () => {
      expect(submitted({ speedProfileId: 'fast', mode: 'text', chaining: false })).toBe('fast');
      expect(submitted({ speedProfileId: 'fast', mode: 'image', chaining: false })).toBe('fast');
    });

    it('drops a stale selection after the user switches to an unsupported mode', () => {
      // The picker hides and Steps/CFG unlock, but state still holds 'fast'.
      expect(submitted({ speedProfileId: 'fast', mode: 'fflf', chaining: false })).toBeUndefined();
      expect(submitted({ speedProfileId: 'fast', mode: 'extend', chaining: false })).toBeUndefined();
    });

    it('drops it after the user raises Chunks onto a window-continuity chain', () => {
      expect(submitted({ speedProfileId: 'fast', mode: 'text', chaining: true, contextFrames: 22 }))
        .toBeUndefined();
      // …but keeps it on a frame hop, where every chunk qualifies.
      expect(submitted({ speedProfileId: 'fast', mode: 'text', chaining: true, contextFrames: 0 }))
        .toBe('fast');
    });

    it('posts nothing for the default profile', () => {
      expect(submitted({ speedProfileId: DEFAULT_SPEED_PROFILE_ID, mode: 'text', chaining: false }))
        .toBeUndefined();
    });
  });

  it('resolves the selected profile object, or null for the default', () => {
    expect(selectedSpeedProfile('fast', model, 'text')).toBe(FAST);
    expect(selectedSpeedProfile(DEFAULT_SPEED_PROFILE_ID, model, 'text')).toBeNull();
    expect(selectedSpeedProfile('fast', {}, 'text')).toBeNull();
  });
});

// Draft decode (#5423). The decoder table itself is server-side — only these
// sentinel rules live here, and each one exists to stop the form POSTing a knob
// the server would decline (or dropping one the user chose).
describe('draft decode helpers', () => {
  const OPTIONS = [
    { id: 'full', label: 'Full decode' },
    { id: 'draft', label: 'Draft decode' },
  ];

  // Absence, '' and 'full' are ONE request, mirroring `isFullDecode` on the
  // server. If they diverged, an omitted field would start sending a decode
  // override and a pre-feature payload would stop being byte-identical.
  it.each([undefined, null, '', DEFAULT_DRAFT_DECODE_ID])('reads %p as a full decode', (id) => {
    expect(isFullDecodeId(id)).toBe(true);
  });

  it('does not read a declared decoder id as full', () => {
    expect(isFullDecodeId('draft')).toBe(false);
  });

  // Empty is the signal to render NO control — a model with no draft decoder
  // must not be given a one-entry select implying a choice it doesn't have.
  it.each([
    ['a model with no options field', {}],
    ['an empty option list', { draftDecodeOptions: [] }],
    ['options with no ids', { draftDecodeOptions: [{ label: 'broken' }] }],
  ])('offers nothing for %s', (_label, model) => {
    expect(draftDecodeOptionsForModel(model)).toEqual([]);
    expect(supportsDraftDecode(model)).toBe(false);
  });

  it('passes through a declared option list', () => {
    expect(draftDecodeOptionsForModel({ draftDecodeOptions: OPTIONS })).toEqual(OPTIONS);
  });

  // A model switch must not leave "Draft" selected on a model whose renders
  // would then silently be full decodes.
  it.each([
    ['an id this model offers', 'draft', { draftDecodeOptions: OPTIONS }, 'draft'],
    ['an id it does not', 'draft', { draftDecodeOptions: [] }, DEFAULT_DRAFT_DECODE_ID],
    ['an unknown id', 'turbo', { draftDecodeOptions: OPTIONS }, DEFAULT_DRAFT_DECODE_ID],
  ])('normalizes %s', (_label, id, model, expected) => {
    expect(normalizeDraftDecodeForModel(id, model)).toBe(expected);
  });

  // Records store only a NON-default decode, so a missing field must CLEAR a
  // leftover selection rather than carry it into a faithful re-render.
  it.each([
    [undefined, DEFAULT_DRAFT_DECODE_ID],
    [null, DEFAULT_DRAFT_DECODE_ID],
    ['', DEFAULT_DRAFT_DECODE_ID],
    ['draft', 'draft'],
  ])('reads %p out of a record as %p', (stored, expected) => {
    expect(draftDecodeFromRecord(stored)).toBe(expected);
  });

  // Delivery intent outranks declaration (#5449), the same order
  // `draftDecodeDeclineReason` gates it server-side: a model another entry
  // names as its Finish target always decodes on its own decoder, even when it
  // declares a draft decoder of its own.
  describe('resolveDraftDecodeForModel', () => {
    const DELIVERY = { id: 'delivery_model', draftDecodeOptions: OPTIONS };
    const DRAFT = { id: 'draft_model', finishModelId: 'delivery_model', draftDecodeOptions: OPTIONS };
    const MODELS = [DRAFT, DELIVERY];

    it('keeps a declared decode on a model at the draft end of the graph', () => {
      expect(resolveDraftDecodeForModel('draft', DRAFT, MODELS)).toBe('draft');
    });

    it('snaps to full on a delivery model even though it declares a decoder', () => {
      expect(resolveDraftDecodeForModel('draft', DELIVERY, MODELS)).toBe(DEFAULT_DRAFT_DECODE_ID);
    });

    // Without the list nothing can be read as a delivery target, so this must
    // fall through to the plain declaration check rather than locking to full.
    it('falls back to the declaration check when the model list is absent', () => {
      expect(resolveDraftDecodeForModel('draft', DELIVERY, null)).toBe('draft');
    });
  });
});

// @vitest-environment node
