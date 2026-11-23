import { describe, expect, it } from 'vitest';
import { threejsSculptSpecSchema } from './threejsModel.js';
import { buildThreejsPenetrationFeedback, evaluateThreejsPenetration } from './threejsModelPenetration.js';

const box = (size = 1) => ({ type: 'box', width: size, height: size, depth: size });

const part = (id, geometry, overrides = {}) => ({
  id,
  name: `${id} part`,
  geometry,
  material: 'shell',
  ...overrides,
});

// Every fixture goes through the real schema first: the evaluator's contract is
// "already validated", so a test that skipped parsing would exercise a shape the
// evaluator never sees (missing `position`/`scale`/`children` defaults).
const makeSpec = ({ parts, materials, articulation, animation }) => threejsSculptSpecSchema.parse({
  schemaVersion: 1,
  name: 'Example Assembly',
  summary: 'Placeholder spec used to exercise the cross-part penetration gate.',
  subjectType: 'object',
  camera: { position: [3, 2, 4] },
  materials: materials || { shell: { color: '#334455' } },
  lights: [{ type: 'directional', intensity: 2 }],
  parts,
  articulation,
  animation,
  detailInventory: [{
    feature: 'Overall silhouette',
    evidence: 'Visible in the reference image.',
    implementationPartIds: [parts[0].id],
    priority: 'identity',
  }],
});

const codes = (penetration) => penetration.findings.map((finding) => finding.code);
const finding = (penetration, code) => penetration.findings.find((entry) => entry.code === code);

describe('evaluateThreejsPenetration', () => {
  it('reports nothing when unrelated parts sit apart', () => {
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [
        part('hull', box(4)),
        part('fin', box(1), { position: [4, 0, 0] }),
      ],
    }));
    expect(penetration.findings).toEqual([]);
    expect(penetration).toMatchObject({ errorCount: 0, warningCount: 0, noteCount: 0, evaluatedPartCount: 2 });
  });

  it('never compares a pair whose bounding boxes are disjoint', () => {
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [part('hull', box(2)), part('fin', box(2), { position: [10, 0, 0] })],
    }));
    expect(penetration.comparedPairCount).toBe(0);
  });

  it('flags a small part swallowed whole by an unrelated sibling', () => {
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [part('hull', box(6)), part('core', box(1))],
    }));
    expect(codes(penetration)).toContain('buried-part');
    const buried = finding(penetration, 'buried-part');
    expect(buried).toMatchObject({ severity: 'error', partIds: ['core', 'hull'] });
    expect(buried.pairs[0]).toMatchObject({ partId: 'core', containerPartId: 'hull', fraction: 1 });
    expect(penetration.errorCount).toBe(1);
  });

  it('leaves a buried part alone when it is parented under its container', () => {
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [part('hull', box(6), { children: [part('core', box(1))] })],
    }));
    expect(penetration.findings).toEqual([]);
  });

  it('leaves a buried part alone when it is a declared attachment', () => {
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [part('hull', box(6)), part('pack', box(1))],
      articulation: {
        joints: [{ id: 'root', partId: 'hull' }],
        attachmentPartIds: ['pack'],
      },
    }));
    expect(penetration.findings).toEqual([]);
  });

  it('downgrades containment inside a transparent part to an undecided note', () => {
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [part('dome', box(6), { material: 'glass' }), part('core', box(1))],
      materials: {
        shell: { color: '#334455' },
        glass: { color: '#88ccff', transparent: true, opacity: 0.4 },
      },
    }));
    expect(codes(penetration)).toEqual(['undecided-contact']);
    expect(penetration).toMatchObject({ errorCount: 0, noteCount: 1, undecidedPairCount: 1 });
  });

  it('warns when unrelated parts share most of the smaller part volume', () => {
    // The 1³ box straddles the 4³ hull's wall three quarters of the way in —
    // past a seam, short of buried.
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [part('hull', box(4)), part('boss', box(1), { position: [1.75, 0, 0] })],
    }));
    expect(codes(penetration)).toEqual(['part-interpenetration']);
    const overlap = finding(penetration, 'part-interpenetration');
    expect(overlap.severity).toBe('warning');
    expect(overlap.pairs[0].fraction).toBeGreaterThan(0.5);
    expect(overlap.pairs[0].fraction).toBeLessThan(0.98);
  });

  it('treats a shallow seated joint as ordinary assembly', () => {
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [part('hull', box(4)), part('peg', box(1), { position: [2.45, 0, 0] })],
    }));
    expect(penetration.findings).toEqual([]);
  });

  it('reports a mid-depth overlap as undecided rather than as a defect', () => {
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [part('hull', box(4)), part('peg', box(1), { position: [2.2, 0, 0] })],
    }));
    expect(codes(penetration)).toEqual(['undecided-contact']);
    expect(penetration).toMatchObject({ errorCount: 0, warningCount: 0, noteCount: 1 });
    expect(finding(penetration, 'undecided-contact').message).toMatch(/undecided/);
  });

  it('applies the parent transform chain when placing a child part', () => {
    // The child sits at the group origin, and only the GROUP's offset carries it
    // clear of the hull — a gate that ignored the ancestor transform would read
    // it as buried.
    const spec = makeSpec({
      parts: [
        part('hull', box(4)),
        {
          id: 'arm',
          name: 'arm group',
          position: [6, 0, 0],
          children: [part('hand', box(1))],
        },
      ],
    });
    expect(evaluateThreejsPenetration(spec).findings).toEqual([]);
  });

  it('applies part rotation when measuring overlap', () => {
    // Two thin slabs crossing at right angles intersect in a small cube: well
    // under the contact floor, and only if the rotation is actually applied.
    const slab = { type: 'box', width: 6, height: 0.4, depth: 0.4 };
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [
        part('beamA', slab),
        part('beamB', slab, { rotationDegrees: [0, 90, 0] }),
      ],
    }));
    expect(penetration.comparedPairCount).toBe(1);
    expect(penetration.findings).toEqual([]);
  });

  it('measures a sphere as a solid ball rather than as its bounding box', () => {
    // A 1³ box parked at the corner of the sphere's bounding box is outside the
    // ball entirely — a box-only gate would call it buried.
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [
        part('ball', { type: 'sphere', radius: 3 }),
        part('cube', box(1), { position: [2.6, 2.6, 2.6] }),
      ],
    }));
    expect(penetration.findings).toEqual([]);
  });

  it('finds a custom mesh buried inside a primitive', () => {
    const vertices = [];
    for (const x of [-0.4, 0.4]) {
      for (const y of [-0.4, 0.4]) {
        for (const z of [-0.4, 0.4]) vertices.push(x, y, z);
      }
    }
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [
        part('hull', box(6)),
        part('greeble', { type: 'custom', vertices, indices: [0, 1, 2, 3, 4, 5] }),
      ],
    }));
    expect(codes(penetration)).toContain('buried-part');
    expect(finding(penetration, 'buried-part').pairs[0]).toMatchObject({ partId: 'greeble', containerPartId: 'hull' });
  });

  it('skips a pair whose only measurable side is a custom mesh', () => {
    const vertices = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, 1];
    const mesh = { type: 'custom', vertices, indices: [0, 1, 2] };
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [part('meshA', mesh), part('meshB', mesh)],
    }));
    expect(penetration.comparedPairCount).toBe(1);
    expect(penetration.findings).toEqual([]);
  });

  it('reads a hollow lathe shell as hollow', () => {
    // A thin-walled cup: a part sitting in the cavity is inside the bounding
    // box and outside the material.
    const wall = [[1, -1], [1.2, -1], [1.2, 1], [1, 1]];
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [
        part('cup', { type: 'lathe', points: wall }),
        part('pip', box(0.5)),
      ],
    }));
    expect(penetration.findings).toEqual([]);
  });

  it('measures a two-point lathe silhouette instead of dropping it as unmeasurable', () => {
    // The smallest profile the schema allows draws a spun cone from bottom to
    // top. Closed back on itself it encloses no area at all, so the solid has to
    // be closed through the axis or the part never enters the gate.
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [
        part('spike', { type: 'lathe', points: [[1.5, -2], [0, 2]] }),
        part('pip', box(0.4), { position: [0, -1.5, 0] }),
      ],
    }));
    expect(penetration.evaluatedPartCount).toBe(2);
    expect(codes(penetration)).toContain('buried-part');
    expect(finding(penetration, 'buried-part').pairs[0]).toMatchObject({ partId: 'pip', containerPartId: 'spike' });
  });

  it('measures a tube along its path rather than filling its bounding box', () => {
    // The corner of the tube's bounding box is nowhere near the swept path, so a
    // box-only gate would call the cube buried.
    const tube = { type: 'tube', path: [[-3, 0, 0], [0, 0, 0], [3, 0, 0]], radius: 0.5 };
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [
        part('cable', tube),
        part('clampOn', box(0.4), { position: [0, 0.2, 0] }),
        part('clear', box(0.4), { position: [0, 3, 0] }),
      ],
    }));
    expect(finding(penetration, 'buried-part').pairs).toEqual([
      expect.objectContaining({ partId: 'clampOn', containerPartId: 'cable' }),
    ]);
  });

  it('counts distinct buried parts rather than container pairs', () => {
    // One pip inside two overlapping hulls is ONE invisible part, reported
    // against two containers.
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [
        part('hullA', box(6)),
        part('hullB', box(6), { position: [0.5, 0, 0] }),
        part('pip', box(0.4)),
      ],
    }));
    const buried = finding(penetration, 'buried-part');
    expect(buried.pairs).toHaveLength(2);
    expect(buried.message).toMatch(/^1 part\(s\) are entirely inside/);
  });

  it('measures a torus as a ring rather than as a filled disc', () => {
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [
        part('ring', { type: 'torus', radius: 3, tube: 0.4 }),
        part('hubMesh', box(1)),
      ],
    }));
    expect(penetration.comparedPairCount).toBe(1);
    expect(penetration.findings).toEqual([]);
  });

  it('reads an extrude hole as empty space', () => {
    const outline = [[-2, -2], [2, -2], [2, 2], [-2, 2]];
    const hole = [[-0.8, -0.8], [-0.8, 0.8], [0.8, 0.8], [0.8, -0.8]];
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [
        part('plate', { type: 'extrude', outline, holes: [hole], depth: 2 }),
        part('pin', { type: 'cylinder', radiusTop: 0.5, radiusBottom: 0.5, height: 4 }, {
          position: [0, 0, 1],
          rotationDegrees: [90, 0, 0],
        }),
      ],
    }));
    expect(penetration.comparedPairCount).toBe(1);
    expect(penetration.findings).toEqual([]);
  });

  it('caps the pairs it names while still counting them all', () => {
    const parts = [part('hull', box(20))];
    for (let index = 0; index < 9; index += 1) {
      parts.push(part(`greeble${index}`, box(0.5), { position: [index - 4, 0, 0] }));
    }
    const buried = finding(evaluateThreejsPenetration(makeSpec({ parts })), 'buried-part');
    // Nine swallowed greebles, plus the hull, all listed in `partIds`, but the
    // message names only the capped head of the list.
    expect(buried.pairs).toHaveLength(9);
    expect(buried.partIds).toHaveLength(10);
    expect(buried.message).toMatch(/\(\+\d+ more\)/);
  });

  it('returns an empty result for a spec with no parts at all', () => {
    expect(evaluateThreejsPenetration(null)).toMatchObject({
      findings: [],
      evaluatedPartCount: 0,
      comparedPairCount: 0,
    });
  });

  it('ignores a part whose stored scale collapses it to nothing', () => {
    // The authoring schema rejects a zero scale, but a stored spec predates that
    // bound — the transform is singular, so the part is unmeasurable, not buried.
    const spec = makeSpec({ parts: [part('hull', box(6)), part('ghost', box(1))] });
    spec.parts[1].scale = [0, 1, 1];
    const penetration = evaluateThreejsPenetration(spec);
    expect(penetration.evaluatedPartCount).toBe(1);
    expect(penetration.findings).toEqual([]);
  });
it('still measures a stored spec whose rotation or scale is not a finite triple', () => {
    // Reachable only past the schema — a record stored before a bound tightened.
    // The shared transform reads a non-finite component as 0 degrees / scale 1
    // (what the renderer does), so the gate keeps measuring instead of handing
    // back NaN bounds that would read as `no overlap`.
    const spec = makeSpec({ parts: [part('hull', box(6)), part('core', box(1))] });
    spec.parts[1].rotationDegrees = [45, undefined, NaN];
    spec.parts[1].scale = [NaN, 1, 1];

    const penetration = evaluateThreejsPenetration(spec);
    expect(penetration.evaluatedPartCount).toBe(2);
    expect(codes(penetration)).toContain('buried-part');
    const [pair] = finding(penetration, 'buried-part').pairs;
    expect(pair).toMatchObject({ partId: 'core', containerPartId: 'hull' });
    expect(Number.isFinite(pair.fraction)).toBe(true);
  });
});

const collisions = (penetration) => penetration.findings.filter((entry) => entry.code === 'clip-part-collision');

const turn = (id, partId, from, to, { startSeconds = 0, endSeconds = 2, channel = 'rotationDegrees' } = {}) => ({
  id,
  name: id,
  partId,
  startSeconds,
  endSeconds,
  easing: 'linear',
  channels: { [channel]: { from, to } },
});

const makeClip = (sequences, overrides = {}) => ({
  id: 'open',
  name: 'Open',
  durationSeconds: 2,
  sequences,
  ...overrides,
});

// A deck whose top face is y = 0, and a hatch lying on it. The hatch is a
// 3 x 0.2 x 2 slab; what differs between the two fixtures below is only where it pivots.
const deck = () => part('deck', { type: 'box', width: 4, height: 3, depth: 4 }, { position: [0, -1.5, 0] });
const hatchGeometry = { type: 'box', width: 3, height: 0.2, depth: 2 };

describe('evaluateThreejsPenetration over clip poses', () => {
  it('keeps a door hinged on its edge clean while the same door hinged at its centre is flagged at the right time', () => {
    const edgeHinged = evaluateThreejsPenetration(makeSpec({
      parts: [
        deck(),
        part('hinge', null, {
          geometry: undefined,
          position: [-1.5, 0.1, 0],
          children: [part('hatch', hatchGeometry, { position: [1.5, 0, 0] })],
        }),
      ],
      animation: { clips: [makeClip([turn('swing', 'hinge', [0, 0, 0], [0, 0, 30])])] },
    }));
    expect(collisions(edgeHinged)).toEqual([]);
    expect(edgeHinged.poseCoverage).toMatchObject({ status: 'complete' });
    expect(edgeHinged.evaluatedPoseCount).toBeGreaterThan(0);

    const centreHinged = evaluateThreejsPenetration(makeSpec({
      parts: [deck(), part('hatch', hatchGeometry, { position: [0, 0.1, 0] })],
      animation: { clips: [makeClip([turn('swing', 'hatch', [0, 0, 0], [0, 0, 30])])] },
    }));
    const [collision] = collisions(centreHinged);
    expect(collisions(centreHinged)).toHaveLength(1);
    expect(collision).toMatchObject({
      severity: 'note',
      clipId: 'open',
      timeSeconds: 1,
      restFraction: 0,
    });
    expect([...collision.partIds].sort()).toEqual(['deck', 'hatch']);
    expect(collision.worstFraction).toBeGreaterThanOrEqual(0.15);
    expect(collision.message).toContain('Open');
    expect(centreHinged.noteCount).toBeGreaterThan(0);
  });

  it('does not report a pair that overlaps as much in motion as it does at rest', () => {
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [
        part('plate', box(4)),
        part('ball', { type: 'sphere', radius: 1 }, { position: [2, 0, 0] }),
      ],
      animation: { clips: [makeClip([turn('spin', 'ball', [0, 0, 0], [0, 180, 0])])] },
    }));
    expect(penetration.findings.length).toBeGreaterThan(0);
    expect(collisions(penetration)).toEqual([]);
  });

  it('catches a 360 degree turn that collides only mid-window', () => {
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [
        part('arm', null, {
          geometry: undefined,
          position: [0, 1, 0],
          children: [part('beam', { type: 'box', width: 3, height: 0.2, depth: 0.2 }, { position: [1.5, 0, 0] })],
        }),
        part('post', { type: 'box', width: 0.6, height: 1, depth: 0.6 }, { position: [0, 1, 1.5] }),
      ],
      animation: { clips: [makeClip([turn('sweep', 'arm', [0, 0, 0], [0, 360, 0], { endSeconds: 4 })], { durationSeconds: 4 })] },
    }));
    const [collision] = collisions(penetration);
    // A positive turn about Y carries +X toward -Z, so the beam reaches the post at 270 degrees.
    expect(collision).toMatchObject({ clipId: 'open', timeSeconds: 3 });
    expect([...collision.partIds].sort()).toEqual(['beam', 'post']);
    // Both clip boundaries are the rest pose, so only the interior samples can see this.
    expect(penetration.poseCoverage.clips[0].sampledTimes).toEqual(expect.arrayContaining([0, 1, 2, 3, 4]));
  });

  it('marks a pose that swallows a part whole as a warning', () => {
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [
        part('housing', box(4)),
        part('plunger', box(1), { position: [6, 0, 0] }),
      ],
      animation: { clips: [makeClip([turn('plunge', 'plunger', [6, 0, 0], [0, 0, 0], { channel: 'position' })])] },
    }));
    const [collision] = collisions(penetration);
    expect(collision).toMatchObject({ severity: 'warning', timeSeconds: 2 });
    expect(collision.worstFraction).toBeGreaterThanOrEqual(0.98);
    expect(penetration.warningCount).toBe(1);
  });

  it('exempts pairs an articulation joint connects, and parented or attached parts', () => {
    const parts = [deck(), part('hatch', hatchGeometry, { position: [0, 0.1, 0] })];
    const animation = { clips: [makeClip([turn('swing', 'hatch', [0, 0, 0], [0, 0, 90])])] };
    const joined = evaluateThreejsPenetration(makeSpec({
      parts,
      animation,
      articulation: {
        joints: [
          { id: 'frame-joint', partId: 'deck' },
          { id: 'hatch-joint', partId: 'hatch', parentJointId: 'frame-joint', pivotSocket: null },
        ],
      },
    }));
    expect(collisions(joined)).toEqual([]);

    const attached = evaluateThreejsPenetration(makeSpec({
      parts,
      animation,
      articulation: { joints: [{ id: 'frame-joint', partId: 'deck' }], attachmentPartIds: ['hatch'] },
    }));
    expect(collisions(attached)).toEqual([]);
  });

  it('skips a part that is hidden or fully transparent while it collides', () => {
    const hidden = evaluateThreejsPenetration(makeSpec({
      parts: [deck(), part('hatch', hatchGeometry, { position: [0, 0.1, 0] })],
      animation: {
        clips: [makeClip([{
          ...turn('swing', 'hatch', [0, 0, 0], [0, 0, 90]),
          channels: {
            rotationDegrees: { from: [0, 0, 0], to: [0, 0, 90] },
            visible: { from: false, to: false },
          },
        }])],
      },
    }));
    expect(collisions(hidden)).toEqual([]);

    const faded = evaluateThreejsPenetration(makeSpec({
      parts: [deck(), part('hatch', hatchGeometry, { position: [0, 0.1, 0] })],
      animation: {
        clips: [makeClip([{
          ...turn('swing', 'hatch', [0, 0, 0], [0, 0, 90]),
          channels: {
            rotationDegrees: { from: [0, 0, 0], to: [0, 0, 90] },
            opacity: { from: 0, to: 0 },
          },
        }])],
      },
    }));
    // The turn satisfies the schema's "must change a channel" rule; opacity 0 is what hides it.
    expect(collisions(faded)).toEqual([]);
  });

  it('ignores a pass-through into a transparent container', () => {
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [
        { ...deck(), material: 'glass' },
        part('hatch', hatchGeometry, { position: [0, 0.1, 0] }),
      ],
      materials: { shell: { color: '#334455' }, glass: { color: '#aaccff', transparent: true, opacity: 0.3 } },
      animation: { clips: [makeClip([turn('swing', 'hatch', [0, 0, 0], [0, 0, 90])])] },
    }));
    expect(collisions(penetration)).toEqual([]);
  });

  it('reports the poses the shared budget left out instead of reading clean', () => {
    const sequences = Array.from({ length: 8 }, (_, index) => turn(
      `step-${index}`,
      'hatch',
      [0, 0, index],
      [0, 0, index + 1],
      { startSeconds: index * 0.25, endSeconds: (index + 1) * 0.25 },
    ));
    const clips = Array.from({ length: 12 }, (_, index) => makeClip(sequences, { id: `clip-${index}`, name: `Clip ${index}` }));
    const penetration = evaluateThreejsPenetration(makeSpec({
      parts: [deck(), part('hatch', hatchGeometry, { position: [0, 3, 0] })],
      animation: { clips },
    }));
    expect(penetration.evaluatedPoseCount).toBe(48);
    expect(penetration.poseCoverage).toMatchObject({ status: 'partial', budget: 48 });
    const unsampled = penetration.findings.filter((entry) => entry.code === 'clip-poses-unsampled');
    expect(unsampled).toHaveLength(12);
    expect(unsampled[0]).toMatchObject({ severity: 'note', clipId: 'clip-0' });
    expect(unsampled[0].omittedCount).toBeGreaterThan(0);
  });

  it('bounds the work for a 160-part, 12-clip spec by pose and pair counts', () => {
    // The schema caps one level at 40 parts, so 156 parts sit under four bare groups (160 in all, the schema maximum).
    const parts = Array.from({ length: 4 }, (_, group) => part(`g${group}`, null, {
      geometry: undefined,
      children: Array.from({ length: 39 }, (__, slot) => {
        const index = (group * 39) + slot;
        return part(`p${index}`, box(1), { position: [(index % 16) * 3, Math.floor(index / 16) * 3, 0] });
      }),
    }));
    const clips = Array.from({ length: 12 }, (_, index) => makeClip(
      [turn('slide', `p${index}`, [(index % 16) * 3, 0, 0], [(index % 16) * 3 + 2.6, 0, 0], { channel: 'position', startSeconds: 0.5, endSeconds: 1.5 })],
      { id: `clip-${index}`, name: `Clip ${index}` },
    ));
    const penetration = evaluateThreejsPenetration(makeSpec({ parts, animation: { clips } }));
    expect(penetration.evaluatedPartCount).toBe(156);
    expect(penetration.evaluatedPoseCount).toBe(48);
    // Each clip moves one part, so only its pairs are ever measured — and only the
    // pose where it reaches its neighbour has bounds that touch (the first 12 parts
    // share row 0, three units apart).
    expect(penetration.poseCoverage.comparedPairCount).toBe(12);
    expect(collisions(penetration)).toHaveLength(12);
  });

  it('returns a static spec exactly as before, with no clip fields', () => {
    const penetration = evaluateThreejsPenetration(makeSpec({ parts: [part('hull', box(2))] }));
    expect(Object.keys(penetration).sort()).toEqual([
      'comparedPairCount', 'errorCount', 'evaluatedPartCount', 'findings', 'noteCount', 'undecidedPairCount', 'warningCount',
    ]);
  });
});

describe('buildThreejsPenetrationFeedback', () => {
  it('feeds clip collision warnings back with a motion-focused remedy, and never the notes', () => {
    const feedback = buildThreejsPenetrationFeedback({
      findings: [
        { code: 'clip-part-collision', severity: 'warning', message: 'hatch passes through deck' },
        { code: 'clip-part-collision', severity: 'note', message: 'latch grazes frame' },
        { code: 'clip-poses-unsampled', severity: 'note', message: 'poses omitted' },
      ],
    });
    expect(feedback).toContain('1. hatch passes through deck');
    expect(feedback).toContain('pass through each other while a clip plays');
    expect(feedback).not.toContain('grazes');
    expect(feedback).not.toContain('omitted');
    expect(feedback).not.toContain('Give every part its own volume');
  });

  it('says nothing when there is nothing to fix', () => {
    expect(buildThreejsPenetrationFeedback(null)).toBe('');
    expect(buildThreejsPenetrationFeedback({ findings: [] })).toBe('');
  });

  it('ignores undecided contact, which a refinement pass must not be told to fix', () => {
    expect(buildThreejsPenetrationFeedback({
      findings: [{ code: 'undecided-contact', severity: 'note', message: 'partial overlap' }],
    })).toBe('');
  });

  it('turns errors and warnings into numbered refinement instructions', () => {
    const feedback = buildThreejsPenetrationFeedback({
      findings: [
        { code: 'buried-part', severity: 'error', message: 'core is inside hull' },
        { code: 'part-interpenetration', severity: 'warning', message: 'boss overlaps hull' },
        { code: 'undecided-contact', severity: 'note', message: 'peg meets hull' },
      ],
    });
    expect(feedback).toContain('1. core is inside hull');
    expect(feedback).toContain('2. boss overlaps hull');
    expect(feedback).not.toContain('peg meets hull');
  });
});
