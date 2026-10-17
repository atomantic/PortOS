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
  describe('graph, wardrobe, anchor, and interaction continuity', () => {
    const graphUniverse = {
      characters: [{
        id: 'char-elena',
        name: 'Elena Vance',
        wardrobes: [{ id: 'wardrobe-explorer' }, { id: 'wardrobe-gala' }],
      }],
      places: [{ id: 'place-temple', name: 'Sunken Temple' }],
      objects: [],
    };
    const edge = (id, targetNodeId) => ({ id, targetNodeId, intent: 'Go' });

    it('flags unreachable scenes and ambiguous convergence by explicit-source validity', () => {
      const build = (continuitySourceNodeId) => analyzeEpisodeContinuity({
        episode: {
          id: 'ep-1',
          startNodeId: 'a',
          nodes: [
            { id: 'a', title: 'A', transitions: [edge('t1', 'b'), edge('t2', 'c')] },
            { id: 'b', title: 'B', transitions: [edge('t3', 'd')] },
            { id: 'c', title: 'C', transitions: [edge('t4', 'd')] },
            { id: 'd', title: 'D', visualCanon: { continuitySourceNodeId }, transitions: [] },
            { id: 'orphan', title: 'Orphan', transitions: [] },
          ],
        },
        universe: graphUniverse,
      });

      const missing = build(undefined);
      expect(missing.findings.map((f) => [f.code, f.severity, f.nodeId])).toEqual([
        [CONTINUITY_CODES.UNREACHABLE_SCENE_CONTINUITY, 'warning', 'orphan'],
        [CONTINUITY_CODES.AMBIGUOUS_CONVERGENCE, 'info', 'd'],
      ]);
      expect(missing.passed).toBe(true);

      const invalid = build('orphan');
      const ambiguous = invalid.findings.find((f) => f.code === CONTINUITY_CODES.AMBIGUOUS_CONVERGENCE);
      expect(ambiguous.severity).toBe('error');
      expect(ambiguous.message).toContain('is not one of its 2 incoming paths');
      expect(invalid.passed).toBe(false);

      expect(build('b').findings.map((f) => f.code))
        .not.toContain(CONTINUITY_CODES.AMBIGUOUS_CONVERGENCE);
    });

    it('reports canonical protagonist resolution and identity-pack readiness', () => {
      const episode = { id: 'ep-1', startNodeId: 'a', nodes: [{ id: 'a', title: 'A', transitions: [] }] };
      const codesFor = (loom, universe) => analyzeEpisodeContinuity({ loom, episode, universe })
        .findings.map((f) => f.code);

      expect(codesFor({ protagonistCharacterId: 'char-elena' }, null))
        .toEqual([CONTINUITY_CODES.CANONICAL_PROTAGONIST_UNRESOLVED]);
      expect(codesFor({ protagonistCharacterId: 'char-nobody' }, graphUniverse))
        .toEqual([CONTINUITY_CODES.CANONICAL_PROTAGONIST_UNRESOLVED]);
      expect(codesFor(
        { protagonistCharacterId: 'char-elena', protagonistWardrobeId: 'wardrobe-missing' },
        graphUniverse,
      )).toEqual([
        CONTINUITY_CODES.CANONICAL_WARDROBE_UNRESOLVED,
        CONTINUITY_CODES.CANONICAL_IDENTITY_PACK_NOT_READY,
      ]);
    });

    it('keeps finding order, ids, and category counts stable across domains', () => {
      const review = analyzeEpisodeContinuity({
        loom: { participationMode: 'helper', protagonistCharacterId: 'char-elena' },
        localVoiceProfiles: [{
          id: 'vp-elena', version: 3, engine: 'piper', modelRevision: 'model-z',
          binding: { characterId: 'char-other' },
        }],
        universe: graphUniverse,
        episode: {
          id: 'ep-1',
          startNodeId: 'a',
          nodes: [
            {
              id: 'a',
              title: 'Temple gate',
              prose: 'They reach the Sunken Temple.',
              visualCanon: {
                characterAppearances: [{ characterId: 'char-elena', wardrobeId: 'wardrobe-explorer' }],
              },
              playbackAssets: {
                provenance: { characters: [{
                  characterId: 'char-elena',
                  voice: { profileId: 'vp-elena', profileVersion: 1, engine: 'kokoro', modelRevision: 'model-a' },
                }] },
              },
              transitions: [edge('t1', 'b')],
            },
            {
              id: 'b',
              title: 'Temple depths',
              isEnding: true,
              audienceConnection: 'disconnected',
              interactionWindow: { enabled: true, protagonistCharacterId: 'char-elena' },
              visualCanon: {
                characterAppearances: [{ characterId: 'char-elena', wardrobeId: 'wardrobe-gala' }],
              },
              playbackAssets: {
                provenance: { characters: [{
                  characterId: 'char-elena',
                  voice: { profileId: 'vp-elena', profileVersion: 2, engine: 'piper', modelRevision: 'model-b' },
                }] },
              },
              transitions: [],
            },
          ],
        },
      });

      expect(review.findings.map((f) => [f.id, f.category, f.severity, f.code, f.nodeId ?? null])).toEqual([
        ['finding-1', 'visual', 'warning', 'CANONICAL_IDENTITY_PACK_NOT_READY', null],
        ['finding-2', 'voice', 'error', 'VOICE_PROFILE_BINDING_MISMATCH', 'a'],
        ['finding-3', 'voice', 'warning', 'VOICE_PROFILE_REVISION_DRIFT', 'a'],
        ['finding-4', 'voice', 'warning', 'VOICE_ENGINE_DRIFT', 'a'],
        ['finding-5', 'voice', 'warning', 'VOICE_MODEL_REVISION_DRIFT', 'a'],
        ['finding-6', 'voice', 'info', 'MISSING_PRONUNCIATION_ANCHOR', 'a'],
        ['finding-7', 'visual', 'info', 'WARDROBE_DRIFT', 'b'],
        ['finding-8', 'voice', 'error', 'VOICE_PROFILE_BINDING_MISMATCH', 'b'],
        ['finding-9', 'voice', 'warning', 'VOICE_PROFILE_REVISION_DRIFT', 'b'],
        ['finding-10', 'voice', 'warning', 'VOICE_MODEL_REVISION_DRIFT', 'b'],
        ['finding-11', 'voice', 'warning', 'NO_APPROVED_VOICE_PROFILE', 'b'],
        ['finding-12', 'playback', 'error', 'INTERACTION_ON_ENDING_OR_CUT', 'b'],
        ['finding-13', 'playback', 'error', 'DISCONNECTED_INTERACTION_CHANNEL', 'b'],
        ['finding-14', 'voice', 'warning', 'VOICE_PROFILE_REVISION_DRIFT', null],
        ['finding-15', 'voice', 'warning', 'VOICE_ENGINE_DRIFT', null],
        ['finding-16', 'voice', 'warning', 'VOICE_MODEL_REVISION_DRIFT', null],
      ]);
      expect(review.summary).toEqual({
        totalFindings: 16, errors: 4, warnings: 10, info: 2,
        categoryCounts: { visual: 2, voice: 12, playback: 2, graph: 0 },
      });
      const episodeDrift = review.findings.slice(-3);
      expect(episodeDrift.map((f) => f.message)).toEqual([
        'Character "char-elena" has assets rendered with different voice profile revisions across scenes (vp-elena@v1 (kokoro:model-a), vp-elena@v2 (piper:model-b)).',
        'Character "char-elena" has assets rendered with different voice engines across scenes (kokoro, piper).',
        'Character "char-elena" has assets rendered with different voice model revisions across scenes (model-a, model-b).',
      ]);
    });
  });
});
