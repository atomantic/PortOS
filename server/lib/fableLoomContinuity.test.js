import { describe, expect, it } from 'vitest';
import {
  CONTINUITY_CODES,
  analyzeEpisodeContinuity,
} from './fableLoomContinuity.js';

describe('fableLoomContinuity', () => {
  const sampleUniverse = {
    characters: [
      {
        id: 'char-elena',
        name: 'Elena Vance',
        wardrobes: [{ id: 'wardrobe-explorer' }, { id: 'wardrobe-gala' }],
        voiceCanon: {
          pronunciations: [{ term: 'Aethelgard', pronunciation: 'AY-thel-gard' }],
        },
      },
    ],
    places: [{ id: 'place-temple', name: 'Sunken Temple' }],
    objects: [{ id: 'obj-relic', name: 'Solar Relic' }],
  };

  it('detects visual binding errors and missing references', () => {
    const episode = {
      id: 'ep-1',
      startNodeId: 'node-1',
      nodes: [
        {
          id: 'node-1',
          title: 'Temple Entrance',
          prose: 'Elena enters the Sunken Temple.',
          visualCanon: {
            characterAppearances: [
              { characterId: 'char-ghost', wardrobeId: 'unknown-wardrobe' },
              { characterId: 'char-elena', wardrobeId: 'non-existent-wardrobe' },
            ],
            placeId: 'unknown-place',
            objectIds: ['unknown-obj'],
          },
          transitions: [],
        },
      ],
    };

    const review = analyzeEpisodeContinuity({
      episode,
      universe: sampleUniverse,
    });

    expect(review.passed).toBe(false);
    const codes = review.findings.map((f) => f.code);
    expect(codes).toContain(CONTINUITY_CODES.MISSING_UNIVERSE_CHARACTER);
    expect(codes).toContain(CONTINUITY_CODES.MISSING_WARDROBE_REFERENCE);
    expect(codes).toContain(CONTINUITY_CODES.MISSING_UNIVERSE_PLACE);
    expect(codes).toContain(CONTINUITY_CODES.MISSING_UNIVERSE_OBJECT);
  });

  it('detects voice profile revision drift across scenes in the same episode', () => {
    const episode = {
      id: 'ep-1',
      startNodeId: 'node-1',
      nodes: [
        {
          id: 'node-1',
          title: 'Scene 1',
          prose: 'Hello world.',
          playbackAssets: {
            provenance: {
              characters: [
                {
                  characterId: 'char-elena',
                  voice: { profileId: 'vp-elena', profileVersion: 1, engine: 'kokoro' },
                },
              ],
            },
          },
          transitions: [{ id: 'tr-1', targetNodeId: 'node-2', intent: 'Next' }],
        },
        {
          id: 'node-2',
          title: 'Scene 2',
          prose: 'Good morning.',
          playbackAssets: {
            provenance: {
              characters: [
                {
                  characterId: 'char-elena',
                  voice: { profileId: 'vp-elena', profileVersion: 2, engine: 'kokoro' },
                },
              ],
            },
          },
          transitions: [],
        },
      ],
    };

    const review = analyzeEpisodeContinuity({
      episode,
      universe: sampleUniverse,
    });

    const driftFinding = review.findings.find(
      (f) => f.code === CONTINUITY_CODES.VOICE_PROFILE_REVISION_DRIFT,
    );
    expect(driftFinding).toBeDefined();
    expect(driftFinding.characterId).toBe('char-elena');
    expect(driftFinding.severity).toBe('warning');
  });

  it('detects unsafe hold loop audio occupancy and interaction misconfigurations', () => {
    const episode = {
      id: 'ep-1',
      startNodeId: 'node-1',
      nodes: [
        {
          id: 'node-1',
          title: 'Dangerous Hold Scene',
          prose: 'Conversation awaits.',
          playbackMode: 'decision',
          interactionWindow: {
            enabled: true,
            protagonistCharacterId: 'char-elena',
            protagonistPresence: 'onscreen',
          },
          playbackAssets: {
            holdLoopVideoHistoryIds: ['video-unsafe-hold'],
            audioOccupancy: {
              'video-unsafe-hold': {
                durationMs: 5000,
                characterDialogue: [{ startMs: 0, endMs: 2000, speaker: 'Elena' }],
                music: [],
                effects: [{ startMs: 3000, endMs: 4000, blocking: true }],
              },
            },
          },
          transitions: [],
        },
      ],
    };

    const review = analyzeEpisodeContinuity({
      episode,
      universe: sampleUniverse,
    });

    const codes = review.findings.map((f) => f.code);
    expect(codes).toContain(CONTINUITY_CODES.HOLD_LOOP_HAS_DIALOGUE);
    expect(codes).toContain(CONTINUITY_CODES.HOLD_LOOP_HAS_BLOCKING_EFFECTS);
    expect(codes).toContain(CONTINUITY_CODES.PROTAGONIST_ONSCREEN_INTERACTION);
  });

  it('detects clipped hold audio and voice engine, model, and pronunciation drift', () => {
    const episode = {
      id: 'ep-1',
      startNodeId: 'node-1',
      nodes: [
        {
          id: 'node-1',
          title: 'First scene',
          prose: 'The hero speaks.',
          playbackAssets: {
            holdLoopVideoHistoryIds: ['hold-1'],
            audioOccupancy: { 'hold-1': { durationMs: 2000, clippingDetected: true } },
            provenance: {
              characters: [{
                characterId: 'char-elena',
                voice: {
                  profileId: 'vp-elena', profileVersion: 1, engine: 'kokoro',
                  modelRevision: 'model-a', pronunciationRevision: 1,
                },
              }],
            },
          },
          transitions: [{ id: 'tr-1', targetNodeId: 'node-2', intent: 'Next' }],
        },
        {
          id: 'node-2',
          title: 'Second scene',
          prose: 'The hero answers.',
          playbackAssets: {
            provenance: {
              characters: [{
                characterId: 'char-elena',
                voice: {
                  profileId: 'vp-elena', profileVersion: 1, engine: 'piper',
                  modelRevision: 'model-b', pronunciationRevision: 2,
                },
              }],
            },
          },
          transitions: [],
        },
      ],
    };

    const review = analyzeEpisodeContinuity({ episode, universe: {
      characters: [{ ...sampleUniverse.characters[0], voiceCanon: { version: 3 } }],
    } });
    const codes = review.findings.map((finding) => finding.code);

    expect(codes).toContain(CONTINUITY_CODES.HOLD_LOOP_HAS_CLIPPING);
    expect(codes).toContain(CONTINUITY_CODES.VOICE_ENGINE_DRIFT);
    expect(codes).toContain(CONTINUITY_CODES.VOICE_MODEL_REVISION_DRIFT);
    expect(codes).toContain(CONTINUITY_CODES.PRONUNCIATION_REVISION_DRIFT);
  });

  it('checks canonical protagonist wardrobe and off-screen visual bindings', () => {
    const review = analyzeEpisodeContinuity({
      loom: {
        participationMode: 'helper',
        protagonistCharacterId: 'char-elena',
        protagonistWardrobeId: 'wardrobe-explorer',
        protagonistWardrobeLocked: true,
      },
      episode: {
        id: 'ep-1',
        startNodeId: 'node-1',
        nodes: [
          {
            id: 'node-1',
            title: 'Visible approach',
            protagonistPresence: 'onscreen',
            visualCanon: {
              mode: 'locked',
              characterAppearances: [{ characterId: 'char-elena', wardrobeId: 'wardrobe-gala' }],
            },
            transitions: [{ id: 'tr-1', targetNodeId: 'node-2', intent: 'Talk' }],
          },
          {
            id: 'node-2',
            title: 'Communicator decision',
            playbackMode: 'decision',
            audienceConnection: 'connected',
            protagonistPresence: 'offscreen',
            visualCanon: {
              mode: 'locked',
              characterAppearances: [{ characterId: 'char-elena', wardrobeId: 'wardrobe-explorer' }],
            },
            transitions: [],
          },
        ],
      },
      universe: sampleUniverse,
    });

    const codes = review.findings.map((finding) => finding.code);
    expect(codes).toContain(CONTINUITY_CODES.CANONICAL_WARDROBE_DRIFT);
    expect(codes).toContain(CONTINUITY_CODES.PROTAGONIST_VISUAL_BINDING_WHILE_OFFSCREEN);
  });

  it('flags live interaction that binds a different protagonist than the loom canon', () => {
    const review = analyzeEpisodeContinuity({
      loom: {
        participationMode: 'helper',
        protagonistCharacterId: 'char-elena',
      },
      episode: {
        id: 'ep-1',
        startNodeId: 'node-1',
        nodes: [{
          id: 'node-1',
          title: 'Wrong communicator binding',
          playbackMode: 'decision',
          audienceConnection: 'connected',
          interactionWindow: {
            enabled: true,
            protagonistCharacterId: 'char-other',
            protagonistPresence: 'offscreen',
          },
          transitions: [],
        }],
      },
      universe: sampleUniverse,
    });

    expect(review.findings.map((finding) => finding.code))
      .toContain(CONTINUITY_CODES.PROTAGONIST_BINDING_MISMATCH);
  });
});
