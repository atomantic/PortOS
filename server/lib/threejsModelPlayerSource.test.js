import { describe, expect, it } from 'vitest';
import { buildThreejsFactorySource } from './threejsModel.js';
import { THREEJS_PLAYER_SOURCE } from './threejsModelPlayerSource.js';

// The emitted player is only worth shipping if it actually runs, so the suite
// EXECUTES it rather than grepping the string: the module is imported with the
// `three` import swapped for the two helpers the player reaches through
// (`MathUtils.degToRad`), which is enough to drive poses without pulling a
// renderer into a node test.
const importEmitted = async (spec) => {
  const source = buildThreejsFactorySource(spec)
    .replace(
      "import * as THREE from 'three';",
      'const THREE = { MathUtils: { degToRad: (degrees) => (degrees * Math.PI) / 180 } };'
    );
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};

const vector = () => {
  const value = { x: 0, y: 0, z: 0 };
  value.set = (x, y, z) => Object.assign(value, { x, y, z });
  return value;
};

// A stand-in for the Three.js node the factory would have built. Only the
// surface the player touches is modelled.
const node = (material = null) => ({
  position: vector(),
  rotation: vector(),
  scale: vector(),
  visible: true,
  material,
});

const material = (overrides = {}) => {
  const value = { opacity: 1, transparent: false, disposed: false, ...overrides };
  value.clone = () => material({ ...value, clonedFrom: value });
  value.dispose = () => { value.disposed = true; };
  return value;
};

const spec = () => ({
  schemaVersion: 1,
  name: 'Example Hatch',
  summary: 'A panel that lifts and an arm that swings.',
  subjectType: 'object',
  background: '#111827',
  camera: { position: [4, 3, 5], target: [0, 0, 0], fov: 42 },
  materials: { body: { type: 'standard', color: '#8b5a2b', metalness: 0, roughness: 0.7 } },
  lights: [{ type: 'ambient', color: '#ffffff', intensity: 0.4 }],
  parts: [
    {
      id: 'panel',
      name: 'Panel',
      geometry: { type: 'box', width: 1, height: 0.2, depth: 1 },
      material: 'body',
      position: [0, 0, 0],
      rotationDegrees: [0, 0, 0],
      scale: [1, 1, 1],
      children: [],
    },
    {
      id: 'arm',
      name: 'Arm',
      geometry: { type: 'box', width: 0.2, height: 1, depth: 0.2 },
      material: 'body',
      position: [1, 0, 0],
      rotationDegrees: [0, 0, 0],
      scale: [1, 1, 1],
      children: [],
    },
  ],
  sockets: [],
  detailInventory: [{
    feature: 'Lifting panel',
    evidence: 'The reference shows a hinged panel over the housing.',
    implementationPartIds: ['panel'],
    priority: 'identity',
  }],
  animation: {
    cues: [{ id: 'latch', label: 'Latch release', kind: 'latch' }],
    clips: [
      {
        id: 'deploy',
        name: 'Deploy',
        role: 'deploy',
        durationSeconds: 4,
        loop: false,
        sequences: [
          {
            id: 'lift',
            name: 'Lift the panel',
            partId: 'panel',
            startSeconds: 0,
            endSeconds: 2,
            easing: 'linear',
            channels: { position: { from: [0, 0, 0], to: [0, 2, 0] } },
            cueId: 'latch',
          },
          {
            id: 'swing',
            name: 'Swing the arm',
            partId: 'arm',
            startSeconds: 2,
            endSeconds: 4,
            easing: 'linear',
            channels: { rotationDegrees: { from: [0, 0, 0], to: [0, 180, 0] } },
            cueId: 'latch',
          },
        ],
      },
      {
        id: 'fade',
        name: 'Fade',
        role: 'custom',
        durationSeconds: 2,
        loop: false,
        sequences: [{
          id: 'dim',
          name: 'Dim the panel',
          partId: 'panel',
          startSeconds: 0,
          endSeconds: 2,
          easing: 'linear',
          channels: { opacity: { from: 1, to: 0 }, visible: { from: true, to: false } },
          cueId: null,
        }],
      },
    ],
  },
});

const mountPlayer = async (input = spec(), options = undefined) => {
  const module = await importEmitted(input);
  const nodes = { panel: node(material()), arm: node(material()) };
  const root = { userData: { sculptRuntime: { nodes, animation: input.animation || null } } };
  return { module, nodes, player: module.createSculptAnimationPlayer(root, options) };
};

describe('THREEJS_PLAYER_SOURCE', () => {
  // The player lives inside a template literal, so an unescaped backtick in one
  // of its comments closes the string early and truncates the rest of the player
  // with no syntax error anywhere — the emitted module just quietly stops
  // exporting a player. This is the cheap tripwire for that.
  it('carries the whole player, with every backtick in it escaped', () => {
    for (const symbol of ['evaluateSculptClipPose', 'collectSculptCues', 'createSculptAnimationPlayer']) {
      expect(THREEJS_PLAYER_SOURCE).toContain(`export function ${symbol}(`);
    }
    expect(THREEJS_PLAYER_SOURCE).toContain('return player;');
  });
});

describe('emitted clip player', () => {
  it('poses the node map from a scrub without firing a cue', async () => {
    const cues = [];
    const { nodes, player } = await mountPlayer(spec(), { onCue: (event) => cues.push(event) });

    expect(player.clipId).toBe('deploy');
    expect(player.durationSeconds).toBe(4);
    player.seek(1);
    // Half-way through a linear two-second lift.
    expect(nodes.panel.position).toMatchObject({ x: 0, y: 1, z: 0 });
    // A sequence still ahead of the playhead holds its `from`, so the arm has
    // not moved and has NOT snapped back to the authored pose either.
    expect(nodes.arm.rotation).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(cues).toEqual([]);
  });

  it('fires each crossed cue once on update, oldest first, and stops a one-shot at its end', async () => {
    const cues = [];
    const { player } = await mountPlayer(spec(), { onCue: (event) => cues.push(event) });

    expect(player.play()).toBe(true);
    // One frame long enough to cross both cue-carrying sequence starts (0s, 2s)
    // and run past the clip's 4s end.
    const crossed = player.update(9);
    expect(crossed.map((event) => event.sequenceId)).toEqual(['lift', 'swing']);
    expect(cues.map((event) => event.cueId)).toEqual(['latch', 'latch']);
    // The cue is resolved to its declared entry so a host can map an identifier
    // to its own sound without re-reading the spec.
    expect(cues[0].cue).toMatchObject({ id: 'latch', kind: 'latch' });
    expect(player.timeSeconds).toBe(4);
    expect(player.playing).toBe(false);
    // A finished one-shot replays from the top rather than sitting on its last
    // frame.
    player.play();
    expect(player.timeSeconds).toBe(0);
  });

  it('wraps a looping clip and fires every cue in a gap longer than the clip exactly once', async () => {
    const looping = spec();
    looping.animation.clips[0].loop = true;
    const cues = [];
    const { player } = await mountPlayer(looping, { onCue: (event) => cues.push(event) });

    player.play();
    player.update(10);
    expect(cues.map((event) => event.sequenceId)).toEqual(['lift', 'swing']);
    expect(player.playing).toBe(true);
    expect(player.timeSeconds).toBeCloseTo(2, 6);
  });

  it('fires the cues a wrap skipped over, not just the ones either side of it', async () => {
    const looping = spec();
    looping.animation.clips[0].loop = true;
    const cues = [];
    const { player } = await mountPlayer(looping, { onCue: (event) => cues.push(event) });

    player.seek(3);
    player.play();
    // A 10s gap from 3s of a 4s clip laps it twice. The cue at 2s sits in the
    // skipped interval — neither in the tail [3, 4) nor in the wrapped [0, 1).
    const crossed = player.update(10);
    expect(crossed.map((event) => event.sequenceId)).toEqual(['lift', 'swing']);
    expect(cues).toHaveLength(2);
    expect(player.timeSeconds).toBeCloseTo(1, 6);
  });

  it('crosses the loop point within a single lap without firing a cue twice', async () => {
    const looping = spec();
    looping.animation.clips[0].loop = true;
    const { player } = await mountPlayer(looping);

    player.seek(3);
    player.play();
    // [3, 4) holds nothing; the wrapped [0, 0.5) picks up the cue at 0.
    const crossed = player.update(1.5);
    expect(crossed.map((event) => event.sequenceId)).toEqual(['lift']);
    expect(player.timeSeconds).toBeCloseTo(0.5, 6);
  });

  it('poses the model at frame 0 of its first clip as soon as it is created', async () => {
    const opening = spec();
    // A clip whose opening frame is not the assembled pose: the panel starts
    // hidden and appears part-way through.
    opening.animation.clips[0].sequences[0].channels.visible = { from: false, to: true };
    const { nodes } = await mountPlayer(opening);
    expect(nodes.panel.visible).toBe(false);
  });

  it('clones a shared material before driving opacity, and gives it back on restore', async () => {
    const { nodes, player } = await mountPlayer();
    const sharedPanelMaterial = nodes.panel.material;
    const sharedArmMaterial = nodes.arm.material;

    player.setClip('fade');
    player.seek(1);
    expect(nodes.panel.material).not.toBe(sharedPanelMaterial);
    expect(nodes.panel.material.opacity).toBeCloseTo(0.5, 6);
    expect(nodes.panel.material.transparent).toBe(true);
    // The arm shares the same material definition and must not have faded with
    // the panel.
    expect(sharedPanelMaterial.opacity).toBe(1);
    expect(nodes.arm.material).toBe(sharedArmMaterial);

    player.restore();
    expect(nodes.panel.material).toBe(sharedPanelMaterial);
    expect(nodes.panel.visible).toBe(true);
    expect(nodes.panel.position).toMatchObject({ x: 0, y: 0, z: 0 });
  });

  it('returns parts the previous clip drove to their authored pose when the clip changes', async () => {
    const { nodes, player } = await mountPlayer();

    player.seek(4);
    expect(nodes.panel.position).toMatchObject({ x: 0, y: 2, z: 0 });
    expect(nodes.arm.rotation.y).toBeCloseTo(Math.PI, 6);

    // `fade` drives the panel only — the arm would otherwise stay frozen where
    // `deploy` left it.
    player.setClip('fade');
    expect(nodes.arm.rotation).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(nodes.panel.position).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(player.timeSeconds).toBe(0);
  });

  it('steps visible at the end of its window rather than fading it', async () => {
    const { nodes, player } = await mountPlayer();
    player.setClip('fade');
    player.seek(1.9);
    expect(nodes.panel.visible).toBe(true);
    player.seek(2);
    expect(nodes.panel.visible).toBe(false);
  });

  it('falls back to the first clip for an id this model does not declare', async () => {
    const { player } = await mountPlayer();
    expect(player.setClip('nope')).toBe('deploy');
  });

  it('yields a working no-op player for a static assembly', async () => {
    const staticSpec = spec();
    delete staticSpec.animation;
    const { nodes, player } = await mountPlayer(staticSpec);

    expect(player.clips).toEqual([]);
    expect(player.clipId).toBeNull();
    expect(player.play()).toBe(false);
    expect(player.update(1)).toEqual([]);
    expect(player.setClip('deploy')).toBeNull();
    expect(nodes.panel.position).toMatchObject({ x: 0, y: 0, z: 0 });
  });

  it('survives a host cue handler that throws rather than killing the render loop', async () => {
    const { player } = await mountPlayer(spec(), { onCue: () => { throw new Error('host blew up'); } });
    player.play();
    expect(() => player.update(1)).not.toThrow();
    expect(player.timeSeconds).toBe(1);
  });

  it('exports the pose evaluator so a host can drive its own renderer', async () => {
    const { module } = await mountPlayer();
    const clip = spec().animation.clips[0];
    expect(module.evaluateSculptClipPose(clip, 1).panel.position).toEqual([0, 1, 0]);
    expect(module.collectSculptCues(clip, 0, 1).map((event) => event.sequenceId)).toEqual(['lift']);
    // Half-open: a cue at the interval's end belongs to the NEXT frame, so no
    // frame boundary fires one twice.
    expect(module.collectSculptCues(clip, 0, 2).map((event) => event.sequenceId)).toEqual(['lift']);
  });
});
