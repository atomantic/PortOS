/**
 * Declarative procedural-model contract used by the Three.js Models workspace.
 *
 * AI providers author this bounded JSON scene spec instead of executable
 * JavaScript. The browser renders only allowlisted Three.js primitives (plus a
 * bounded custom BufferGeometry), and this module deterministically exports the
 * same spec as a standalone Three.js factory.
 */

import { z } from 'zod';

const idSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const finite = z.number().finite().min(-10_000).max(10_000);
const positive = z.number().finite().positive().max(10_000);
const vec3Schema = z.tuple([finite, finite, finite]);

const boxGeometrySchema = z.object({
  type: z.literal('box'),
  width: positive,
  height: positive,
  depth: positive,
});

const sphereGeometrySchema = z.object({
  type: z.literal('sphere'),
  radius: positive,
  widthSegments: z.number().int().min(8).max(96).default(32),
  heightSegments: z.number().int().min(4).max(64).default(16),
});

const cylinderGeometrySchema = z.object({
  type: z.literal('cylinder'),
  radiusTop: z.number().finite().min(0).max(10_000),
  radiusBottom: z.number().finite().min(0).max(10_000),
  height: positive,
  radialSegments: z.number().int().min(3).max(96).default(32),
});

const coneGeometrySchema = z.object({
  type: z.literal('cone'),
  radius: positive,
  height: positive,
  radialSegments: z.number().int().min(3).max(96).default(32),
});

const torusGeometrySchema = z.object({
  type: z.literal('torus'),
  radius: positive,
  tube: positive,
  radialSegments: z.number().int().min(3).max(64).default(16),
  tubularSegments: z.number().int().min(6).max(128).default(48),
  arcDegrees: z.number().finite().min(1).max(360).default(360),
});

const capsuleGeometrySchema = z.object({
  type: z.literal('capsule'),
  radius: positive,
  length: z.number().finite().min(0).max(10_000),
  capSegments: z.number().int().min(2).max(32).default(8),
  radialSegments: z.number().int().min(3).max(64).default(16),
});

const latheGeometrySchema = z.object({
  type: z.literal('lathe'),
  points: z.array(z.tuple([finite, finite])).min(2).max(96),
  segments: z.number().int().min(3).max(96).default(32),
});

const customGeometrySchema = z.object({
  type: z.literal('custom'),
  // 900 vertices / 2,700 coordinates is deliberately generous for a
  // procedural reconstruction while bounding provider output and browser work.
  vertices: z.array(finite).min(9).max(2_700)
    .refine((values) => values.length % 3 === 0, 'vertices must contain xyz triples'),
  indices: z.array(z.number().int().min(0).max(899)).min(3).max(5_400)
    .refine((values) => values.length % 3 === 0, 'indices must contain triangle triples'),
});

export const threejsGeometrySchema = z.discriminatedUnion('type', [
  boxGeometrySchema,
  sphereGeometrySchema,
  cylinderGeometrySchema,
  coneGeometrySchema,
  torusGeometrySchema,
  capsuleGeometrySchema,
  latheGeometrySchema,
  customGeometrySchema,
]);

export const threejsMaterialSchema = z.object({
  type: z.enum(['standard', 'physical', 'basic']).default('standard'),
  color: colorSchema,
  metalness: z.number().finite().min(0).max(1).default(0),
  roughness: z.number().finite().min(0).max(1).default(0.65),
  emissive: colorSchema.default('#000000'),
  emissiveIntensity: z.number().finite().min(0).max(20).default(0),
  opacity: z.number().finite().min(0).max(1).default(1),
  transparent: z.boolean().default(false),
  wireframe: z.boolean().default(false),
  clearcoat: z.number().finite().min(0).max(1).default(0),
  clearcoatRoughness: z.number().finite().min(0).max(1).default(0),
});

let partSchema;
partSchema = z.lazy(() => z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(120),
  geometry: threejsGeometrySchema.optional(),
  material: idSchema.optional(),
  position: vec3Schema.default([0, 0, 0]),
  rotationDegrees: vec3Schema.default([0, 0, 0]),
  scale: vec3Schema.default([1, 1, 1]),
  castShadow: z.boolean().default(true),
  receiveShadow: z.boolean().default(true),
  children: z.array(partSchema).max(40).default([]),
}));

const lightSchema = z.object({
  type: z.enum(['ambient', 'hemisphere', 'directional', 'point', 'spot']),
  color: colorSchema.default('#ffffff'),
  groundColor: colorSchema.default('#202030'),
  intensity: z.number().finite().min(0).max(100),
  position: vec3Schema.default([4, 6, 4]),
  angleDegrees: z.number().finite().min(1).max(179).default(45),
  penumbra: z.number().finite().min(0).max(1).default(0.25),
});

const socketSchema = z.object({
  name: idSchema,
  parentPartId: idSchema,
  position: vec3Schema.default([0, 0, 0]),
  rotationDegrees: vec3Schema.default([0, 0, 0]),
});

const detailSchema = z.object({
  feature: z.string().trim().min(1).max(240),
  evidence: z.string().trim().min(1).max(500),
  implementationPartIds: z.array(idSchema).min(1).max(12),
  priority: z.enum(['identity', 'major', 'minor']).default('major'),
});

export const threejsSculptSpecSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(1_000),
  subjectType: z.enum(['object', 'character', 'hybrid']),
  limitations: z.array(z.string().trim().min(1).max(500)).max(12).default([]),
  background: colorSchema.default('#111827'),
  camera: z.object({
    position: vec3Schema,
    target: vec3Schema.default([0, 0, 0]),
    fov: z.number().finite().min(15).max(90).default(42),
  }),
  materials: z.record(idSchema, threejsMaterialSchema)
    .refine((materials) => Object.keys(materials).length > 0, 'at least one material is required')
    .refine((materials) => Object.keys(materials).length <= 50, 'at most 50 materials are allowed'),
  lights: z.array(lightSchema).min(1).max(8),
  parts: z.array(partSchema).min(1).max(40),
  sockets: z.array(socketSchema).max(40).default([]),
  detailInventory: z.array(detailSchema).min(1).max(80),
}).superRefine((spec, ctx) => {
  const materialIds = new Set(Object.keys(spec.materials));
  const partIds = new Set();
  let partCount = 0;

  const visit = (part, depth, path) => {
    partCount += 1;
    if (depth > 8) {
      ctx.addIssue({ code: 'custom', message: 'part hierarchy cannot exceed 8 levels', path });
    }
    if (partIds.has(part.id)) {
      ctx.addIssue({ code: 'custom', message: `duplicate part id: ${part.id}`, path: [...path, 'id'] });
    }
    partIds.add(part.id);
    if (part.geometry && !part.material) {
      ctx.addIssue({ code: 'custom', message: 'a part with geometry requires a material', path: [...path, 'material'] });
    }
    if (part.material && !materialIds.has(part.material)) {
      ctx.addIssue({ code: 'custom', message: `unknown material: ${part.material}`, path: [...path, 'material'] });
    }
    if (part.geometry?.type === 'custom') {
      const vertexCount = part.geometry.vertices.length / 3;
      const invalidIndex = part.geometry.indices.find((index) => index >= vertexCount);
      if (invalidIndex !== undefined) {
        ctx.addIssue({ code: 'custom', message: `custom geometry index ${invalidIndex} exceeds vertex count ${vertexCount}`, path: [...path, 'geometry', 'indices'] });
      }
    }
    part.children.forEach((child, index) => visit(child, depth + 1, [...path, 'children', index]));
  };

  spec.parts.forEach((part, index) => visit(part, 1, ['parts', index]));
  if (partCount > 160) {
    ctx.addIssue({ code: 'custom', message: 'model cannot exceed 160 total parts', path: ['parts'] });
  }

  for (const [index, socket] of spec.sockets.entries()) {
    if (!partIds.has(socket.parentPartId)) {
      ctx.addIssue({ code: 'custom', message: `unknown socket parent: ${socket.parentPartId}`, path: ['sockets', index, 'parentPartId'] });
    }
  }
  for (const [index, detail] of spec.detailInventory.entries()) {
    for (const [partIndex, id] of detail.implementationPartIds.entries()) {
      if (!partIds.has(id)) {
        ctx.addIssue({ code: 'custom', message: `unknown detail part: ${id}`, path: ['detailInventory', index, 'implementationPartIds', partIndex] });
      }
    }
  }
});

const toIdentifier = (name) => {
  const words = String(name || 'Procedural').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const joined = words.map((word) => word[0].toUpperCase() + word.slice(1)).join('') || 'Procedural';
  return /^[A-Za-z]/.test(joined) ? joined : `Model${joined}`;
};

/**
 * Deterministically package a validated scene spec as a standalone Three.js
 * Group factory. No model-authored JavaScript is executed by PortOS.
 */
export function buildThreejsFactorySource(input) {
  const spec = threejsSculptSpecSchema.parse(input);
  const factoryName = `create${toIdentifier(spec.name)}Model`;
  const serialized = JSON.stringify(spec, null, 2);

  return `// Generated by PortOS Three.js Models.
// Procedural image-to-Three.js workflow inspired by https://github.com/hoainho/img2threejs
import * as THREE from 'three';

const spec = ${serialized};
const radians = (degrees) => THREE.MathUtils.degToRad(degrees);
const rotation = (value) => value.map(radians);

function createGeometry(definition) {
  switch (definition.type) {
    case 'box':
      return new THREE.BoxGeometry(definition.width, definition.height, definition.depth);
    case 'sphere':
      return new THREE.SphereGeometry(definition.radius, definition.widthSegments, definition.heightSegments);
    case 'cylinder':
      return new THREE.CylinderGeometry(definition.radiusTop, definition.radiusBottom, definition.height, definition.radialSegments);
    case 'cone':
      return new THREE.ConeGeometry(definition.radius, definition.height, definition.radialSegments);
    case 'torus':
      return new THREE.TorusGeometry(definition.radius, definition.tube, definition.radialSegments, definition.tubularSegments, radians(definition.arcDegrees));
    case 'capsule':
      return new THREE.CapsuleGeometry(definition.radius, definition.length, definition.capSegments, definition.radialSegments);
    case 'lathe':
      return new THREE.LatheGeometry(definition.points.map(([x, y]) => new THREE.Vector2(x, y)), definition.segments);
    case 'custom': {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(definition.vertices, 3));
      geometry.setIndex(definition.indices);
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      return geometry;
    }
    default:
      throw new Error(\`Unsupported geometry type: \${definition.type}\`);
  }
}

function createMaterial(definition) {
  const common = {
    color: definition.color,
    metalness: definition.metalness,
    roughness: definition.roughness,
    emissive: definition.emissive,
    emissiveIntensity: definition.emissiveIntensity,
    opacity: definition.opacity,
    transparent: definition.transparent,
    wireframe: definition.wireframe,
  };
  if (definition.type === 'basic') {
    const { metalness, roughness, ...basic } = common;
    return new THREE.MeshBasicMaterial(basic);
  }
  if (definition.type === 'physical') {
    return new THREE.MeshPhysicalMaterial({
      ...common,
      clearcoat: definition.clearcoat,
      clearcoatRoughness: definition.clearcoatRoughness,
    });
  }
  return new THREE.MeshStandardMaterial(common);
}

function createPart(definition, materials, nodes) {
  const node = definition.geometry
    ? new THREE.Mesh(createGeometry(definition.geometry), materials[definition.material])
    : new THREE.Group();
  node.name = definition.name;
  node.position.set(...definition.position);
  node.rotation.set(...rotation(definition.rotationDegrees));
  node.scale.set(...definition.scale);
  node.castShadow = definition.castShadow;
  node.receiveShadow = definition.receiveShadow;
  nodes[definition.id] = node;
  for (const child of definition.children) node.add(createPart(child, materials, nodes));
  return node;
}

export function ${factoryName}() {
  const root = new THREE.Group();
  root.name = spec.name;
  const materials = Object.fromEntries(
    Object.entries(spec.materials).map(([id, definition]) => [id, createMaterial(definition)])
  );
  const nodes = {};
  for (const part of spec.parts) root.add(createPart(part, materials, nodes));
  root.userData.sculptRuntime = {
    schemaVersion: spec.schemaVersion,
    subjectType: spec.subjectType,
    nodes,
    sockets: spec.sockets,
    detailInventory: spec.detailInventory,
    limitations: spec.limitations,
  };
  return root;
}

export { spec };
`;
}
