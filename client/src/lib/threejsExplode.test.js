import { describe, expect, it } from 'vitest';
import {
  buildPartSelectionIndex,
  computeExplodeLayout,
  EXPLODE_BASE_CLEARANCE,
  EXPLODE_LAYOUT_SCALE,
  isContainerPart,
  isReliefPart,
} from './threejsExplode.js';

const part = (id, overrides = {}) => ({
  id,
  name: `${id} name`,
  geometry: { type: 'box', width: 1, height: 1, depth: 1 },
  material: 'body',
  position: [0, 0, 0],
  rotationDegrees: [0, 0, 0],
  scale: [1, 1, 1],
  children: [],
  ...overrides,
});

const offsetOf = (layout, id) => layout.offsets[id] || [0, 0, 0];
const magnitude = ([x, y, z]) => Math.sqrt((x * x) + (y * y) + (z * z));

describe('the shared part definition', () => {
  it('treats a geometry-bearing part with only relief children as a leaf that moves on its own', () => {
    const blade = part('blade', {
      children: [part('serrations', { explodeWithParent: true })],
    });

    expect(isReliefPart(blade)).toBe(false);
    expect(isReliefPart(blade.children[0])).toBe(true);
    // Relief rides its parent, so it never turns that parent into a container.
    expect(isContainerPart(blade)).toBe(false);
    expect(computeExplodeLayout([blade], 0).unitIds).toEqual(['blade']);
  });

  it('moves a geometry-bearing container as a unit AND descends into its children', () => {
    // The canonical authored shape: a crate body with a trim strip on it. If the
    // body were treated as a pure container it would be pinned in place and,
    // with only one child, there would be nothing to separate at all.
    const crate = part('crateBody', {
      position: [0, 0, 0],
      children: [part('frontTrim', { position: [0, 0, 0.64] })],
    });
    const layout = computeExplodeLayout([crate], 1);

    expect(layout.unitIds).toEqual(['crateBody', 'frontTrim']);
    // The body's offset applies to its own geometry, not to its group — moving
    // the group would drag the trim along and separate nothing.
    expect(layout.meshOffsets.crateBody).toBeDefined();
    expect(layout.offsets.crateBody).toBeUndefined();
    expect(magnitude(layout.meshOffsets.crateBody)).toBeGreaterThan(0);
    expect(magnitude(offsetOf(layout, 'frontTrim'))).toBeGreaterThan(0);
  });

  it('ignores an organizational group that carries no geometry anywhere', () => {
    const layout = computeExplodeLayout([
      part('body', { position: [1, 0, 0] }),
      part('anchor', { geometry: undefined, material: undefined, position: [-4, 0, 0] }),
    ], 1);

    // An invisible node must not become a unit — it would drag the centre and
    // enable a slider that has nothing to move.
    expect(layout.unitIds).toEqual(['body']);
    expect(layout.offsets).toEqual({});
  });

  it('treats root-level relief as an ordinary part, matching what the picker owns', () => {
    const parts = [
      part('floatingTrim', { explodeWithParent: true, position: [-1, 0, 0], children: [part('realPart', { position: [0, 0, 0.5] })] }),
      part('body', { position: [1, 0, 0] }),
    ];
    const layout = computeExplodeLayout(parts, 1);
    const { owners } = buildPartSelectionIndex(parts);

    // There is no parent to ride, and the picker self-owns it — so the two
    // halves of the definition must not disagree about whether it is a part.
    expect(layout.unitIds).toEqual(['floatingTrim', 'realPart', 'body']);
    expect(owners.floatingTrim).toBe('floatingTrim');
    // Nor may the ownership carry down: the layout separates this child, so the
    // picker must name it rather than the contradictory root "relief" above it.
    expect(layout.offsets.realPart).toBeDefined();
    expect(owners.realPart).toBe('realPart');
  });

  it('does not read part ids through Object.prototype', () => {
    // idSchema accepts `toString`, and a plain-object lookup would hand back an
    // inherited function that reads as an offset and renders NaN positions.
    const parts = [part('toString', { position: [-1, 0, 0] }), part('constructor', { position: [1, 0, 0] })];
    const layout = computeExplodeLayout(parts, 0);
    const { owners, names, ancestry } = buildPartSelectionIndex(parts);

    expect(layout.offsets.toString).toBeUndefined();
    expect(layout.meshOffsets.constructor).toBeUndefined();
    expect(owners.toString).toBe('toString');
    expect(names.constructor).toBe('constructor name');
    expect(ancestry.valueOf).toBeUndefined();
  });

  it('descends through a part whose children carry the geometry', () => {
    const rig = part('rig', {
      geometry: undefined,
      material: undefined,
      children: [part('left'), part('right')],
    });

    expect(isContainerPart(rig)).toBe(true);
    expect(computeExplodeLayout([rig], 0).unitIds).toEqual(['left', 'right']);
  });
});

describe('buildPartSelectionIndex', () => {
  it('resolves a click on surface relief up to the part it belongs to', () => {
    const { owners, names } = buildPartSelectionIndex([
      part('blade', {
        children: [
          part('serrations', {
            explodeWithParent: true,
            children: [part('serrationTips', { explodeWithParent: true })],
          }),
        ],
      }),
    ]);

    expect(owners.blade).toBe('blade');
    expect(owners.serrations).toBe('blade');
    // Relief nested under relief still resolves to the real part, not the sliver.
    expect(owners.serrationTips).toBe('blade');
    expect(names.serrations).toBe('serrations name');
  });

  it('owns everything under relief to the same part, because the layout skips that whole subtree', () => {
    const parts = [
      part('body', { children: [part('panelLines', { explodeWithParent: true, children: [part('boltHead')] })] }),
      part('other', { position: [3, 0, 0] }),
    ];
    const { owners } = buildPartSelectionIndex(parts);

    // The bolt is not relief itself, but it rides relief that rides the body —
    // presenting it as its own component would promise a separation the slider
    // can never deliver.
    expect(owners.boltHead).toBe('body');
    expect(computeExplodeLayout(parts, 1).offsets.boltHead).toBeUndefined();
  });

  it('keeps a non-relief child selectable in its own right', () => {
    const { owners, ancestry } = buildPartSelectionIndex([
      part('body', { children: [part('handle')] }),
    ]);

    expect(owners.handle).toBe('handle');
    expect(ancestry.handle).toEqual(['body', 'handle']);
    // Subtree highlight is an ancestry membership test.
    expect(ancestry.handle.includes('body')).toBe(true);
    expect(ancestry.body.includes('handle')).toBe(false);
  });

  it('falls back to the part id when a part has no readable name', () => {
    const { names } = buildPartSelectionIndex([part('bolt', { name: '' })]);
    expect(names.bolt).toBe('bolt');
  });
});

describe('computeExplodeLayout', () => {
  it('leaves the model assembled at amount 0', () => {
    const layout = computeExplodeLayout([part('left', { position: [-1, 0, 0] }), part('right', { position: [1, 0, 0] })], 0);
    expect(layout.offsets).toEqual({});
    expect(layout.growth).toBe(1);
  });

  it('scales the layout about the model centre instead of pushing every part the same distance', () => {
    // Three parts strung along X. A uniform outward push would move the outer
    // two by the same amount and never open the gap the middle one sits in.
    const layout = computeExplodeLayout([
      part('near', { position: [0, 0, 0] }),
      part('middle', { position: [1, 0, 0] }),
      part('far', { position: [4, 0, 0] }),
    ], 1);

    const near = magnitude(offsetOf(layout, 'near'));
    const middle = magnitude(offsetOf(layout, 'middle'));
    const far = magnitude(offsetOf(layout, 'far'));

    // Centre is x=2, assembled radius 2: displacement grows with distance from
    // the centre rather than being one shared step.
    expect(far).toBeCloseTo((2 * (EXPLODE_LAYOUT_SCALE - 1)) + (2 * EXPLODE_BASE_CLEARANCE), 6);
    expect(middle).toBeCloseTo((1 * (EXPLODE_LAYOUT_SCALE - 1)) + (2 * EXPLODE_BASE_CLEARANCE), 6);
    expect(far).toBeGreaterThan(middle);
    expect(near).toBeCloseTo(far, 6);
    // Directions stay opposite about the centre.
    expect(offsetOf(layout, 'near')[0]).toBeLessThan(0);
    expect(offsetOf(layout, 'far')[0]).toBeGreaterThan(0);
  });

  it('doubles the assembled spread at full explode', () => {
    const parts = [part('left', { position: [-1, 0, 0] }), part('right', { position: [1, 0, 0] })];
    const layout = computeExplodeLayout(parts, 1);

    const rightX = 1 + offsetOf(layout, 'right')[0];
    expect(rightX).toBeCloseTo(EXPLODE_LAYOUT_SCALE + EXPLODE_BASE_CLEARANCE, 6);
    expect(layout.growth).toBeCloseTo(EXPLODE_LAYOUT_SCALE + EXPLODE_BASE_CLEARANCE, 6);
  });

  it('interpolates with the slider amount and clamps out-of-range values', () => {
    const parts = [part('left', { position: [-1, 0, 0] }), part('right', { position: [1, 0, 0] })];
    const half = magnitude(offsetOf(computeExplodeLayout(parts, 0.5), 'right'));
    const full = magnitude(offsetOf(computeExplodeLayout(parts, 1), 'right'));

    expect(half).toBeCloseTo(full / 2, 6);
    expect(magnitude(offsetOf(computeExplodeLayout(parts, 5), 'right'))).toBeCloseTo(full, 6);
    expect(computeExplodeLayout(parts, Number.NaN).offsets).toEqual({});
  });

  it('separates a part sitting on the centre, where the scaling term vanishes', () => {
    const layout = computeExplodeLayout([
      part('left', { position: [-1, 0, 0] }),
      part('core', { position: [0, 0, 0] }),
      part('right', { position: [1, 0, 0] }),
    ], 1);

    // Distance from the centre is 0, so only the base clearance can move it —
    // without that, the core stays buried between its neighbours.
    expect(magnitude(offsetOf(layout, 'core'))).toBeCloseTo(EXPLODE_BASE_CLEARANCE, 6);
  });

  it('spreads coincident centre parts in different directions', () => {
    const layout = computeExplodeLayout([
      part('stackA', { position: [0, 0, 0] }),
      part('stackB', { position: [0, 0, 0] }),
      part('stackC', { position: [0, 0, 0] }),
    ], 1);

    const directions = ['stackA', 'stackB', 'stackC'].map((id) => offsetOf(layout, id).join(','));
    expect(new Set(directions).size).toBe(3);
    for (const id of ['stackA', 'stackB', 'stackC']) {
      expect(magnitude(offsetOf(layout, id))).toBeGreaterThan(0);
    }
    // There is no assembled radius to divide by, but the parts DID move — a
    // growth of exactly 1 would tell the camera nothing changed.
    expect(layout.growth).toBeGreaterThan(1);
  });

  it('never moves relief off the part it rides', () => {
    const layout = computeExplodeLayout([
      part('blade', { position: [-1, 0, 0], children: [part('serrations', { position: [0, 0.5, 0], explodeWithParent: true })] }),
      part('handle', { position: [1, 0, 0] }),
    ], 1);

    expect(layout.unitIds).toEqual(['blade', 'handle']);
    expect(layout.offsets.serrations).toBeUndefined();
    expect(layout.offsets.blade).toBeDefined();
  });

  it('expresses a nested part offset in its own parent space', () => {
    const layout = computeExplodeLayout([
      part('rig', {
        geometry: undefined,
        material: undefined,
        scale: [2, 2, 2],
        children: [part('a', { position: [1, 0, 0] }), part('b', { position: [-1, 0, 0] })],
      }),
    ], 1);

    // `a` sits at world x=2 under a 2x-scaled parent. The world displacement is
    // 2.36, so the offset added to its own `position` must be half that.
    expect(offsetOf(layout, 'a')[0]).toBeCloseTo(((2 * (EXPLODE_LAYOUT_SCALE - 1)) + (2 * EXPLODE_BASE_CLEARANCE)) / 2, 6);
    expect(layout.offsets.rig).toBeUndefined();
  });

  it('does nothing for a model with a single moving part', () => {
    const layout = computeExplodeLayout([part('solo', { position: [3, 0, 0] })], 1);
    expect(layout.offsets).toEqual({});
    expect(layout.unitIds).toEqual(['solo']);
    expect(layout.growth).toBe(1);
  });

  it('tolerates a missing or empty part list', () => {
    expect(computeExplodeLayout(undefined, 1).unitIds).toEqual([]);
    expect(computeExplodeLayout([], 1).offsets).toEqual({});
    expect(buildPartSelectionIndex(undefined).owners).toEqual({});
  });
});
// @vitest-environment node
