/**
 * Physical-conformance audit gate for an already-validated Three.js scene spec.
 *
 * Checks static assemblies and animated clips across key poses for:
 * 1. `floating-part`: Parts touching no parent, sibling, joint, attachment, or ground surface.
 * 2. `buried-geometry`: Parts swallowed completely or heavily inside another part without hierarchy/attachment exemption.
 * 3. `coplanar-surface`: Sibling or unrelated part pairs sharing a near-coplanar surface (z-fighting).
 * 4. `unprovenanced-transition`: Animated parts that pop into existence in open space without emerging from a parent or ground level.
 * 5. `nonuniform-parent-scale`: A non-relief child inherits a parent's anisotropic scale and may be distorted.
 * 6. `unanchored-attachment`: A part declared as carried that names nothing it is carried by.
 * 7. `attachment-far-from-anchor`: A declared attachment measured away from the anchor the spec says it hangs from.
 * 8. `bilateral-mirror-scale`: One half of a named left/right pair mirrored by negating a scale component.
 * 9. `bilateral-pair-same-side`: A named left/right pair that never crosses the lateral plane.
 * 10. `bilateral-chirality`: A named left/right pair mirrored by a 180-degree yaw instead of a lateral reflection.
 * 11. `straight-swept-path`: A part declared as a curved form built from a sweep that never bends.
 *
 * Checks 6 and 7 exist because `floating-part` and `buried-geometry` both miss
 * the same defect: a hat that belongs behind the shoulders but is authored at
 * hip height touches its neighbours, so nothing calls it floating, and it is not
 * contained by anything, so nothing calls it buried. Only the declared
 * relationship to its anchor makes the position wrong — which is why an
 * attachment whose anchor geometry cannot be measured is reported as unmeasured
 * rather than allowed to read as clean.
 * Checks 8-10 exist because every bounds-based check above is blind to
 * handedness: a hand spun around the vertical axis, or scaled by -1 in X,
 * occupies exactly the same box as a correctly reflected one. Only the
 * transform that placed it says which way round the limb is built.
 * Check 11 covers the same blind spot in one more dimension: a horn swept along
 * a straight run of control points has a perfectly reasonable bounding box,
 * penetrates nothing, and touches its parent, so every check above passes it.
 * Only the shape of the swept path itself says it never curves.

 */

import {
  CURVED_OUTLINE_MIN_CONCAVE_TURN_DEGREES,
  SWEPT_ARC_MIN_SPAN_DEGREES,
  collectDeclaredCurvedParts,
  evaluateSweptGeometryCurvature,
  isThreejsAttachmentAnchored,
  listSpecNames,
  resolveThreejsAttachments,
} from './threejsModel.js';

const EPSILON = 1e-4;
const COPLANAR_TOLERANCE = 1e-3;
const TOUCH_TOLERANCE = 0.02;
const MAX_AUDIT_POSES = 16;
// One percent anisotropy is small enough to ignore authoring noise while still
// catching the intentional shape-squashing that distorts a child hierarchy.
const NONUNIFORM_SCALE_TOLERANCE = 0.01;
const ANISOTROPY_COMPARISON_TOLERANCE = 0.01;
// A mirrored limb is REFLECTED across the lateral plane (x = 0). Two other
// transforms land the part in roughly the right place while inverting its
// handedness: a 180-degree yaw about the vertical axis, and a negated scale
// component. Both are what turn a right hand into a left hand with the thumb
// pointing backward, so both are named explicitly rather than measured as a
// generic bounds defect — the bounding boxes are identical either way.
const LATERAL_REFLECTION = [-1, 0, 0, 0, 1, 0, 0, 0, 1];
const VERTICAL_YAW_180 = [-1, 0, 0, 0, 1, 0, 0, 0, -1];
const CHIRALITY_LINEAR_TOLERANCE = 1e-3;
const CHIRALITY_POSITION_TOLERANCE = 1e-3;
// A reflected pair is compared with a tolerance that grows with how far the
// pair sits from the lateral plane, so a limb two units out is not reported for
// authoring noise that a limb near the centreline would never produce.
const CHIRALITY_POSITION_RELATIVE_TOLERANCE = 0.02;

const degreesToRadians = (degrees) => (degrees * Math.PI) / 180;

const rotationMatrix = ([xDegrees, yDegrees, zDegrees]) => {
  const [c1, s1] = [Math.cos(degreesToRadians(xDegrees)), Math.sin(degreesToRadians(xDegrees))];
  const [c2, s2] = [Math.cos(degreesToRadians(yDegrees)), Math.sin(degreesToRadians(yDegrees))];
  const [c3, s3] = [Math.cos(degreesToRadians(zDegrees)), Math.sin(degreesToRadians(zDegrees))];
  return [
    c2 * c3, -c2 * s3, s2,
    (c1 * s3) + (s1 * c3 * s2), (c1 * c3) - (s1 * s3 * s2), -s1 * c2,
    (s1 * s3) - (c1 * c3 * s2), (s1 * c3) + (c1 * s3 * s2), c1 * c2,
  ];
};

const multiplyLinear = (a, b) => {
  const out = new Array(9);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      out[(row * 3) + column] = (a[row * 3] * b[column])
        + (a[(row * 3) + 1] * b[3 + column])
        + (a[(row * 3) + 2] * b[6 + column]);
    }
  }
  return out;
};

const applyLinear = (linear, [x, y, z]) => [
  (linear[0] * x) + (linear[1] * y) + (linear[2] * z),
  (linear[3] * x) + (linear[4] * y) + (linear[5] * z),
  (linear[6] * x) + (linear[7] * y) + (linear[8] * z),
];

const applyTransform = (transform, point) => {
  const rotated = applyLinear(transform.linear, point);
  return [
    rotated[0] + transform.translation[0],
    rotated[1] + transform.translation[1],
    rotated[2] + transform.translation[2],
  ];
};

const IDENTITY_TRANSFORM = { linear: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] };

const composeTransform = (parent, position, rotationDegrees, scale) => {
  const rotation = rotationMatrix(rotationDegrees || [0, 0, 0]);
  const [sx, sy, sz] = scale || [1, 1, 1];
  const local = [
    rotation[0] * sx, rotation[1] * sy, rotation[2] * sz,
    rotation[3] * sx, rotation[4] * sy, rotation[5] * sz,
    rotation[6] * sx, rotation[7] * sy, rotation[8] * sz,
  ];
  const pos = position || [0, 0, 0];
  const offset = applyLinear(parent.linear, pos);
  return {
    linear: multiplyLinear(parent.linear, local),
    translation: [
      offset[0] + parent.translation[0],
      offset[1] + parent.translation[1],
      offset[2] + parent.translation[2],
    ],
  };
};

function getLocalBounds(geometry) {
  if (!geometry) return null;
  switch (geometry.type) {
    case 'box': {
      const [x, y, z] = [geometry.width / 2, geometry.height / 2, geometry.depth / 2];
      return [[-x, -y, -z], [x, y, z]];
    }
    case 'sphere': {
      const r = geometry.radius;
      return [[-r, -r, -r], [r, r, r]];
    }
    case 'cylinder':
    case 'cone': {
      const top = geometry.type === 'cone' ? 0 : (geometry.radiusTop ?? geometry.radius);
      const bottom = geometry.type === 'cone' ? geometry.radius : (geometry.radiusBottom ?? geometry.radius);
      const half = geometry.height / 2;
      const widest = Math.max(top, bottom);
      return [[-widest, -half, -widest], [widest, half, widest]];
    }
    case 'capsule': {
      const r = geometry.radius;
      const half = geometry.length / 2;
      return [[-r, -(half + r), -r], [r, half + r, r]];
    }
    case 'torus': {
      const outer = geometry.radius + geometry.tube;
      return [[-outer, -outer, -geometry.tube], [outer, outer, geometry.tube]];
    }
    case 'lathe': {
      const points = geometry.points || [];
      let maxR = 0;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const [x, y] of points) {
        maxR = Math.max(maxR, Math.abs(x));
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      if (!Number.isFinite(minY)) { minY = -1; maxY = 1; maxR = 1; }
      return [[-maxR, minY, -maxR], [maxR, maxY, maxR]];
    }
    case 'extrude': {
      const outline = geometry.outline || [];
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const [x, y] of outline) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      if (!Number.isFinite(minX)) { minX = 0; maxX = 1; minY = 0; maxY = 1; }
      return [[minX, minY, 0], [maxX, maxY, geometry.depth || 1]];
    }
    case 'tube': {
      const path = geometry.path || [];
      const r = geometry.radius || 0.1;
      let minX = Infinity; let maxX = -Infinity;
      let minY = Infinity; let maxY = -Infinity;
      let minZ = Infinity; let maxZ = -Infinity;
      for (const [x, y, z] of path) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      if (!Number.isFinite(minX)) { minX = 0; maxX = 1; minY = 0; maxY = 1; minZ = 0; maxZ = 1; }
      return [[minX - r, minY - r, minZ - r], [maxX + r, maxY + r, maxZ + r]];
    }
    case 'custom': {
      const vertices = geometry.vertices || [];
      let minX = Infinity; let maxX = -Infinity;
      let minY = Infinity; let maxY = -Infinity;
      let minZ = Infinity; let maxZ = -Infinity;
      for (let i = 0; i < vertices.length; i += 3) {
        const x = vertices[i]; const y = vertices[i + 1]; const z = vertices[i + 2];
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      if (!Number.isFinite(minX)) { minX = -1; maxX = 1; minY = -1; maxY = 1; minZ = -1; maxZ = 1; }
      return [[minX, minY, minZ], [maxX, maxY, maxZ]];
    }
    default:
      return null;
  }
}

function getWorldAABB(localBounds, transform) {
  const [[minX, minY, minZ], [maxX, maxY, maxZ]] = localBounds;
  const corners = [
    [minX, minY, minZ], [minX, minY, maxZ], [minX, maxY, minZ], [minX, maxY, maxZ],
    [maxX, minY, minZ], [maxX, minY, maxZ], [maxX, maxY, minZ], [maxX, maxY, maxZ],
  ].map((p) => applyTransform(transform, p));

  return [0, 1, 2].map((axis) => [
    Math.min(...corners.map((c) => c[axis])),
    Math.max(...corners.map((c) => c[axis])),
  ]);
}

function aabbDistance(a, b) {
  const dx = Math.max(0, a[0][0] - b[0][1], b[0][0] - a[0][1]);
  const dy = Math.max(0, a[1][0] - b[1][1], b[1][0] - a[1][1]);
  const dz = Math.max(0, a[2][0] - b[2][1], b[2][0] - a[2][1]);
  return Math.hypot(dx, dy, dz);
}

function aabbContains(container, subject, tolerance = EPSILON) {
  return [0, 1, 2].every((axis) => (
    subject[axis][0] >= container[axis][0] - tolerance
    && subject[axis][1] <= container[axis][1] + tolerance
  ));
}

function faceAreaOverlap2D(minA1, maxA1, minA2, maxA2, minB1, maxB1, minB2, maxB2) {
  const overlap1 = Math.max(0, Math.min(maxA1, maxB1) - Math.max(minA1, minB1));
  const overlap2 = Math.max(0, Math.min(maxA2, maxB2) - Math.max(minA2, minB2));
  return overlap1 * overlap2;
}

const isTransparent = (material) => Boolean(material)
  && ((material.transparent === true && (material.opacity ?? 1) < 1) || (material.transmission ?? 0) > 0);

function getPoseStateResolver(clip, timeSeconds) {
  const sequences = Array.isArray(clip?.sequences) ? clip.sequences : [];

  const getChannelValue = (sequence, channel, t) => {
    const range = sequence.channels?.[channel];
    if (!range) return null;
    if (channel === 'visible' || channel === 'opacity') {
      if (t >= sequence.endSeconds) return range.to;
      if (t < sequence.startSeconds) return range.from;
      if (channel === 'visible') return range.to;
    }
    if (t <= sequence.startSeconds) return range.from;
    if (t >= sequence.endSeconds) return range.to;

    const duration = sequence.endSeconds - sequence.startSeconds;
    const progress = duration > 0 ? (t - sequence.startSeconds) / duration : 1;
    let eased = progress;
    if (sequence.easing === 'easeIn') eased = progress * progress;
    else if (sequence.easing === 'easeOut') eased = progress * (2 - progress);
    else if (sequence.easing === 'easeInOut') eased = progress < 0.5 ? 2 * progress * progress : -1 + ((4 - (2 * progress)) * progress);

    if (Array.isArray(range.from) && Array.isArray(range.to)) {
      return range.from.map((v, i) => v + ((range.to[i] - v) * eased));
    }
    if (typeof range.from === 'number' && typeof range.to === 'number') {
      return range.from + ((range.to - range.from) * eased);
    }
    return range.to;
  };

  const partSequences = new Map();
  for (const seq of sequences) {
    if (!seq.partId) continue;
    const list = partSequences.get(seq.partId) || [];
    list.push(seq);
    partSequences.set(seq.partId, list);
  }

  return (part) => {
    const seqs = partSequences.get(part.id) || [];
    let pos = part.position || [0, 0, 0];
    let rot = part.rotationDegrees || [0, 0, 0];
    let sca = part.scale || [1, 1, 1];
    let vis = part.visible !== false;
    let opac = part.opacity ?? 1;

    for (const channel of ['position', 'rotationDegrees', 'scale', 'visible', 'opacity']) {
      const drivingSeqs = seqs.filter((s) => s.channels?.[channel] && s.startSeconds <= timeSeconds);
      if (drivingSeqs.length > 0) {
        drivingSeqs.sort((a, b) => a.startSeconds - b.startSeconds);
        const active = drivingSeqs[drivingSeqs.length - 1];
        const val = getChannelValue(active, channel, timeSeconds);
        if (val !== null) {
          if (channel === 'position') pos = val;
          else if (channel === 'rotationDegrees') rot = val;
          else if (channel === 'scale') sca = val;
          else if (channel === 'visible') vis = Boolean(val);
          else if (channel === 'opacity') opac = Number(val);
        }
      }
    }
    return { position: pos, rotationDegrees: rot, scale: sca, visible: vis, opacity: opac };
  };
}

function collectPoseVolumes(spec, getPartState) {
  const volumes = [];
  // Every part, not only the ones that carry geometry: a socket hangs off its
  // parent part's world transform, and that parent is routinely a bare group.
  const transformsByPartId = new Map();
  const walk = (part, parentTransform, ancestorIds) => {
    const state = getPartState ? getPartState(part) : {
      position: part.position,
      rotationDegrees: part.rotationDegrees,
      scale: part.scale,
      visible: part.visible !== false,
      opacity: part.opacity ?? 1,
    };

    const transform = composeTransform(parentTransform, state.position, state.rotationDegrees, state.scale);
    transformsByPartId.set(part.id, transform);
    const localBounds = getLocalBounds(part.geometry);

    if (localBounds) {
      const worldBounds = getWorldAABB(localBounds, transform);
      volumes.push({
        id: part.id,
        name: part.name || part.id,
        geometry: part.geometry,
        materialId: part.material || null,
        explodeWithParent: part.explodeWithParent === true,
        ancestorIds,
        visible: state.visible,
        opacity: state.opacity,
        worldBounds,
      });
    }

    for (const child of part.children || []) {
      walk(child, transform, [...ancestorIds, part.id]);
    }
  };

  for (const part of spec?.parts || []) {
    walk(part, IDENTITY_TRANSFORM, []);
  }

  return { volumes, transformsByPartId };
}

const flattenParts = (parts) => {
  const flattened = [];
  const walk = (list) => {
    for (const part of list || []) {
      flattened.push(part);
      walk(part.children);
    }
  };
  walk(parts);
  return flattened;
};

const normalizeScale = (scale) => (
  Array.isArray(scale) && scale.length === 3 && scale.every((value) => Number.isFinite(value))
    ? scale
    : [1, 1, 1]
);

const getScaleAnisotropy = (scale) => {
  const normalized = normalizeScale(scale);
  const absolute = normalized.map((value) => Math.abs(value));
  const minimum = Math.min(...absolute);
  const maximum = Math.max(...absolute);
  const ratio = maximum / Math.max(minimum, EPSILON);
  if (ratio <= 1 + NONUNIFORM_SCALE_TOLERANCE) return null;
  return { scale: normalized, ratio };
};

const formatScale = (scale) => `[${scale.map((value) => Number(value.toFixed(4))).join(', ')}]`;

const formatNames = (names) => listSpecNames(names.map((name) => `"${name}"`));

const collectNonReliefDescendants = (part) => {
  const descendants = [];
  const walk = (children) => {
    for (const child of children || []) {
      if (child.explodeWithParent === true) continue;
      if (child.geometry) {
        descendants.push({ id: child.id, name: child.name || child.id });
      }
      walk(child.children);
    }
  };
  walk(part.children);
  return descendants;
};

const buildNonuniformParentScaleFinding = (part, scaleSamples, context = {}) => {
  const descendants = collectNonReliefDescendants(part);
  if (descendants.length === 0) return null;

  const normalizedSamples = scaleSamples.map((sample) => ({
    ...sample,
    anisotropy: getScaleAnisotropy(sample.scale),
  }));
  const analyzedSamples = normalizedSamples
    .filter((sample) => sample.anisotropy);
  if (analyzedSamples.length === 0) return null;

  const mostAnisotropic = analyzedSamples.reduce((best, sample) => (
    sample.anisotropy.ratio > best.anisotropy.ratio ? sample : best
  ));
  const sequenceIds = [...new Set(analyzedSamples.map((sample) => sample.sequenceId).filter(Boolean))];
  const { clipName, ...metadata } = context;
  const descendantNames = descendants.map((descendant) => descendant.name);
  const scope = clipName
    ? `In clip "${clipName}", part "${part.name || part.id}" reaches authored non-uniform scale ${formatScale(mostAnisotropic.anisotropy.scale)}`
    : `Part "${part.name || part.id}" is authored with non-uniform scale ${formatScale(mostAnisotropic.anisotropy.scale)}`;
  const sequenceSuffix = sequenceIds.length > 0 ? ` in scale sequence${sequenceIds.length === 1 ? '' : 's'} ${formatNames(sequenceIds)}` : '';

  return {
    code: 'nonuniform-parent-scale',
    severity: 'warning',
    ...metadata,
    sequenceId: mostAnisotropic.sequenceId ?? metadata.sequenceId,
    sequenceIds,
    partIds: [part.id, ...descendants.map((descendant) => descendant.id)],
    affectedDescendantNames: descendantNames,
    anisotropyRatio: mostAnisotropic.anisotropy.ratio,
    message: `${scope} (maximum anisotropy ratio ${mostAnisotropic.anisotropy.ratio.toFixed(2)})${sequenceSuffix}, which cascades onto non-relief descendants ${formatNames(descendantNames)} and can distort them.`,
  };
};

const unionBounds = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  return [0, 1, 2].map((axis) => [Math.min(a[axis][0], b[axis][0]), Math.max(a[axis][1], b[axis][1])]);
};

const isInSubtree = (volume, partId) => volume.id === partId || volume.ancestorIds.includes(partId);

/**
 * World bounds for one part INCLUDING its descendants, optionally minus one
 * nested subtree.
 *
 * An anchor is routinely a bare group whose surface is entirely in its children
 * — "head" holding a skull and a jaw — so measuring only the part's own geometry
 * would report a hat as unmeasurable against the head it plainly sits on. But an
 * attachment is usually parented UNDER its anchor, and folding the attachment's
 * own geometry into the anchor's bounds would make every nested attachment
 * measure zero units away from itself: the check would pass a hat at hip height
 * precisely because it is a child of the head. Hence the exclusion.
 */
const subtreeBounds = (volumes, partId, excludePartId = null) => {
  let bounds = null;
  for (const volume of volumes) {
    if (!isInSubtree(volume, partId)) continue;
    if (excludePartId && isInSubtree(volume, excludePartId)) continue;
    bounds = unionBounds(bounds, volume.worldBounds);
  }
  return bounds;
};

// A socket is a point, and `aabbDistance` already measures box-to-box, so the
// point rides in as a degenerate box rather than earning a second routine.
const pointBounds = ([x, y, z]) => [[x, x], [y, y], [z, z]];

const formatOffset = (value) => Number(value.toFixed(3));

/**
 * Measure every anchored attachment against the thing it says it hangs from, in
 * one pose.
 *
 * @returns {{findings: Array, unmeasured: Array<{partId: string, anchorPartId: string|null,
 *   anchorSocket: string|null, reason: string}>, measured: Set<string>}}
 */
function measureAttachmentAnchors({
  attachments,
  volumes,
  transformsByPartId,
  socketsByName,
  namesByPartId,
  context = {},
}) {
  const findings = [];
  const unmeasured = [];
  // Which attachments this pose could actually put a number on, so a pose that
  // could not see an anchor never overrides a pose that could.
  const measured = new Set();
  if (attachments.length === 0) return { findings, unmeasured, measured };

  const measurable = volumes.filter((volume) => volume.visible && volume.opacity > 0);
  const label = (partId) => `"${namesByPartId.get(partId) || partId}"`;
  const { clipName, ...metadata } = context;

  for (const attachment of attachments) {
    const attachmentBounds = subtreeBounds(measurable, attachment.partId);
    if (!attachmentBounds) {
      unmeasured.push({
        partId: attachment.partId,
        anchorPartId: attachment.anchorPartId,
        anchorSocket: attachment.anchorSocket,
        reason: 'the attachment has no visible geometry to measure',
      });
      continue;
    }

    let anchorBounds = null;
    let anchorDescription = '';
    if (attachment.anchorSocket) {
      const socket = socketsByName.get(attachment.anchorSocket);
      const transform = socket ? transformsByPartId.get(socket.parentPartId) : null;
      if (transform) {
        anchorBounds = pointBounds(applyTransform(transform, socket.position || [0, 0, 0]));
        anchorDescription = `socket "${attachment.anchorSocket}" on ${label(socket.parentPartId)}`;
      }
    } else if (attachment.anchorPartId) {
      anchorBounds = subtreeBounds(measurable, attachment.anchorPartId, attachment.partId);
      anchorDescription = label(attachment.anchorPartId);
    }

    if (!anchorBounds) {
      unmeasured.push({
        partId: attachment.partId,
        anchorPartId: attachment.anchorPartId,
        anchorSocket: attachment.anchorSocket,
        reason: attachment.anchorSocket
          ? 'the anchor socket could not be located in this pose'
          : 'the anchor part has no visible geometry to measure',
      });
      continue;
    }

    measured.add(attachment.partId);
    const distance = aabbDistance(attachmentBounds, anchorBounds);
    if (distance <= attachment.maxOffset) continue;

    const scope = clipName
      ? `In clip "${clipName}", part ${label(attachment.partId)}`
      : `Part ${label(attachment.partId)}`;
    findings.push({
      code: 'attachment-far-from-anchor',
      // The spec asserted this relationship itself, so a part measured away from
      // its own declared anchor is a stated fact the model does not build.
      severity: 'error',
      ...metadata,
      partIds: attachment.anchorPartId
        ? [attachment.partId, attachment.anchorPartId]
        : [attachment.partId],
      anchorPartId: attachment.anchorPartId,
      anchorSocket: attachment.anchorSocket,
      distance: formatOffset(distance),
      maxOffset: attachment.maxOffset,
      message: `${scope} is declared as an attachment carried by ${anchorDescription}, but it sits ${formatOffset(distance)} units away from it (allowed ${attachment.maxOffset}). Move it onto ${anchorDescription} or re-anchor it to the part it is actually carried by.`,
    });
  }

  return { findings, unmeasured, measured };
}

const collectAnimatedScaleSamples = (part, sequences) => sequences
  .filter((sequence) => sequence.partId === part.id && sequence.channels?.scale)
  .flatMap((sequence) => [
    { scale: sequence.channels.scale.from, sequenceId: sequence.id },
    { scale: sequence.channels.scale.to, sequenceId: sequence.id },
  ]);

// Side tokens are matched as whole identifier tokens, never as substrings: a
// substring match pairs "relay" with "lay" and reads the "l" out of "lamp".
const BILATERAL_SIDE_TOKENS = new Map([
  ['left', 'left'],
  ['l', 'left'],
  ['right', 'right'],
  ['r', 'right'],
]);

// Both camel boundaries, not just the common one: "handL" needs lower-upper,
// and "LHand" needs upper-upper-lower or the whole name reads as one token and
// the pair is never found.
const tokenizeIdentifier = (value) => String(value ?? '')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .split(/[^A-Za-z0-9]+/)
  .filter(Boolean)
  .map((token) => token.toLowerCase());

/**
 * The pairing key for one identifier: its remaining tokens, sorted, so
 * "leftHand", "hand_L", "LHand" and "Hand Left" all key to the same pair.
 *
 * Order is discarded deliberately. A generated spec routinely mixes conventions
 * between the two halves of one pair — "leftFoot" beside "foot_R" — and an
 * ordered key would leave exactly those pairs unchecked. Every other token still
 * has to match as a multiset, so the pairing stays as tight as the names.
 *
 * Returns null when there is no side token, when there are several (a name that
 * says both sides names neither), or when the side token is the whole
 * identifier — a part simply called "left" has no counterpart to be paired with.
 */
const describeBilateralSide = (identifier) => {
  const tokens = tokenizeIdentifier(identifier);
  if (tokens.length < 2) return null;
  const sideIndexes = tokens.reduce((found, token, index) => (
    BILATERAL_SIDE_TOKENS.has(token) ? [...found, index] : found
  ), []);
  if (sideIndexes.length !== 1) return null;
  const [sideIndex] = sideIndexes;
  return {
    key: tokens.filter((_, index) => index !== sideIndex).sort().join('|'),
    side: BILATERAL_SIDE_TOKENS.get(tokens[sideIndex]),
  };
};

/**
 * Group parts into left/right pairs by name (falling back to id).
 *
 * Only an unambiguous one-to-one grouping is returned. Three parts sharing a
 * key — a spec with two "wing-l" variants — cannot say which counterpart each
 * one is meant to mirror, and guessing would report chirality against the wrong
 * limb.
 */
const collectBilateralPairs = (parts) => {
  const groups = new Map();
  for (const part of parts) {
    const descriptor = describeBilateralSide(part.name || part.id)
      || (part.name ? describeBilateralSide(part.id) : null);
    if (!descriptor) continue;
    const group = groups.get(descriptor.key) || { left: [], right: [] };
    group[descriptor.side].push(part);
    groups.set(descriptor.key, group);
  }
  return [...groups.values()]
    .filter((group) => group.left.length === 1 && group.right.length === 1)
    .map((group) => ({ left: group.left[0], right: group.right[0] }));
};

const collectPartChains = (parts) => {
  const chains = new Map();
  const walk = (list, ancestors) => {
    for (const part of list || []) {
      const chain = [...ancestors, part];
      chains.set(part.id, chain);
      walk(part.children, chain);
    }
  };
  walk(parts, []);
  return chains;
};

/**
 * Both halves of a pair placed in the frame of their nearest common ancestor.
 *
 * The lateral plane a pair is mirrored across is the one their shared parent
 * defines, NOT world x = 0. A subject modelled off the origin, or a body yawed
 * to face somewhere other than down +Z, is mirror-symmetric about its own axis
 * and about no world plane at all — comparing it against x = 0 reports every
 * correctly built pair on it. Composing down from the common ancestor cancels
 * that shared placement, and leaves exactly the authored local transforms the
 * refinement feedback asks the next pass to change.
 */
const transformsRelativeToCommonAncestor = (leftChain, rightChain) => {
  let shared = 0;
  while (shared < leftChain.length - 1
    && shared < rightChain.length - 1
    && leftChain[shared] === rightChain[shared]) {
    shared += 1;
  }
  const compose = (chain) => chain.slice(shared).reduce(
    (transform, part) => composeTransform(transform, part.position, part.rotationDegrees, part.scale),
    IDENTITY_TRANSFORM,
  );
  return [compose(leftChain), compose(rightChain)];
};

const determinant3 = (m) => (
  (m[0] * ((m[4] * m[8]) - (m[5] * m[7])))
  - (m[1] * ((m[3] * m[8]) - (m[5] * m[6])))
  + (m[2] * ((m[3] * m[7]) - (m[4] * m[6])))
);

const linearClose = (a, b) => a.every((value, index) => Math.abs(value - b[index]) <= CHIRALITY_LINEAR_TOLERANCE);

const vectorClose = (a, b, tolerance) => a.every((value, index) => Math.abs(value - b[index]) <= tolerance);

const formatVector = (vector) => `[${vector.map(formatOffset).join(', ')}]`;

// Every primitive in this set maps onto itself under a 180-degree yaw, so a lone
// one of them is built identically whether it was reflected or turned around.
// Reporting those would bury the real defects under every blocky limb in the
// catalogue. `extrude`, `tube` and `custom` carry an authored profile that a yaw
// visibly turns around, and any assembly of more than one volume shows the flip
// in where its pieces land.
const YAW_SYMMETRIC_GEOMETRY_TYPES = new Set(['box', 'sphere', 'cylinder', 'cone', 'capsule', 'torus', 'lathe']);

const isYawDistinguishable = (volumes, partId) => {
  const subtree = volumes.filter((volume) => isInSubtree(volume, partId));
  if (subtree.length !== 1) return subtree.length > 1;
  return !YAW_SYMMETRIC_GEOMETRY_TYPES.has(subtree[0].geometry?.type);
};

/**
 * Chirality and symmetry findings for the resting pose.
 *
 * Only the resting pose is audited: which way round a limb is built is authored
 * into the assembly, and a clip that rotates an arm is not a chirality defect.
 *
 * A flipped ORIENTATION is what every finding here turns on. A counterpart
 * merely placed at a different depth is a staggered pose — a figure mid-stride
 * has one hand forward and one back — and reporting that as chirality would ask
 * the next pass to flatten every pose it was asked for. The depth is reported
 * only as corroboration, once the orientation already says the limb is turned
 * around.
 *
 * @returns {Array} findings, at most one per pair
 */
function buildBilateralChiralityFindings({ pairs, chains, volumes }) {
  const findings = [];

  for (const { left, right } of pairs) {
    const leftChain = chains.get(left.id);
    const rightChain = chains.get(right.id);
    if (!leftChain || !rightChain) continue;
    const [leftTransform, rightTransform] = transformsRelativeToCommonAncestor(leftChain, rightChain);

    const leftName = left.name || left.id;
    const rightName = right.name || right.id;
    const partIds = [left.id, right.id];
    const leftPosition = leftTransform.translation;
    const rightPosition = rightTransform.translation;

    // A negated scale component is the one mirror that leaves the bounds
    // untouched and every normal inside out, so it is reported before the
    // orientation comparison — which has no meaning across a handedness flip.
    const leftDeterminant = determinant3(leftTransform.linear);
    const rightDeterminant = determinant3(rightTransform.linear);
    if ((leftDeterminant < 0) !== (rightDeterminant < 0)) {
      const flipped = leftDeterminant < 0 ? leftName : rightName;
      const intact = leftDeterminant < 0 ? rightName : leftName;
      findings.push({
        code: 'bilateral-mirror-scale',
        severity: 'warning',
        partIds,
        message: `Bilateral pair "${leftName}" / "${rightName}" is mirrored by negating a scale component on "${flipped}", which inverts its handedness and face winding relative to "${intact}". Build the pair with positive scale on both sides and reflect the counterpart across the lateral plane instead: position [-x, y, z] with rotation [rx, -ry, -rz].`,
      });
      continue;
    }

    // A pair that never crosses its parent's lateral plane was not mirrored at
    // all — one limb was copied to the other side's name and left where it was.
    const sameSide = Math.sign(leftPosition[0]) === Math.sign(rightPosition[0])
      && Math.min(Math.abs(leftPosition[0]), Math.abs(rightPosition[0])) > TOUCH_TOLERANCE;
    if (sameSide) {
      findings.push({
        code: 'bilateral-pair-same-side',
        severity: 'warning',
        partIds,
        message: `Bilateral pair "${leftName}" / "${rightName}" sits entirely on one side of the lateral plane (both offset from their common parent at x = ${formatOffset(leftPosition[0])} and x = ${formatOffset(rightPosition[0])}), so the pair never straddles the body. Negate the x offset of one of them so each limb sits on its own side.`,
      });
      continue;
    }

    const reflectedLinear = multiplyLinear(multiplyLinear(LATERAL_REFLECTION, leftTransform.linear), LATERAL_REFLECTION);
    if (linearClose(rightTransform.linear, reflectedLinear)) continue;
    // Nothing is reported for a pair that is merely posed differently: an arm
    // raised on one side is legitimate, and only a positively identified yaw is
    // a chirality defect. Both compositions are tested because the yaw is
    // authored either way — as a 180-degree turn of the placed limb (world side)
    // or as a [0, 180, 0] local rotation on the part itself (local side).
    const orientationYawed = isYawDistinguishable(volumes, right.id) && (
      linearClose(rightTransform.linear, multiplyLinear(VERTICAL_YAW_180, leftTransform.linear))
      || linearClose(rightTransform.linear, multiplyLinear(leftTransform.linear, VERTICAL_YAW_180))
    );
    if (!orientationYawed) continue;

    const positionTolerance = Math.max(
      CHIRALITY_POSITION_TOLERANCE,
      CHIRALITY_POSITION_RELATIVE_TOLERANCE * Math.hypot(...leftPosition),
    );
    const reflectedPosition = [-leftPosition[0], leftPosition[1], leftPosition[2]];
    const yawedPosition = [-leftPosition[0], leftPosition[1], -leftPosition[2]];
    const placementYawed = !vectorClose(rightPosition, reflectedPosition, positionTolerance)
      && Math.abs(leftPosition[2]) > positionTolerance
      && vectorClose(rightPosition, yawedPosition, positionTolerance);

    findings.push({
      code: 'bilateral-chirality',
      severity: 'warning',
      partIds,
      message: `Bilateral pair "${leftName}" / "${rightName}" is mirrored by a 180° yaw about the vertical axis rather than a reflection across the lateral plane: "${rightName}" carries the orientation of "${leftName}" turned around rather than reflected${placementYawed ? `, and sits at ${formatVector(rightPosition)} where a reflection would place it at ${formatVector(reflectedPosition)}` : ''}. A yaw preserves handedness instead of inverting it, which is what produces backward-facing hands and feet with the big toe on the outer edge. Reflect the counterpart instead: position [-x, y, z] with rotation [rx, -ry, -rz] and positive scale.`,
    });
  }

  return findings;
}

const formatDegrees = (value) => `${Math.round(value)}°`;

/**
 * Report a part the spec declares as a curved form whose sweep never bends.
 *
 * Named or feature-declared curvature is the whole trigger: `tube` and `extrude`
 * are the right answer for plenty of straight parts — a rail, a plate, a strut —
 * so a straight sweep is evidence of nothing until the spec says it was meant to
 * turn.
 */
const buildSweptPathCurvatureFindings = (spec, parts) => {
  const partsById = new Map(parts.map((part) => [part.id, part]));
  const findings = [];
  for (const [partId, declaredBy] of collectDeclaredCurvedParts(spec)) {
    const part = partsById.get(partId);
    const curvature = evaluateSweptGeometryCurvature(part?.geometry);
    if (!curvature || !curvature.straight) continue;
    const name = part.name || part.id;
    // Only when the declaration came from somewhere else — repeating the part's
    // own name back at it reads as a stutter.
    const declaration = declaredBy === name ? '' : ` (declared by the feature "${declaredBy}")`;
    const message = curvature.kind === 'tube'
      ? `Part "${name}"${declaration} is a curved form built from a tube whose path ${curvature.arcSpanDegrees > 0 ? `only turns through ${formatDegrees(curvature.arcSpanDegrees)}` : 'runs through collinear control points'}, so it sweeps straight. Sample the intended curve into "path" so consecutive points step around a centre — a horn, tail, hook, or bent conduit needs at least ${formatDegrees(SWEPT_ARC_MIN_SPAN_DEGREES)} of turn — instead of listing points along one line.`
      : `Part "${name}"${declaration} is a curved form built from an extrude whose outline never turns back on itself (${formatDegrees(curvature.concaveTurnDegrees)} of sustained concave turning). An extrude sweeps its outline along a STRAIGHT axis, so the curve has to be in the outline's own silhouette: give it a concave side of at least ${formatDegrees(CURVED_OUTLINE_MIN_CONCAVE_TURN_DEGREES)}, or build the part as a "tube" whose path follows the curve.`;
    findings.push({
      code: 'straight-swept-path',
      severity: 'warning',
      partIds: [partId],
      message,
    });
  }
  return findings;
};

/**
 * @param {object|null} spec a validated Three.js scene spec
 * @returns {{findings: Array, errorCount: number, warningCount: number, noteCount: number,
 *   evaluatedPartCount: number, evaluatedPoseCount: number}}
 */
export function evaluateThreejsPhysicalAudit(spec) {
  if (!spec || !Array.isArray(spec.parts)) {
    return {
      findings: [],
      errorCount: 0,
      warningCount: 0,
      noteCount: 0,
      evaluatedPartCount: 0,
      evaluatedPoseCount: 0,
      unmeasuredAttachments: [],
    };
  }

  const materials = spec.materials && typeof spec.materials === 'object' ? spec.materials : {};
  const declaredAttachments = resolveThreejsAttachments(spec.articulation);
  const anchoredAttachments = declaredAttachments.filter(isThreejsAttachmentAnchored);
  const attachments = new Set(declaredAttachments.map((attachment) => attachment.partId));
  const jointPartIds = new Set((spec.articulation?.joints || []).map((j) => j.partId).filter(Boolean));
  const socketsByName = new Map((spec.sockets || []).map((socket) => [socket.name, socket]));

  const findings = [];
  const seenKeys = new Set();
  const parts = flattenParts(spec.parts);
  const namesByPartId = new Map(parts.map((part) => [part.id, part.name || part.id]));
  const staticScaleFindings = new Map();
  const strongestAnimatedScaleFindings = new Map();

  const addFinding = (finding) => {
    const key = `${finding.code}|${[...finding.partIds].sort().join(',')}|${finding.clipId || ''}|${finding.sequenceId || ''}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    findings.push(finding);
  };

  // 1. Static Resting Pose Evaluation
  const { volumes: staticVolumes, transformsByPartId } = collectPoseVolumes(spec, null);
  const evaluatedPartCount = staticVolumes.length;
  let evaluatedPoseCount = 1;

  // A declaration with no anchor in it cannot be measured at all, so it is
  // reported before any geometry is looked at.
  for (const attachment of declaredAttachments) {
    if (isThreejsAttachmentAnchored(attachment)) continue;
    addFinding({
      code: 'unanchored-attachment',
      severity: 'warning',
      partIds: [attachment.partId],
      message: `Part "${namesByPartId.get(attachment.partId) || attachment.partId}" is declared as a carried attachment but names nothing it is carried by, so nothing ties it to the part it hangs from. Declare it in "attachments" with an "anchorPartId" or "anchorSocket".`,
    });
  }

  const staticAnchorReport = measureAttachmentAnchors({
    attachments: anchoredAttachments,
    volumes: staticVolumes,
    transformsByPartId,
    socketsByName,
    namesByPartId,
  });
  // Accumulated across every pose, and resolved at the end: an attachment
  // measured in ANY pose was checked, so a clip pose that happens to hide the
  // anchor must not retroactively report it as unverified — and an attachment no
  // pose could measure must never read as clean.
  const measuredAnywhere = new Set(staticAnchorReport.measured);
  const unmeasuredByPartId = new Map(staticAnchorReport.unmeasured.map((entry) => [entry.partId, entry]));
  const staticAnchorFailures = new Set();
  for (const finding of staticAnchorReport.findings) {
    staticAnchorFailures.add(finding.partIds[0]);
    addFinding(finding);
  }

  for (const part of parts) {
    const finding = buildNonuniformParentScaleFinding(part, [{ scale: part.scale }]);
    if (finding) {
      staticScaleFindings.set(part.id, finding);
      addFinding(finding);
    }
  }

  const visibleStaticVolumes = staticVolumes.filter((v) => v.visible && v.opacity > 0);

  for (const finding of buildBilateralChiralityFindings({
    pairs: collectBilateralPairs(parts),
    chains: collectPartChains(spec.parts),
    volumes: visibleStaticVolumes,
  })) {
    addFinding(finding);
  }

  for (const finding of buildSweptPathCurvatureFindings(spec, parts)) {
    addFinding(finding);
  }

  // Floating check & Buried & Coplanar on resting pose
  for (let i = 0; i < visibleStaticVolumes.length; i += 1) {
    const subject = visibleStaticVolumes[i];

    // Ground contact check: min Y <= TOUCH_TOLERANCE
    const touchesGround = subject.worldBounds[1][0] <= TOUCH_TOLERANCE;
    const isAttachment = attachments.has(subject.id) || jointPartIds.has(subject.id);
    const hasParent = subject.ancestorIds.length > 0;

    let touchesAnyOther = touchesGround || isAttachment || hasParent;

    for (let j = 0; j < visibleStaticVolumes.length; j += 1) {
      if (i === j) continue;
      const other = visibleStaticVolumes[j];

      // Check distance
      const dist = aabbDistance(subject.worldBounds, other.worldBounds);
      if (dist <= TOUCH_TOLERANCE) {
        touchesAnyOther = true;
      }

      if (i < j) {
        // Buried check (subject inside container or other inside subject)
        const isAncestorChild = subject.ancestorIds.includes(other.id) || other.ancestorIds.includes(subject.id);
        const seeThrough = isTransparent(materials[other.materialId]) || isTransparent(materials[subject.materialId]);

        if (!seeThrough && !isAncestorChild && !attachments.has(subject.id) && !attachments.has(other.id)) {
          if (aabbContains(other.worldBounds, subject.worldBounds)) {
            addFinding({
              code: 'buried-geometry',
              severity: 'error',
              partIds: [subject.id, other.id],
              message: `Part "${subject.name}" is completely buried inside "${other.name}". Move it out to an exposed surface or parent it properly.`,
            });
          } else if (aabbContains(subject.worldBounds, other.worldBounds)) {
            addFinding({
              code: 'buried-geometry',
              severity: 'error',
              partIds: [other.id, subject.id],
              message: `Part "${other.name}" is completely buried inside "${subject.name}". Move it out to an exposed surface or parent it properly.`,
            });
          }
        }

        // Coplanar surface check
        if (!isAncestorChild) {
          for (let axis = 0; axis < 3; axis += 1) {
            const axis1 = (axis + 1) % 3;
            const axis2 = (axis + 2) % 3;

            const planeMatches = Math.abs(subject.worldBounds[axis][0] - other.worldBounds[axis][0]) < COPLANAR_TOLERANCE
              || Math.abs(subject.worldBounds[axis][1] - other.worldBounds[axis][1]) < COPLANAR_TOLERANCE
              || Math.abs(subject.worldBounds[axis][1] - other.worldBounds[axis][0]) < COPLANAR_TOLERANCE
              || Math.abs(subject.worldBounds[axis][0] - other.worldBounds[axis][1]) < COPLANAR_TOLERANCE;

            if (planeMatches) {
              const area = faceAreaOverlap2D(
                subject.worldBounds[axis1][0], subject.worldBounds[axis1][1],
                subject.worldBounds[axis2][0], subject.worldBounds[axis2][1],
                other.worldBounds[axis1][0], other.worldBounds[axis1][1],
                other.worldBounds[axis2][0], other.worldBounds[axis2][1],
              );
              const minArea = Math.min(
                (subject.worldBounds[axis1][1] - subject.worldBounds[axis1][0])
                * (subject.worldBounds[axis2][1] - subject.worldBounds[axis2][0]),
                (other.worldBounds[axis1][1] - other.worldBounds[axis1][0])
                * (other.worldBounds[axis2][1] - other.worldBounds[axis2][0]),
              );

              if (minArea > EPSILON && area / minArea >= 0.25) {
                const axisName = axis === 0 ? 'X' : axis === 1 ? 'Y' : 'Z';
                addFinding({
                  code: 'coplanar-surface',
                  severity: 'warning',
                  partIds: [subject.id, other.id],
                  message: `Parts "${subject.name}" and "${other.name}" share a coplanar surface along the ${axisName} axis, causing z-fighting flickering. Shift one slightly or offset their bounds.`,
                });
              }
            }
          }
        }
      }
    }

    if (!touchesAnyOther) {
      addFinding({
        code: 'floating-part',
        severity: 'warning',
        partIds: [subject.id],
        message: `Part "${subject.name}" floats unattached in space without touching any parent, sibling, joint, or ground surface.`,
      });
    }
  }

  // 2. Animated Clips & Pose Evaluation
  const clips = Array.isArray(spec.animation?.clips) ? spec.animation.clips : [];
  let remainingBudget = MAX_AUDIT_POSES - 1;

  for (const clip of clips) {
    const sequences = Array.isArray(clip.sequences) ? clip.sequences : [];

    for (const part of parts) {
      const scaleSamples = collectAnimatedScaleSamples(part, sequences);
      if (scaleSamples.length > 0) {
        const finding = buildNonuniformParentScaleFinding(part, scaleSamples, {
          clipId: clip.id,
          clipName: clip.name || clip.id,
        });
        if (finding) {
          const current = strongestAnimatedScaleFindings.get(part.id);
          if (!current || finding.anisotropyRatio > current.anisotropyRatio) {
            strongestAnimatedScaleFindings.set(part.id, finding);
          }
        }
      }
    }

    if (remainingBudget <= 0) continue;

    const sampleTimes = new Set([0, clip.durationSeconds || 0]);
    for (const seq of sequences) {
      if (Number.isFinite(seq.startSeconds)) sampleTimes.add(seq.startSeconds);
      if (Number.isFinite(seq.endSeconds)) sampleTimes.add(seq.endSeconds);
    }

    const timesToTest = [...sampleTimes].sort((a, b) => a - b).slice(0, remainingBudget);
    remainingBudget -= timesToTest.length;
    evaluatedPoseCount += timesToTest.length;

    // A clip can carry an attachment away from its anchor without ever breaking
    // the resting pose, so the same measurement runs over the sampled poses —
    // reporting the WORST one per attachment rather than the first, so the
    // refinement feedback names the moment the relationship is most broken.
    if (anchoredAttachments.length > 0) {
      const worstByPartId = new Map();
      for (const timeSeconds of timesToTest) {
        const pose = collectPoseVolumes(spec, getPoseStateResolver(clip, timeSeconds));
        const report = measureAttachmentAnchors({
          attachments: anchoredAttachments,
          volumes: pose.volumes,
          transformsByPartId: pose.transformsByPartId,
          socketsByName,
          namesByPartId,
          context: { clipId: clip.id, clipName: clip.name || clip.id, timeSeconds },
        });
        for (const partId of report.measured) measuredAnywhere.add(partId);
        for (const entry of report.unmeasured) {
          if (!unmeasuredByPartId.has(entry.partId)) unmeasuredByPartId.set(entry.partId, entry);
        }
        for (const finding of report.findings) {
          const partId = finding.partIds[0];
          // The resting pose already reported this attachment; repeating it per
          // clip would bury the clip-only breaks the pose walk exists to find.
          if (staticAnchorFailures.has(partId)) continue;
          const current = worstByPartId.get(partId);
          if (!current || finding.distance > current.distance) worstByPartId.set(partId, finding);
        }
      }
      for (const finding of worstByPartId.values()) addFinding(finding);
    }

    // Check unprovenanced transitions for sequences that toggle visibility/opacity
    for (const seq of sequences) {
      const visCh = seq.channels?.visible;
      const opacCh = seq.channels?.opacity;
      const appears = (visCh && visCh.from === false && visCh.to === true)
        || (opacCh && opacCh.from === 0 && opacCh.to > 0);

      if (appears && seq.startSeconds > 0) {
        const getPoseState = getPoseStateResolver(clip, seq.startSeconds);
        const { volumes: poseVolumes } = collectPoseVolumes(spec, getPoseState);
        const partVolume = poseVolumes.find((v) => v.id === seq.partId);

        if (partVolume) {
          const parentVolume = poseVolumes.find((v) => partVolume.ancestorIds.includes(v.id));
          const touchesGround = partVolume.worldBounds[1][0] <= TOUCH_TOLERANCE;
          const insideParent = parentVolume && aabbDistance(partVolume.worldBounds, parentVolume.worldBounds) <= TOUCH_TOLERANCE;

          if (!touchesGround && !insideParent) {
            addFinding({
              code: 'unprovenanced-transition',
              severity: 'warning',
              partIds: [seq.partId],
              clipId: clip.id,
              sequenceId: seq.id,
              timeSeconds: seq.startSeconds,
              message: `In clip "${clip.name || clip.id}", sequence "${seq.name || seq.id}" makes part "${partVolume.name}" appear at ${seq.startSeconds}s in open air without emerging from a parent part or ground level.`,
            });
          }
        }
      }
    }
  }

  for (const [partId, finding] of strongestAnimatedScaleFindings) {
    const staticFinding = staticScaleFindings.get(partId);
    const staticRatio = staticFinding?.anisotropyRatio || 0;
    if (!staticFinding || finding.anisotropyRatio > staticRatio * (1 + ANISOTROPY_COMPARISON_TOLERANCE)) {
      addFinding(finding);
    }
  }

  const unmeasuredAttachments = [...unmeasuredByPartId.values()]
    .filter((entry) => !measuredAnywhere.has(entry.partId));

  const countBy = (severity) => findings.filter((f) => f.severity === severity).length;

  return {
    findings,
    errorCount: countBy('error'),
    warningCount: countBy('warning'),
    noteCount: countBy('note'),
    evaluatedPartCount,
    evaluatedPoseCount,
    // Never folded into the clean count: an attachment whose anchor could not be
    // measured was not checked, and reporting it as passing is the failure this
    // gate exists to avoid.
    unmeasuredAttachments,
  };
}

/**
 * Default refinement feedback for a physical audit report.
 * Returns '' when there are no actionable errors or warnings.
 *
 * @param {object|null} physicalAudit a stored `evaluateThreejsPhysicalAudit` result
 * @returns {string}
 */
export function buildThreejsPhysicalAuditFeedback(physicalAudit) {
  const actionable = (physicalAudit?.findings || []).filter((f) => f.severity === 'error' || f.severity === 'warning');
  const unmeasured = Array.isArray(physicalAudit?.unmeasuredAttachments) ? physicalAudit.unmeasuredAttachments : [];
  if (actionable.length === 0 && unmeasured.length === 0) return '';
  const hasNonuniformParentScale = actionable.some((finding) => finding.code === 'nonuniform-parent-scale');
  const hasBilateralChirality = actionable.some((finding) => (
    finding.code === 'bilateral-chirality'
    || finding.code === 'bilateral-mirror-scale'
    || finding.code === 'bilateral-pair-same-side'
  ));
  const hasStraightSweptPath = actionable.some((finding) => finding.code === 'straight-swept-path');
  const attachmentFindings = actionable.filter((finding) => (
    finding.code === 'unanchored-attachment' || finding.code === 'attachment-far-from-anchor'
  ));
  // Name the anchor rather than the defect: the next pass needs somewhere to put
  // the part, and "this is floating" without a destination is what produced the
  // hat at hip height in the first place.
  const anchorNames = [...new Set(attachmentFindings
    .map((finding) => finding.anchorSocket || finding.anchorPartId)
    .filter(Boolean))];
  return [
    'The previous pass failed physical conformance audits:',
    ...actionable.map((finding, index) => `${index + 1}. ${finding.message}`),
    ...unmeasured.map((entry) => `Attachment "${entry.partId}" could not be checked against ${entry.anchorSocket ? `socket "${entry.anchorSocket}"` : `"${entry.anchorPartId}"`} because ${entry.reason} — give both the attachment and its anchor real geometry so the relationship can be verified.`),
    ...(hasNonuniformParentScale ? [
      'For non-uniform parent scale findings, size each part through its own geometry dimensions (for example, box width/height/depth or sphere radius) and keep containers near-uniform instead of squashing a parent that owns other components.',
    ] : []),
    ...(hasStraightSweptPath ? [
      'For straight swept-path findings, put the curve in the geometry rather than in the part name: a "tube" needs enough control points, stepped around a centre, that its path visibly turns, and an "extrude" only curves when its outline itself has a concave side. Rotating or repositioning a straight sweep does not make it a curved one.',
    ] : []),
    ...(hasBilateralChirality ? [
      'For bilateral pair findings, mirror a paired limb across the lateral plane rather than turning it around: give the counterpart position [-x, y, z] and rotation [rx, -ry, -rz] with every scale component positive. A 180° yaw about the vertical axis or a negative scale factor leaves the bounding box correct while pointing thumbs backward and putting big toes on the outer edge.',
    ] : []),
    ...(attachmentFindings.length > 0 ? [
      `For attachment findings, every entry in "articulation.attachments" must name the part or socket it hangs from and be positioned against it${anchorNames.length > 0 ? ` (the anchors named above: ${listSpecNames(anchorNames.map((name) => `"${name}"`))})` : ''}. Anchoring to the model root is not acceptable — name the body part that actually carries the piece.`,
    ] : []),
    'Ensure every part is physically attached to a parent, sibling, or ground plane, keep geometry exposed rather than buried inside unrelated parts, avoid exact coplanar surfaces that cause flickering, and make animated parts emerge cleanly from parents or hidden containers.',
  ].join('\n');
}
