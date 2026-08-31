import { describe, expect, it } from 'vitest';
import {
  FABLELOOM_AUDIO_TARGETS,
  FABLELOOM_HOLD_ROTATION_MODES,
  FABLELOOM_PLAYBACK_MODES,
  FABLELOOM_PLAYBACK_PHASES,
  FABLELOOM_PROTAGONIST_PRESENCE,
  asFableLoomPlaybackMode,
  computeAudioMix,
  createAudioOccupancyManifest,
  inspectEpisodeProductionReadiness,
  inspectNodeProductionReadiness,
  isAssetSafeForLiveVoice,
  isFableLoomPlaybackMode,
  muxAudioTracks,
  resolvePlaybackPhaseAsset,
  resolveFableLoomProtagonistPresence,
  sanitizeAudioInterval,
  sanitizeAudioOccupancy,
  sanitizeInteractionWindow,
  sanitizePlaybackAssets,
  sanitizeVisualConditioning,
  validateAudioOccupancy,
} from './fableLoomPlayback.js';

describe('FableLoom playback modes and vocabulary', () => {
  it('recognizes the persisted vocabulary and defaults old or invalid nodes to decisions', () => {
    expect(FABLELOOM_PLAYBACK_MODES).toEqual(['cut', 'decision']);
    expect(isFableLoomPlaybackMode('cut')).toBe(true);
    expect(isFableLoomPlaybackMode('loop')).toBe(false);
    expect(asFableLoomPlaybackMode('cut')).toBe('cut');
    expect(asFableLoomPlaybackMode(undefined)).toBe('decision');
    expect(asFableLoomPlaybackMode('loop')).toBe('decision');
  });

  it('exposes playback phases, protagonist presence, audio targets, and hold rotation modes', () => {
    expect(FABLELOOM_PLAYBACK_PHASES).toEqual(['entry', 'hold', 'exit', 'ended']);
    expect(FABLELOOM_PROTAGONIST_PRESENCE).toEqual(['offscreen', 'onscreen']);
    expect(FABLELOOM_AUDIO_TARGETS).toEqual(['host', 'audience']);
    expect(FABLELOOM_HOLD_ROTATION_MODES).toEqual(['deterministic', 'shuffle', 'sequential']);
  });

  it('defaults helper connected decisions off-screen while keeping other canonical scenes visible', () => {
    const loom = { participationMode: 'helper', protagonistCharacterId: 'char-elena' };
    expect(resolveFableLoomProtagonistPresence({
      playbackMode: 'decision', audienceConnection: 'connected',
    }, loom)).toBe('offscreen');
    expect(resolveFableLoomProtagonistPresence({
      playbackMode: 'cut', audienceConnection: 'disconnected',
    }, loom)).toBe('onscreen');
    expect(resolveFableLoomProtagonistPresence({
      playbackMode: 'decision', audienceConnection: 'connected', protagonistPresence: 'onscreen',
    }, loom)).toBe('onscreen');
  });
});

describe('FableLoom audio occupancy and validation', () => {
  it('sanitizes audio intervals', () => {
    expect(sanitizeAudioInterval(null)).toBeNull();
    expect(sanitizeAudioInterval({ startMs: 100, endMs: 500, characterId: 'char-1' })).toEqual({
      startMs: 100,
      endMs: 500,
      characterId: 'char-1',
    });
    expect(sanitizeAudioInterval({ startMs: 200, endMs: 100, blocking: true, name: 'gunshot' })).toEqual({
      startMs: 200,
      endMs: 200,
      blocking: true,
      name: 'gunshot',
    });
  });

  it('validates safeForLiveVoice strictly: dialogue prevents live voice', () => {
    const manifestWithDialogue = validateAudioOccupancy({
      durationMs: 8000,
      characterDialogue: [{ startMs: 1000, endMs: 3000, characterId: 'char-1' }],
      music: [{ startMs: 0, endMs: 8000 }],
      safeForLiveVoice: true, // author attempted to mark true
    });
    expect(manifestWithDialogue.safeForLiveVoice).toBe(false);
    expect(isAssetSafeForLiveVoice(manifestWithDialogue)).toBe(false);
  });

  it('validates safeForLiveVoice strictly: author-marked blocking effects prevent live voice', () => {
    const manifestWithBlocking = validateAudioOccupancy({
      durationMs: 6000,
      effects: [{ startMs: 500, endMs: 1500, blocking: true, name: 'explosion' }],
      music: [{ startMs: 0, endMs: 6000 }],
    });
    expect(manifestWithBlocking.safeForLiveVoice).toBe(false);
  });

  it('treats clipped audio as unsafe even when the source marked it safe', () => {
    const clipped = validateAudioOccupancy({
      durationMs: 4000,
      clippingDetected: true,
      peakDb: 1.2,
      safeForLiveVoice: true,
    });

    expect(clipped.clipping).toBe(true);
    expect(clipped.peakDb).toBe(1.2);
    expect(clipped.safeForLiveVoice).toBe(false);
  });

  it('allows live voice when only music / non-blocking ambience is present', () => {
    const safeManifest = validateAudioOccupancy({
      durationMs: 8000,
      music: [{ startMs: 0, endMs: 8000 }],
      effects: [{ startMs: 200, endMs: 400, blocking: false, name: 'wind' }],
    });
    expect(safeManifest.safeForLiveVoice).toBe(true);
    expect(isAssetSafeForLiveVoice(safeManifest)).toBe(true);
  });

  it('muxes audio tracks and calculates total lane durations', () => {
    const muxed = muxAudioTracks({
      durationMs: 10000,
      characterDialogue: [{ startMs: 0, endMs: 3000 }],
      music: [{ startMs: 0, endMs: 10000 }],
      effects: [{ startMs: 1000, endMs: 2000 }],
    });
    expect(muxed.totalDialogueMs).toBe(3000);
    expect(muxed.totalMusicMs).toBe(10000);
    expect(muxed.totalEffectsMs).toBe(1000);
    expect(muxed.safeForLiveVoice).toBe(false);
  });

  it('computes audio ducking levels when live voice is active', () => {
    const manifest = createAudioOccupancyManifest({
      durationMs: 8000,
      music: [{ startMs: 0, endMs: 8000 }],
    });

    const inactiveMix = computeAudioMix({
      assetManifest: manifest,
      liveVoiceActive: false,
      baseDuckDb: -8,
    });
    expect(inactiveMix.duckFactor).toBe(1.0);
    expect(inactiveMix.musicLevel).toBe(1.0);
    expect(inactiveMix.canOpenLiveVoice).toBe(true);

    const activeMix = computeAudioMix({
      assetManifest: manifest,
      liveVoiceActive: true,
      baseDuckDb: -8,
    });
    expect(activeMix.duckDb).toBe(-8);
    expect(activeMix.duckFactor).toBeCloseTo(0.398, 2);
    expect(activeMix.musicLevel).toBeCloseTo(0.398, 2);
    expect(activeMix.canOpenLiveVoice).toBe(true);
  });
});

describe('FableLoom playbackAssets and interactionWindow sanitizers', () => {
  it('sanitizes playbackAssets with safe video IDs and occupancy', () => {
    expect(sanitizePlaybackAssets(null)).toBeNull();
    expect(sanitizePlaybackAssets({})).toBeNull();

    const sanitized = sanitizePlaybackAssets({
      entryVideoHistoryId: 'vid-entry-1',
      holdLoopVideoHistoryIds: ['vid-hold-1', 'vid-hold-2', 'invalid / id!'],
      exitByTransition: {
        'tr-1': 'vid-exit-1',
        'tr-2': 'invalid / id!',
      },
      audioOccupancy: {
        'vid-hold-1': {
          durationMs: 5000,
          music: [{ startMs: 0, endMs: 5000 }],
        },
      },
    });

    expect(sanitized.entryVideoHistoryId).toBe('vid-entry-1');
    expect(sanitized.holdLoopVideoHistoryIds).toEqual(['vid-hold-1', 'vid-hold-2']);
    expect(sanitized.exitByTransition).toEqual({ 'tr-1': 'vid-exit-1' });
    expect(sanitized.audioOccupancy['vid-hold-1'].safeForLiveVoice).toBe(true);
  });

  it('retains one sanitized visual-conditioning manifest per rendered clip', () => {
    const manifest = {
      version: 1,
      compilerVersion: 'visual-v1',
      status: 'locked',
      capability: {
        kind: 'image',
        backend: 'local',
        modelId: 'image-model',
        modelRevision: 'revision-1',
      },
      bindings: { inferred: false, characterAppearances: [] },
      assets: [{ role: 'environment', bindingId: 'place-1', required: true, filename: 'environment.png', path: '/private/input.png' }],
      adapters: [],
      omitted: [],
      warnings: [],
      compiledPrompt: 'A quiet example courtyard.',
      compiledNegativePrompt: '',
      referenceImageStrengths: [1],
      render: {
        provider: 'local',
        modelId: 'image-model',
        modelRevision: 'revision-1',
        parameters: {
          width: 1024,
          initImagePath: '/private/input.png',
          secret: 'must-not-persist',
        },
      },
    };

    expect(sanitizeVisualConditioning(manifest)).toMatchObject({
      version: 1,
      capability: { modelRevision: 'revision-1' },
      compiledNegativePrompt: '',
      render: { parameters: { width: 1024 } },
    });
    expect(JSON.stringify(sanitizeVisualConditioning(manifest))).not.toContain('/private/');
    expect(sanitizeVisualConditioning(manifest).render.parameters.initImagePath).toBeUndefined();
    expect(sanitizeVisualConditioning(manifest).render.parameters.secret).toBeUndefined();

    const sanitized = sanitizePlaybackAssets({
      entryVideoHistoryId: 'vid-entry',
      visualConditioningByAsset: {
        'vid-entry': manifest,
        '../unsafe': manifest,
      },
    });
    expect(sanitized.visualConditioningByAsset).toHaveProperty('vid-entry');
    expect(sanitized.visualConditioningByAsset['vid-entry'])
      .toMatchObject({ capability: { modelRevision: 'revision-1' } });
    expect(sanitized.visualConditioningByAsset).not.toHaveProperty('../unsafe');
  });

  it('sanitizes interactionWindow with defaults and clamped duck dB', () => {
    expect(sanitizeInteractionWindow(null)).toBeNull();

    const sanitized = sanitizeInteractionWindow({
      enabled: true,
      protagonistCharacterId: 'char-elena',
      protagonistPresence: 'offscreen',
      audioTarget: 'host',
      ambientDuckDb: -12,
      holdLoopRotation: 'shuffle',
    });

    expect(sanitized).toEqual({
      enabled: true,
      protagonistCharacterId: 'char-elena',
      protagonistPresence: 'offscreen',
      audioTarget: 'host',
      ambientDuckDb: -12,
      holdLoopRotation: 'shuffle',
    });

    const clamped = sanitizeInteractionWindow({
      enabled: true,
      ambientDuckDb: -100, // beyond min -60
      protagonistPresence: 'invalid',
    });
    expect(clamped.ambientDuckDb).toBe(-60);
    expect(clamped.protagonistPresence).toBe('offscreen');
  });
});

describe('resolvePlaybackPhaseAsset', () => {
  it('resolves legacy node with videoHistoryId seamlessly across phases', () => {
    const legacyNode = {
      id: 'node-legacy',
      videoHistoryId: 'vid-legacy-1',
    };

    const entry = resolvePlaybackPhaseAsset({ node: legacyNode, phase: 'entry' });
    expect(entry.videoHistoryId).toBe('vid-legacy-1');
    expect(entry.phase).toBe('entry');

    const hold = resolvePlaybackPhaseAsset({ node: legacyNode, phase: 'hold' });
    expect(hold.videoHistoryId).toBe('vid-legacy-1');
    expect(hold.phase).toBe('hold');
    expect(hold.safeForLiveVoice).toBe(true);
  });

  it('resolves production playbackAssets for entry, hold rotation, and exit clips', () => {
    const prodNode = {
      id: 'node-prod',
      playbackAssets: {
        entryVideoHistoryId: 'vid-entry',
        holdLoopVideoHistoryIds: ['vid-hold-a', 'vid-hold-b'],
        exitByTransition: {
          'tr-left': 'vid-exit-left',
          'tr-right': 'vid-exit-right',
        },
        audioOccupancy: {
          'vid-hold-a': {
            durationMs: 6000,
            music: [{ startMs: 0, endMs: 6000 }],
          },
          'vid-hold-b': {
            durationMs: 6000,
            characterDialogue: [{ startMs: 1000, endMs: 2000 }],
          },
        },
      },
      interactionWindow: {
        enabled: true,
        holdLoopRotation: 'sequential',
      },
    };

    // Phase 1: Entry
    const entry = resolvePlaybackPhaseAsset({ node: prodNode, phase: 'entry' });
    expect(entry.videoHistoryId).toBe('vid-entry');
    expect(entry.isEntry).toBe(true);

    // Phase 2: Hold rotation (index 0 -> hold-a)
    const hold0 = resolvePlaybackPhaseAsset({ node: prodNode, phase: 'hold', activeHoldIndex: 0 });
    expect(hold0.videoHistoryId).toBe('vid-hold-a');
    expect(hold0.safeForLiveVoice).toBe(true);

    // Phase 2: Hold rotation (index 1 -> hold-b)
    const hold1 = resolvePlaybackPhaseAsset({ node: prodNode, phase: 'hold', activeHoldIndex: 1 });
    expect(hold1.videoHistoryId).toBe('vid-hold-b');
    expect(hold1.safeForLiveVoice).toBe(false); // contains dialogue

    // Phase 3: Exit transition clip
    const exitLeft = resolvePlaybackPhaseAsset({ node: prodNode, phase: 'exit', transitionId: 'tr-left' });
    expect(exitLeft.videoHistoryId).toBe('vid-exit-left');
    expect(exitLeft.isExit).toBe(true);

    // Phase 4: Ended
    const ended = resolvePlaybackPhaseAsset({ node: prodNode, phase: 'ended' });
    expect(ended.videoHistoryId).toBeNull();
  });
});

describe('inspectNodeProductionReadiness & inspectEpisodeProductionReadiness', () => {
  const universe = {
    characters: [{ id: 'char-maya', name: 'Maya' }],
  };

  it('detects unsafe hold asset containing character dialogue', () => {
    const node = {
      id: 'node-1',
      playbackAssets: {
        holdLoopVideoHistoryIds: ['vid-hold-bad'],
        audioOccupancy: {
          'vid-hold-bad': {
            characterDialogue: [{ startMs: 0, endMs: 1000, characterId: 'char-maya' }],
          },
        },
      },
      interactionWindow: {
        enabled: true,
        protagonistCharacterId: 'char-maya',
        protagonistPresence: 'offscreen',
      },
    };

    const res = inspectNodeProductionReadiness(node, { universe });
    expect(res.ready).toBe(false);
    expect(res.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'HOLD_ASSET_HAS_DIALOGUE',
        severity: 'error',
      }),
    ]));
  });

  it('detects missing protagonist character and interaction on ending', () => {
    const node = {
      id: 'node-ending',
      isEnding: true,
      interactionWindow: {
        enabled: true,
        protagonistCharacterId: null,
      },
    };

    const res = inspectNodeProductionReadiness(node, { universe });
    expect(res.ready).toBe(false);
    expect(res.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INTERACTION_ON_ENDING', severity: 'error' }),
      expect.objectContaining({ code: 'MISSING_PROTAGONIST_CHARACTER', severity: 'error' }),
    ]));
  });

  it('validates sound production scene with ready: true', () => {
    const readyNode = {
      id: 'node-sound',
      playbackAssets: {
        entryVideoHistoryId: 'vid-entry',
        holdLoopVideoHistoryIds: ['vid-hold'],
        audioOccupancy: {
          'vid-hold': {
            durationMs: 5000,
            music: [{ startMs: 0, endMs: 5000 }],
          },
        },
      },
      interactionWindow: {
        enabled: true,
        protagonistCharacterId: 'char-maya',
        protagonistPresence: 'offscreen',
      },
    };

    const res = inspectNodeProductionReadiness(readyNode, { universe });
    expect(res.ready).toBe(true);
    expect(res.errorCount).toBe(0);
  });

  it('inspects full episode production readiness', () => {
    const episode = {
      id: 'ep-1',
      nodes: [
        {
          id: 'node-1',
          playbackAssets: {
            holdLoopVideoHistoryIds: ['vid-hold'],
            audioOccupancy: {
              'vid-hold': {
                music: [{ startMs: 0, endMs: 5000 }],
              },
            },
          },
          interactionWindow: {
            enabled: true,
            protagonistCharacterId: 'char-maya',
          },
        },
      ],
    };

    const epRes = inspectEpisodeProductionReadiness(episode, { universe });
    expect(epRes.ready).toBe(true);
    expect(epRes.totalErrors).toBe(0);
    expect(epRes.nodeResults['node-1'].ready).toBe(true);
  });
});
