/**
 * Affine transform primitives shared by every server-side gate that has to
 * reconstruct where a Three.js scene-spec part actually sits in the world.
 *
 * `threejsModel.js` (flatness), `threejsModelPenetration.js` (cross-part
 * overlap) and `threejsModelPhysicalAudit.js` (bounds and pose) each used to
 * carry their own row-major 3x3 copy of this math. They were algebraically
 * identical but textually different, so nothing stopped the three gates from
 * silently starting to measure three different scenes — and they had already
 * drifted on input hardening, which is why the coercion below is part of the
 * contract rather than a caller's problem.
 *
 * Matrices are row-major 3x3 flat arrays; a transform is `{ linear, translation }`.
 * The rotation composition matches `THREE.Euler` order 'XYZ' — what the preview
 * canvas and the exported factory both apply. A different composition here would
 * measure a part that is not the one on screen.
 */

/** Degrees to radians. Not input-guarded: callers pass schema-validated angles. */
export const degreesToRadians = (degrees) => (degrees * Math.PI) / 180;

export const IDENTITY_LINEAR = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Row-major 3x3 linear part plus a translation — an affine transform. */
export const IDENTITY_TRANSFORM = { linear: [...IDENTITY_LINEAR], translation: [0, 0, 0] };

// A non-finite angle reads as 0 degrees — see `rotationMatrix`.
const angleCosSin = (degrees) => {
  const radians = degreesToRadians(Number.isFinite(degrees) ? degrees : 0);
  return [Math.cos(radians), Math.sin(radians)];
};

/**
 * Rotation matrix for `THREE.Euler` order 'XYZ'.
 *
 * A non-finite component reads as `0` degrees, which is what the renderer
 * already does with a malformed stored spec. Feeding `null`/`NaN` into
 * `Math.cos` instead would produce `NaN` bounds that every downstream gate
 * reads as "no overlap" and "no defect" — a silently passing audit.
 */
export const rotationMatrix = (rotationDegrees = [0, 0, 0]) => {
  const [x, y, z] = rotationDegrees || [];
  const [c1, s1] = angleCosSin(x);
  const [c2, s2] = angleCosSin(y);
  const [c3, s3] = angleCosSin(z);
  return [
    c2 * c3, -c2 * s3, s2,
    (c1 * s3) + (s1 * c3 * s2), (c1 * c3) - (s1 * s3 * s2), -s1 * c2,
    (s1 * s3) - (c1 * c3 * s2), (s1 * c3) + (c1 * s3 * s2), c1 * c2,
  ];
};

/** Diagonal scale matrix. A non-finite component reads as `1` — an unscaled axis. */
export const scaleLinear = (scale = [1, 1, 1]) => {
  const [x, y, z] = scale || [];
  return [
    Number.isFinite(x) ? x : 1, 0, 0,
    0, Number.isFinite(y) ? y : 1, 0,
    0, 0, Number.isFinite(z) ? z : 1,
  ];
};

export const multiplyLinear = (a, b) => [
  (a[0] * b[0]) + (a[1] * b[3]) + (a[2] * b[6]),
  (a[0] * b[1]) + (a[1] * b[4]) + (a[2] * b[7]),
  (a[0] * b[2]) + (a[1] * b[5]) + (a[2] * b[8]),
  (a[3] * b[0]) + (a[4] * b[3]) + (a[5] * b[6]),
  (a[3] * b[1]) + (a[4] * b[4]) + (a[5] * b[7]),
  (a[3] * b[2]) + (a[4] * b[5]) + (a[5] * b[8]),
  (a[6] * b[0]) + (a[7] * b[3]) + (a[8] * b[6]),
  (a[6] * b[1]) + (a[7] * b[4]) + (a[8] * b[7]),
  (a[6] * b[2]) + (a[7] * b[5]) + (a[8] * b[8]),
];

export const applyLinear = (linear, [x, y, z]) => [
  (linear[0] * x) + (linear[1] * y) + (linear[2] * z),
  (linear[3] * x) + (linear[4] * y) + (linear[5] * z),
  (linear[6] * x) + (linear[7] * y) + (linear[8] * z),
];

export const applyTransform = (transform, point) => {
  const rotated = applyLinear(transform.linear, point);
  return [
    rotated[0] + transform.translation[0],
    rotated[1] + transform.translation[1],
    rotated[2] + transform.translation[2],
  ];
};

/**
 * A part's world transform: the parent transform with the part's own local
 * TRS applied inside it, composed rotation-then-scale the way Three.js does.
 *
 * The local TRS arrives object-shaped because that is the shape stored specs
 * already use — a whole `part` can be passed straight through.
 */
export const composeTransform = (parent, { position, rotationDegrees, scale } = {}) => {
  const local = multiplyLinear(rotationMatrix(rotationDegrees), scaleLinear(scale));
  const offset = applyLinear(parent.linear, position || [0, 0, 0]);
  return {
    linear: multiplyLinear(parent.linear, local),
    translation: [
      offset[0] + parent.translation[0],
      offset[1] + parent.translation[1],
      offset[2] + parent.translation[2],
    ],
  };
};

export const vectorLength = (vector) => Math.hypot(...vector);
