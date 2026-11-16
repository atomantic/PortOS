/**
 * Disassembly + part-picking maths for the procedural sculpt spec
 * (`server/lib/threejsModel.js`), shared by the Three.js Models preview.
 *
 * Explode and the picker MUST agree on what "a part" is — if they disagree,
 * both are wrong (you separate one thing and select another). That single
 * definition lives here:
 *
 * - A part flagged `explodeWithParent` is **surface relief** (serrations, stria,
 *   trim, port floors). It rides its parent: it never moves on its own, and a
 *   click on it resolves up to the part it belongs to. Without this, a
 *   disassembly shatters into a comb of loose slivers. (Relief with no parent to
 *   ride is a contradiction the schema allows — a root-level flagged part is
 *   treated as an ordinary part, exactly as the picker self-owns it.)
 * - Every other part that carries its own geometry is a **movable unit**, which
 *   is also precisely what the picker selects. That equivalence is the whole
 *   point: the things you can take apart and the things you can click are the
 *   same set.
 * - A part whose (non-relief) descendants carry geometry is additionally a
 *   **container** — it is descended through, so those descendants are units of
 *   their own. A container that also has its own geometry moves that geometry
 *   (and its relief) as a unit while its children move independently; the
 *   offset for it therefore applies to the mesh inside the part, not to the
 *   part's group, which would drag every child along with it.
 * - A part with no geometry anywhere in its subtree moves nothing and is not a
 *   unit — an empty organizational group must not drag the model centre.
 *
 * Separation is a layout **scale about the model centre**, not a uniform outward
 * push: pushing every part the same distance slides the arrangement without ever
 * opening a gap between neighbours, so parts that touched still touch. Each
 * unit's offset from the centre is scaled (≈2x at full explode) plus a base
 * clearance, so parts sitting near the centre — where the scaling term vanishes —
 * still separate.
 */

import * as THREE from 'three';

/** Layout size at full explode, as a multiple of the assembled layout. */
export const EXPLODE_LAYOUT_SCALE = 2;

/** Extra separation at full explode, as a fraction of the assembled radius. */
export const EXPLODE_BASE_CLEARANCE = 0.18;

const EPSILON = 1e-9;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const clamp01 = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const childrenOf = (part) => (Array.isArray(part?.children) ? part.children : []);

/** Surface relief: rides its parent for both movement and selection. */
export const isReliefPart = (part) => part?.explodeWithParent === true;

// Relief is deliberately invisible here: a leaf whose only geometry-bearing
// children are relief is still a leaf, because that relief moves with it.
const carriesMovableGeometry = (part) => {
  if (isReliefPart(part)) return false;
  if (part?.geometry) return true;
  return childrenOf(part).some(carriesMovableGeometry);
};

/** True when a part is descended through rather than moved as one unit. */
export const isContainerPart = (part) => childrenOf(part).some(carriesMovableGeometry);

const localMatrix = (part) => {
  const position = new THREE.Vector3(...(part?.position || [0, 0, 0]));
  const euler = new THREE.Euler(...(part?.rotationDegrees || [0, 0, 0]).map((degrees) => THREE.MathUtils.degToRad(degrees)));
  const scale = new THREE.Vector3(...(part?.scale || [1, 1, 1]));
  return new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromEuler(euler), scale);
};

/**
 * Walk the tree to the parts that actually move, carrying each one's model-space
 * position and the basis its offset has to be expressed in.
 *
 * `onMesh` distinguishes the two places an offset can land: a plain unit moves
 * its whole group (offset in the PARENT's space, added to `position`), while a
 * container that has geometry of its own moves only that geometry (offset in
 * its OWN space, applied to a group around the mesh) so its child units stay
 * free to move independently.
 */
const collectExplodeUnits = (parts) => {
  const units = [];
  const walk = (list, parentMatrix, hasOwner) => {
    for (const part of list || []) {
      // Relief rides its parent — unless there is no parent to ride, which the
      // picker also treats as an ordinary part.
      if (isReliefPart(part) && hasOwner) continue;
      const matrix = parentMatrix.clone().multiply(localMatrix(part));
      const container = isContainerPart(part);
      if (part?.geometry) {
        units.push({
          id: part.id,
          position: new THREE.Vector3().setFromMatrixPosition(matrix),
          basis: container ? matrix : parentMatrix,
          onMesh: container,
        });
      }
      if (container) walk(childrenOf(part), matrix, true);
    }
  };
  walk(parts, new THREE.Matrix4(), false);
  return units;
};

// Parts stacked exactly on the centre have no outward direction of their own.
// Spread them deterministically (Fibonacci sphere) so a symmetric model still
// comes apart instead of every centre part translating together.
const fallbackDirection = (index, count) => {
  const y = count > 1 ? 1 - ((2 * index) / (count - 1)) : 0;
  const radius = Math.sqrt(Math.max(0, 1 - (y * y)));
  const theta = GOLDEN_ANGLE * index;
  const direction = new THREE.Vector3(Math.cos(theta) * radius, y, Math.sin(theta) * radius);
  return direction.lengthSq() > EPSILON ? direction.normalize() : new THREE.Vector3(0, 1, 0);
};

// A world-space delta becomes a local delta through the inverse of the frame it
// will be applied in. A degenerate (zero-scaled) frame has no inverse — fall
// back to the world delta rather than emitting NaN positions.
const toLocalDelta = (delta, frame) => {
  const basis = new THREE.Matrix3().setFromMatrix4(frame);
  if (Math.abs(basis.determinant()) < EPSILON) return delta.clone();
  return delta.clone().applyMatrix3(basis.clone().invert());
};

/**
 * Explode layout for a spec's parts at `amount` (0 assembled → 1 fully apart).
 *
 * Returns `offsets` (added to a unit's own `position`), `meshOffsets` (applied
 * to a group around a container's own geometry, so moving it does not drag the
 * container's child units), the ids of the units that moved, and `growth` — how
 * much the layout actually grew, measured from the moved parts rather than
 * guessed, so the camera re-fits on real change instead of every slider tick.
 *
 * Both maps are null-prototype: part ids are provider-authored and the schema
 * happily accepts `toString` or `constructor`, which on a plain object would
 * read back an inherited function and produce NaN positions.
 */
export function computeExplodeLayout(parts, amount = 0) {
  const units = collectExplodeUnits(parts);
  const unitIds = units.map((unit) => unit.id);
  const progress = clamp01(amount);
  // One unit has nothing to separate from, and any offset would just translate
  // the whole model out of frame.
  if (progress <= 0 || units.length < 2) {
    return { offsets: Object.create(null), meshOffsets: Object.create(null), unitIds, growth: 1 };
  }

  const box = new THREE.Box3();
  for (const unit of units) box.expandByPoint(unit.position);
  const centre = box.getCenter(new THREE.Vector3());
  const assembledRadius = units.reduce((max, unit) => Math.max(max, unit.position.distanceTo(centre)), 0);

  const offsets = Object.create(null);
  const meshOffsets = Object.create(null);
  let explodedRadius = 0;
  units.forEach((unit, index) => {
    const delta = unit.position.clone().sub(centre);
    const distance = delta.length();
    const direction = distance > EPSILON ? delta.clone().divideScalar(distance) : fallbackDirection(index, units.length);
    // Scale the offset about the centre (the term that opens gaps between
    // neighbours), then add the clearance that covers parts at the centre.
    const scaled = distance * (EXPLODE_LAYOUT_SCALE - 1) * progress;
    const clearance = (assembledRadius || 1) * EXPLODE_BASE_CLEARANCE * progress;
    const worldOffset = direction.multiplyScalar(scaled + clearance);
    explodedRadius = Math.max(explodedRadius, unit.position.clone().add(worldOffset).distanceTo(centre));
    const local = toLocalDelta(worldOffset, unit.basis).toArray();
    if (unit.onMesh) meshOffsets[unit.id] = local;
    else offsets[unit.id] = local;
  });

  return {
    offsets,
    meshOffsets,
    unitIds,
    // Units stacked on one point have no assembled radius to grow FROM, but the
    // clearance still moved them — report absolute growth there so the camera
    // re-fit still fires instead of reading as "nothing changed".
    growth: assembledRadius > EPSILON ? explodedRadius / assembledRadius : 1 + explodedRadius,
  };
}

/**
 * Flatten the part tree into the lookups the picker needs.
 *
 * - `owners[id]` — the part a click on `id` selects: itself, or the nearest
 *   non-relief ancestor when `id` is surface relief.
 * - `ancestry[id]` — root-to-self id chain, so "is this part inside the
 *   selection?" (subtree highlight) is a membership test.
 * - `names[id]` — readable part name for the selection label.
 *
 * Null-prototype for the same reason the layout maps are: a provider may name a
 * part `toString`, and an inherited hit would resolve a click to a function.
 */
export function buildPartSelectionIndex(parts) {
  const owners = Object.create(null);
  const ancestry = Object.create(null);
  const names = Object.create(null);
  // "Riding" is sticky: the layout skips a relief part's whole subtree, so
  // anything under it must resolve to the same owner. Without that, a plain part
  // nested under relief would present as its own component that the slider can
  // never separate — the exact disagreement this module exists to prevent. It
  // starts only where relief actually rides something: root-level relief has no
  // parent, so the layout treats it (and its children) as ordinary parts.
  const walk = (list, chain, owner, insideRelief) => {
    for (const part of list || []) {
      if (!part?.id) continue;
      const selfChain = [...chain, part.id];
      const riding = insideRelief || (isReliefPart(part) && owner !== null);
      const selfOwner = riding ? (owner ?? part.id) : part.id;
      owners[part.id] = selfOwner;
      ancestry[part.id] = selfChain;
      names[part.id] = part.name || part.id;
      walk(childrenOf(part), selfChain, selfOwner, riding);
    }
  };
  walk(parts, [], null, false);
  return { owners, ancestry, names };
}
