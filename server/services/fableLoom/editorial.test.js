import { describe, expect, it, vi } from 'vitest';

import { analyzeLoomPlaythroughs } from '../../lib/fableLoomPlaytest.js';
import {
  applyFableLoomEditorialPatch,
  collectFableLoomEditorialDiagnostics,
  __testing,
} from './editorial.js';
import { sanitizeLoom } from './records.js';

const transition = (id, targetNodeId, intent) => ({ id, targetNodeId, intent, triggers: [] });

const makeLoom = () => sanitizeLoom({
  id: 'loom-example',
  name: 'Example Story',
  participationMode: 'protagonist',
  seriesPlan: { storyArc: 'A traveler follows a divided signal.', plotPoints: [], sideQuests: [] },
  episodes: [{
    id: 'episode-example',
    number: 1,
    title: 'The Divided Signal',
    synopsis: 'Two routes reveal one source.',
    startNodeId: 'opening',
    nodes: [
      {
        id: 'opening', title: 'The Split', prose: 'The signal forks.',
        playbackMode: 'decision', audienceConnection: 'connected', isEnding: false,
        transitions: [
          transition('take-left', 'left', 'Take the glass bridge'),
          transition('take-right', 'right', 'Follow the buried wire'),
        ],
      },
      {
        id: 'left', title: 'Glass Bridge', prose: 'The bridge remembers every footstep.',
        playbackMode: 'cut', audienceConnection: 'disconnected', isEnding: false,
        transitions: [transition('left-end', 'ending', 'Reach the beacon')],
      },
      {
        id: 'right', title: 'Buried Wire', prose: 'The wire hums below the frost.',
        playbackMode: 'cut', audienceConnection: 'disconnected', isEnding: false,
        transitions: [transition('right-end', 'ending', 'Reach the beacon')],
      },
      {
        id: 'ending', title: 'The Beacon', prose: 'Both routes reveal the same call.',
        playbackMode: 'decision', audienceConnection: 'connected', isEnding: true,
        endingLabel: 'Signal found', transitions: [],
      },
    ],
  }],
});

const makeHighVariationLoom = () => {
  const depth = 7;
  const nodes = [];
  for (let level = 0; level < depth; level += 1) {
    const decisionId = `decision-${level + 1}`;
    const nextDecisionId = `decision-${level + 2}`;
    const leftId = level === depth - 1 ? 'ending-left' : `branch-${level + 1}-left`;
    const rightId = level === depth - 1 ? 'ending-right' : `branch-${level + 1}-right`;
    nodes.push({
      id: decisionId,
      title: `Decision ${level + 1}`,
      prose: `The traveler weighs signal fork ${level + 1}.`,
      playbackMode: 'decision',
      audienceConnection: 'connected',
      isEnding: false,
      transitions: [
        transition(`decision-${level + 1}-left`, leftId, 'Follow the left signal'),
        transition(`decision-${level + 1}-right`, rightId, 'Follow the right signal'),
      ],
    });
    if (level < depth - 1) {
      nodes.push(
        {
          id: leftId,
          title: `Left Passage ${level + 1}`,
          prose: 'The left passage reveals one piece of the signal.',
          playbackMode: 'cut',
          audienceConnection: 'disconnected',
          isEnding: false,
          transitions: [transition(`${leftId}-next`, nextDecisionId, 'Continue toward the source')],
        },
        {
          id: rightId,
          title: `Right Passage ${level + 1}`,
          prose: 'The right passage reveals another piece of the signal.',
          playbackMode: 'cut',
          audienceConnection: 'disconnected',
          isEnding: false,
          transitions: [transition(`${rightId}-next`, nextDecisionId, 'Continue toward the source')],
        },
      );
    }
  }
  nodes.push(
    {
      id: 'ending-left', title: 'Left Answer', prose: 'The left answer resolves the signal.',
      playbackMode: 'decision', audienceConnection: 'connected', isEnding: true,
      endingLabel: 'Left answer', transitions: [],
    },
    {
      id: 'ending-right', title: 'Right Answer', prose: 'The right answer resolves the signal.',
      playbackMode: 'decision', audienceConnection: 'connected', isEnding: true,
      endingLabel: 'Right answer', transitions: [],
    },
  );
  return sanitizeLoom({
    id: 'loom-many-variations',
    name: 'Example Many-Path Story',
    participationMode: 'protagonist',
    seriesPlan: { storyArc: 'A traveler follows a layered signal.', plotPoints: [], sideQuests: [] },
    episodes: [{
      id: 'episode-many-variations',
      number: 1,
      title: 'The Layered Signal',
      synopsis: 'Seven choices reveal one source.',
      startNodeId: 'decision-1',
      nodes,
    }],
  });
};

const completeOutline = () => ({
  startKey: 'opening',
  scenes: [
    {
      key: 'opening', title: 'The Split', summary: 'The traveler must choose how to follow the signal.',
      playbackMode: 'decision', audienceConnection: 'connected', protagonistPresence: 'onscreen',
      transitions: [
        { targetKey: 'left', intent: 'Take the glass bridge' },
        { targetKey: 'right', intent: 'Follow the buried wire' },
      ],
    },
    {
      key: 'left', title: 'Glass Bridge', summary: 'The exposed route tests the traveler’s nerve.',
      playbackMode: 'cut', audienceConnection: 'disconnected', protagonistPresence: 'onscreen',
      transitions: [{ targetKey: 'ending', intent: 'Reach the beacon' }],
    },
    {
      key: 'right', title: 'Buried Wire', summary: 'The hidden route reveals who buried the signal.',
      playbackMode: 'cut', audienceConnection: 'disconnected', protagonistPresence: 'onscreen',
      transitions: [{ targetKey: 'ending', intent: 'Reach the beacon' }],
    },
    {
      key: 'ending', title: 'The Beacon', summary: 'The beacon answers with a costly invitation.',
      playbackMode: 'decision', audienceConnection: 'connected', protagonistPresence: 'onscreen',
      isEnding: true, endingLabel: 'Signal found', transitions: [],
    },
  ],
});

describe('editorial prompt graph contract', () => {
  it('gives the editor exact transition, source, and target ids for safe patches', () => {
    const digest = __testing.teleplayDigest(makeLoom());

    expect(digest).toContain('Exact graph ids for patches (copy verbatim):');
    expect(digest).toContain('transition=take-left sourceNode=opening targetNode=left');
    expect(digest).toContain('transition=right-end sourceNode=right targetNode=ending');
  });
});

describe('applyFableLoomEditorialPatch', () => {
  it('repairs a missing outline and selects a valid convergence source without changing membership', () => {
    const loom = makeLoom();
    const originalNodeIds = loom.episodes[0].nodes.map((node) => node.id);
    const originalTransitionIds = loom.episodes[0].nodes.flatMap((node) => (
      node.transitions.map((item) => item.id)
    ));

    const result = applyFableLoomEditorialPatch(loom, {
      episodes: [{
        id: 'episode-example',
        storyOutline: completeOutline(),
        scenes: [{ id: 'ending', visualCanon: { continuitySourceNodeId: 'left' } }],
      }],
    });

    expect(result.changed).toBe(true);
    expect(result.before.outlineErrors).toBeGreaterThan(0);
    expect(result.after.outlineErrors).toBe(0);
    expect(result.loom.episodes[0].storyOutline.validation.status).toBe('valid');
    expect(result.loom.episodes[0].nodes.find((node) => node.id === 'ending')
      .visualCanon.continuitySourceNodeId).toBe('left');
    expect(result.loom.episodes[0].nodes.map((node) => node.id)).toEqual(originalNodeIds);
    expect(result.loom.episodes[0].nodes.flatMap((node) => node.transitions.map((item) => item.id)))
      .toEqual(originalTransitionIds);
  });

  it('validates continuity sources against transition rewires in the same patch', () => {
    const result = applyFableLoomEditorialPatch(makeLoom(), {
      episodes: [{
        id: 'episode-example',
        scenes: [
          { id: 'left', transitions: [{ id: 'left-end', targetNodeId: 'right' }] },
          { id: 'right', visualCanon: { continuitySourceNodeId: 'left' } },
          { id: 'ending', visualCanon: { continuitySourceNodeId: 'right' } },
        ],
      }],
    });

    expect(result.loom.episodes[0].nodes.find((node) => node.id === 'left')
      .transitions[0].targetNodeId).toBe('right');
    expect(result.loom.episodes[0].nodes.find((node) => node.id === 'ending')
      .visualCanon.continuitySourceNodeId).toBe('right');
    expect(result.loom.episodes[0].nodes.find((node) => node.id === 'right')
      .visualCanon.continuitySourceNodeId).toBe('left');
  });

  it('rejects a continuity source that is not a direct incoming predecessor', () => {
    expect(() => applyFableLoomEditorialPatch(makeLoom(), {
      episodes: [{
        id: 'episode-example',
        scenes: [{ id: 'ending', visualCanon: { continuitySourceNodeId: 'opening' } }],
      }],
    })).toThrow(/invalid continuity predecessor/i);
  });

  it('rejects a patch that introduces a new deterministic graph error', () => {
    expect(() => applyFableLoomEditorialPatch(makeLoom(), {
      episodes: [{
        id: 'episode-example',
        scenes: [{ id: 'opening', playbackMode: 'cut' }],
      }],
    })).toThrow(/introduced new episode graph errors/i);
  });

  it('rejects a new graph error even when the patch fixes a different error', () => {
    const loom = makeLoom();
    loom.episodes[0].nodes[0].playbackMode = 'cut';

    expect(() => applyFableLoomEditorialPatch(loom, {
      episodes: [{
        id: 'episode-example',
        scenes: [{
          id: 'opening',
          playbackMode: 'decision',
          transitions: [{ id: 'take-left', intent: '' }],
        }],
      }],
    })).toThrow(/introduced new episode graph errors/i);
  });

  it('rejects a transition rewire that introduces a non-terminating playthrough', () => {
    expect(() => applyFableLoomEditorialPatch(makeLoom(), {
      episodes: [{
        id: 'episode-example',
        scenes: [{
          id: 'left',
          transitions: [{ id: 'left-end', targetNodeId: 'left' }],
        }],
      }],
    })).toThrow(/introduced new playthrough failures/i);
  });

  it('rejects a patch that breaks an additional route with an existing cycle identity', () => {
    const loom = sanitizeLoom({
      id: 'loom-existing-cycle',
      name: 'Example Cycle Story',
      participationMode: 'protagonist',
      episodes: [{
        id: 'episode-existing-cycle',
        number: 1,
        title: 'The Repeating Signal',
        startNodeId: 'opening',
        nodes: [
          {
            id: 'opening', title: 'Four Routes', playbackMode: 'decision',
            audienceConnection: 'connected', protagonistPresence: 'onscreen',
            transitions: [
              transition('already-cycles', 'cycle-c', 'Enter the loop'),
              transition('ending-route-one', 'ending-one', 'Take the first answer'),
              transition('ending-route-two', 'ending-one', 'Take the second answer'),
              transition('ending-route-three', 'ending-two', 'Take the third answer'),
            ],
          },
          {
            id: 'cycle-c', title: 'Cycle C', playbackMode: 'cut',
            audienceConnection: 'disconnected', protagonistPresence: 'onscreen',
            transitions: [transition('cycle-c-to-d', 'cycle-d', 'Continue')],
          },
          {
            id: 'cycle-d', title: 'Cycle D', playbackMode: 'cut',
            audienceConnection: 'disconnected', protagonistPresence: 'onscreen',
            transitions: [transition('cycle-d-to-c', 'cycle-c', 'Repeat')],
          },
          {
            id: 'ending-one', title: 'First Answer', playbackMode: 'decision',
            audienceConnection: 'connected', protagonistPresence: 'onscreen',
            isEnding: true, endingLabel: 'First answer', transitions: [],
          },
          {
            id: 'ending-two', title: 'Second Answer', playbackMode: 'decision',
            audienceConnection: 'connected', protagonistPresence: 'onscreen',
            isEnding: true, endingLabel: 'Second answer', transitions: [],
          },
        ],
      }],
    });
    expect(analyzeLoomPlaythroughs(loom).stats.nonEndingVariationCount).toBe(1);

    expect(() => applyFableLoomEditorialPatch(loom, {
      episodes: [{
        id: 'episode-existing-cycle',
        scenes: [{
          id: 'opening',
          transitions: [{ id: 'ending-route-one', targetNodeId: 'cycle-c' }],
        }],
      }],
    })).toThrow(/introduced new playthrough failures/i);
  });

  it('rejects a patch that introduces a blocking continuity defect', () => {
    const loom = makeLoom();
    const scene = loom.episodes[0].nodes.find((node) => node.id === 'left');
    scene.playbackMode = 'decision';
    scene.protagonistPresence = 'offscreen';
    scene.interactionWindow = { enabled: true };

    expect(() => applyFableLoomEditorialPatch(loom, {
      episodes: [{
        id: 'episode-example',
        scenes: [{ id: 'left', playbackMode: 'cut' }],
      }],
    })).toThrow(/introduced new continuity blockers/i);
  });

  it('requires a replacement outline to cover the expanded teleplay exactly', () => {
    const subsetOutline = {
      version: 1,
      startKey: 'opening',
      scenes: [
        {
          key: 'opening', title: 'Opening', summary: 'The route begins.', playbackMode: 'cut',
          audienceConnection: 'connected', protagonistPresence: 'onscreen', isEnding: false,
          transitions: [{ targetKey: 'ending', intent: 'Continue' }],
        },
        {
          key: 'ending', title: 'Ending', summary: 'The route resolves.', playbackMode: 'decision',
          audienceConnection: 'connected', protagonistPresence: 'onscreen', isEnding: true,
          endingLabel: 'Signal found', transitions: [],
        },
      ],
    };

    expect(() => applyFableLoomEditorialPatch(makeLoom(), {
      episodes: [{ id: 'episode-example', storyOutline: subsetOutline }],
    })).toThrow(/cover every expanded teleplay scene exactly once/i);
  });

  it('rejects outline-relevant edits without a synchronized validated outline', () => {
    const loom = makeLoom();
    loom.episodes[0].storyOutline = {
      ...completeOutline(),
      validation: { status: 'valid', issues: [] },
    };

    expect(() => applyFableLoomEditorialPatch(loom, {
      episodes: [{ id: 'episode-example', synopsis: 'A different dramatic contract.' }],
    })).toThrow(/without returning a synchronized storyOutline/i);

    expect(() => applyFableLoomEditorialPatch(loom, {
      episodes: [{
        id: 'episode-example',
        scenes: [{ id: 'opening', transitions: [{ id: 'take-left', intent: 'Flee left' }] }],
      }],
    })).toThrow(/without returning a synchronized storyOutline/i);
  });

  it('requires explicit intent before clearing populated series-plan collections', () => {
    const loom = makeLoom();
    loom.seriesPlan.sideQuests = [{
      id: 'quest-example', title: 'Recover the map', description: 'Find the missing map.',
      status: 'planned', startEpisodeId: 'episode-example', endEpisodeId: 'episode-example',
    }];

    expect(() => applyFableLoomEditorialPatch(loom, {
      seriesPlan: { sideQuests: [] },
    })).toThrow(/without listing it in clears/i);

    expect(applyFableLoomEditorialPatch(loom, {
      clears: ['seriesPlan.sideQuests'],
      seriesPlan: { sideQuests: [] },
    }).loom.seriesPlan.sideQuests).toEqual([]);
  });

  it('rejects malformed series-plan field types before sanitization can erase data', () => {
    const loom = makeLoom();
    loom.seriesPlan = {
      ...loom.seriesPlan,
      plotPoints: [{ id: 'plot-example', title: 'Signal', description: 'Follow it.' }],
      sideQuests: [{
        id: 'quest-example', title: 'Map', description: 'Recover it.', status: 'planned',
        startEpisodeId: 'episode-example', endEpisodeId: 'episode-example',
      }],
      deliveryOptions: { nextSeasonTeaser: false },
      interEpisodeVoicemails: [{
        id: 'message-example', fromEpisodeId: 'episode-example', toEpisodeId: 'episode-example',
        title: 'Message', transcript: 'Return.',
      }],
      nextSeasonTeaser: { title: 'Beyond', transcript: 'The signal answers.' },
    };

    for (const seriesPlan of [
      { plotPoints: null },
      { sideQuests: {} },
      { deliveryOptions: [] },
      { interEpisodeVoicemails: 'none' },
      { nextSeasonTeaser: [] },
      { plotPoints: [null] },
      { plotPoints: [{ id: null, title: 'Signal', description: 'Follow it.' }] },
      { sideQuests: [{ title: 'Missing fields' }] },
      { deliveryOptions: { ignoredBySanitizer: true } },
      { interEpisodeVoicemails: [{}] },
      { nextSeasonTeaser: {} },
    ]) {
      expect(() => applyFableLoomEditorialPatch(loom, { seriesPlan }))
        .toThrow(/invalid value for seriesPlan/i);
    }
    expect(() => applyFableLoomEditorialPatch(loom, {
      seriesPlan: { nextSeasonTeaser: null },
    })).toThrow(/without listing it in clears/i);
    expect(applyFableLoomEditorialPatch(loom, {
      clears: ['seriesPlan.nextSeasonTeaser'],
      seriesPlan: { nextSeasonTeaser: null },
    }).loom.seriesPlan.nextSeasonTeaser).toBeNull();
    expect(() => applyFableLoomEditorialPatch(loom, {
      seriesPlan: { nextSeasonTeaser: { title: '', transcript: '' } },
    })).toThrow(/without listing it in clears/i);
    expect(applyFableLoomEditorialPatch(loom, {
      clears: ['seriesPlan.nextSeasonTeaser'],
      seriesPlan: { nextSeasonTeaser: { title: '', transcript: '' } },
    }).loom.seriesPlan.nextSeasonTeaser).toEqual({ title: '', transcript: '' });
  });

  it('rejects invented episode references instead of silently unlinking plan items', () => {
    const invalidRef = 'episode-not-in-this-loom';
    for (const seriesPlan of [
      { plotPoints: [{ title: 'Signal', description: 'Follow it.', episodeId: invalidRef }] },
      {
        sideQuests: [{
          title: 'Map', description: 'Recover it.', status: 'planned',
          startEpisodeId: invalidRef, endEpisodeId: null,
        }],
      },
      {
        interEpisodeVoicemails: [{
          fromEpisodeId: 'episode-example', toEpisodeId: invalidRef,
          title: 'Message', transcript: 'Return.',
        }],
      },
    ]) {
      expect(() => applyFableLoomEditorialPatch(makeLoom(), { seriesPlan }))
        .toThrow(/invalid value for seriesPlan/i);
    }
  });

  it('merges sparse delivery-option edits without clearing an omitted flag', () => {
    const loom = makeLoom();
    loom.seriesPlan.deliveryOptions = {
      overnightVoicemails: true,
      nextSeasonTeaser: false,
    };

    const updated = applyFableLoomEditorialPatch(loom, {
      seriesPlan: {
        deliveryOptions: { nextSeasonTeaser: true },
        nextSeasonTeaser: { title: 'Beyond', transcript: 'The signal answers.' },
      },
    }).loom;

    expect(updated.seriesPlan.deliveryOptions).toEqual({
      overnightVoicemails: true,
      nextSeasonTeaser: true,
    });
  });

  it('rejects any edit while a claimed-valid expanded outline is already stale', () => {
    const loom = makeLoom();
    loom.episodes[0].storyOutline = {
      ...completeOutline(),
      scenes: completeOutline().scenes.slice(0, 2),
      validation: { status: 'valid', issues: [] },
    };

    expect(() => applyFableLoomEditorialPatch(loom, {
      seriesPlan: { storyArc: 'A revised arc.' },
    })).toThrow(/stale validated outline/i);
  });

  it('rejects instructional exemplar text copied into story fields', () => {
    expect(() => applyFableLoomEditorialPatch(makeLoom(), {
      seriesPlan: { storyArc: 'complete replacement only when changed' },
    })).toThrow(/instructional placeholder/i);
    expect(() => applyFableLoomEditorialPatch(makeLoom(), {
      summary: 'concise whole-series editorial assessment',
      strengths: ['specific strength worth preserving'],
      findings: [],
      changes: ["Sharpened one scene's sensory detail without changing its beat."],
      episodes: [{
        id: 'EPISODE_ID_FROM_INPUT',
        scenes: [{
          id: 'SCENE_ID_FROM_INPUT',
          prose: 'The signal shivers through the flooded tunnel walls.',
        }],
      }],
    })).toThrow(/instructional placeholder/i);
  });

  it('rejects unknown or duplicate graph ids instead of silently ignoring patches', () => {
    for (const content of [
      { episodes: [{ id: 'episode-unknown' }] },
      { episodes: [{ id: 'episode-example' }, { id: 'episode-example' }] },
      { episodes: [{ id: 'episode-example', scenes: [{ id: 'scene-unknown' }] }] },
      {
        episodes: [{
          id: 'episode-example',
          scenes: [{ id: 'opening' }, { id: 'opening' }],
        }],
      },
      {
        episodes: [{
          id: 'episode-example',
          scenes: [{ id: 'opening', transitions: [{ id: 'transition-unknown' }] }],
        }],
      },
      {
        episodes: [{
          id: 'episode-example',
          scenes: [{
            id: 'opening',
            transitions: [{ id: 'take-left' }, { id: 'take-left' }],
          }],
        }],
      },
    ]) {
      expect(() => applyFableLoomEditorialPatch(makeLoom(), content))
        .toThrow(/unknown|duplicate/i);
    }
  });

  it('rejects malformed transition triggers instead of sanitizing authored phrases away', () => {
    const loom = makeLoom();
    const existing = loom.episodes[0].nodes.find((node) => node.id === 'left').transitions[0];
    existing.triggers = ['go', 'continue'];

    expect(() => applyFableLoomEditorialPatch(loom, {
      episodes: [{
        id: 'episode-example',
        scenes: [{
          id: 'left',
          transitions: [{ id: 'left-end', triggers: [null, 42, {}] }],
        }],
      }],
    })).toThrow(/invalid triggers/i);
    expect(existing.triggers).toEqual(['go', 'continue']);
  });

  it('rejects a claimed remediation that contains no applicable change', () => {
    expect(() => applyFableLoomEditorialPatch(makeLoom(), {
      summary: 'The series is already coherent.',
      changes: ['Adjusted the opening.'],
    })).toThrow(/claimed editorial changes/i);
  });
});

describe('editorial generation guards', () => {
  it('uses the requested complete playthrough report throughout diagnostics', async () => {
    const loom = makeHighVariationLoom();
    const deterministic = analyzeLoomPlaythroughs(loom, { maxPaths: 128 });

    expect(deterministic.complete).toBe(true);
    expect(deterministic.stats.variationCount).toBe(128);
    const diagnostics = await collectFableLoomEditorialDiagnostics(
      loom,
      { universe: null, voiceProfiles: [], canonDigest: '' },
      { playthroughReport: deterministic },
    );

    expect(diagnostics.playthrough).toBe(deterministic);
    expect(diagnostics.stats.variationCount).toBe(128);
    expect(diagnostics.playthrough.complete).toBe(true);
  });

  it('fingerprints every semantic persisted field and ignores timestamps only', () => {
    const loom = makeLoom();
    const fingerprint = __testing.editorialFingerprint(loom);

    for (const patch of [
      { format: 'teleplay' },
      { playSettings: { providerId: 'writer' } },
      { universeId: 'universe-example' },
      { seriesId: 'series-example' },
    ]) {
      expect(__testing.editorialFingerprint({ ...loom, ...patch })).not.toBe(fingerprint);
    }
    expect(__testing.editorialFingerprint({ ...loom, updatedAt: 'later' })).toBe(fingerprint);
  });

  it('rejects stale review snapshots and oversized single-editor prompts', () => {
    const loom = makeLoom();
    expect(() => __testing.assertEditorialSnapshotUnchanged(
      { ...loom, format: 'teleplay' },
      __testing.editorialFingerprint(loom),
      { code: 'LOOM_CHANGED_DURING_REVIEW', message: 'Story changed' },
    )).toThrow(/story changed/i);

    expect(() => __testing.assertEditorialPromptBudget({
      teleplayDigest: 'x'.repeat(240_001),
    }, 240_000)).toThrow(/selected model's .* single-editor limit/i);
    expect(__testing.editorialPromptBudgetChars(128_000)).toBeGreaterThan(0);
    expect(__testing.editorialPromptBudgetChars(128_000)).toBeLessThan(1_000_000);
  });

  it('budgets the fully rendered customized stage prompt before any provider run', async () => {
    const buildPromptFn = vi.fn(async () => `Custom instructions\n${'x'.repeat(240_000)}`);

    await expect(__testing.renderEditorialPrompt(
      'fableloom-review-playthroughs',
      { playthroughDigest: 'small' },
      200_000,
      { buildPromptFn },
    )).rejects.toMatchObject({
      status: 413,
      code: 'FABLELOOM_EDITORIAL_CONTEXT_TOO_LARGE',
    });
    expect(buildPromptFn).toHaveBeenCalledTimes(1);
  });

  it('fails dependency reads closed and fingerprints canon and voice changes', async () => {
    const loom = { ...makeLoom(), universeId: 'universe-example' };
    await expect(__testing.loadEditorialDependencies(loom, {
      getUniverseFn: async () => { throw new Error('canon unavailable'); },
      listVoiceProfilesFn: async () => [],
    })).rejects.toThrow(/canon unavailable/i);
    await expect(__testing.loadEditorialDependencies(loom, {
      getUniverseFn: async () => ({ characters: [], places: [], objects: [] }),
      listVoiceProfilesFn: async () => { throw new Error('voices unavailable'); },
    })).rejects.toThrow(/voices unavailable/i);

    const original = {
      universe: { characters: [], places: [], objects: [] },
      voiceProfiles: [],
      canonDigest: 'Original canon',
    };
    expect(() => __testing.assertEditorialDependenciesUnchanged(
      { ...original, canonDigest: 'Changed canon' },
      __testing.editorialDependencyFingerprint(original),
      { code: 'STALE', message: 'Dependencies changed' },
    )).toThrow(/dependencies changed/i);
  });

  it('emits success only after validation and reports post-provider failures', async () => {
    const status = { complete: vi.fn(), error: vi.fn() };
    await expect(__testing.finalizeEditorialOperation(status, 'run-example', async () => {
      throw new Error('Story changed');
    })).rejects.toThrow(/story changed/i);
    expect(status.complete).not.toHaveBeenCalled();
    expect(status.error).toHaveBeenCalledWith('Story changed', { runId: 'run-example' });

    await expect(__testing.finalizeEditorialOperation(status, 'run-example', async () => 'done'))
      .resolves.toBe('done');
    expect(status.complete).toHaveBeenCalledWith(
      'Editorial operation complete',
      { runId: 'run-example', shellReady: false },
    );
  });
});
