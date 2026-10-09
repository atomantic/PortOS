// Copied beside a document's local vendor/ directory; never loads a CDN.
import * as GeometryTHREE from './vendor/three.module.js';

/** Cel bands from accumulated illumination, including Three's shadow maps. */
export function toonMaterial(THREE, { lit = '#f6ce86', mid = '#ba817b', shadow = '#57456f', bands = 3 } = {}) {
  if (!Number.isInteger(bands) || bands < 2 || bands > 16) throw new Error('Toon bands must be an integer from 2 to 16');
  const material = new THREE.MeshToonMaterial({ color: '#ffffff' });
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, {
      toonLit: { value: new THREE.Color(lit) }, toonMid: { value: new THREE.Color(mid) },
      toonShadow: { value: new THREE.Color(shadow) }, toonBands: { value: bands },
    });
    shader.fragmentShader = 'uniform vec3 toonLit, toonMid, toonShadow; uniform float toonBands;\n' + shader.fragmentShader;
    // Accumulate continuous light before selecting the palette band. Three's
    // default two-step irradiance would quantize the light a second time and
    // can collapse the mid/shadow bands under a bright directional light.
    shader.fragmentShader = shader.fragmentShader.replace('#include <gradientmap_pars_fragment>',
      'vec3 getGradientIrradiance(vec3 normal, vec3 lightDirection) { return vec3(max(dot(normal, lightDirection), 0.)); }');
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
      `vec3 illumination = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
       float level = clamp(max(illumination.r, max(illumination.g, illumination.b)) * PI, 0., 1.);
       level = min(floor(level * toonBands), toonBands - 1.) / (toonBands - 1.);
       vec3 outgoingLight = (level < .5 ? mix(toonShadow, toonMid, level * 2.) : mix(toonMid, toonLit, level * 2. - 1.)) + totalEmissiveRadiance;`);
  };
  material.customProgramCacheKey = () => 'portos-toon-world-v1';
  return material;
}

const positive = (n, name) => {
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be positive and finite`);
  return n;
};

/** Profile runs from base to rim, as [radius, height] pairs or Vector2s.
 * Thickness offsets inward along the profile normal; the rim and base close.
 * Use a non-self-intersecting profile and thickness smaller than its curvature.
 */
export function shellLathe(profile, thickness, segments = 64) {
  positive(thickness, 'Thickness');
  if (!Number.isInteger(segments) || segments < 3) throw new Error('Lathe needs at least three segments');
  if (!Array.isArray(profile) || profile.length < 2) throw new Error('Lathe needs at least two profile points');
  const points = profile.map(p => new GeometryTHREE.Vector2(p.x ?? p[0], p.y ?? p[1]));
  if (points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0)) throw new Error('Profile radii must be nonnegative and coordinates finite');
  const inner = points.map((p, i) => {
    const before = points[Math.max(0, i - 1)], after = points[Math.min(points.length - 1, i + 1)];
    const tangent = after.clone().sub(before);
    if (!tangent.length()) throw new Error('Profile points must be distinct');
    tangent.normalize();
    const radius = p.x === 0 ? 0 : p.x - tangent.y * thickness;
    if (radius < 0) throw new Error('Thickness crosses the lathe axis');
    return new GeometryTHREE.Vector2(radius, p.y + (p.x === 0 ? Math.sign(tangent.x) * thickness : tangent.x * thickness));
  });
  return new GeometryTHREE.LatheGeometry([...points, ...inner.reverse(), points[0].clone()], segments);
}

/** Thicken an orientable triangle sheet without modifying the source.
 * Coincident vertices (UV seams / non-indexed triangles) are welded for walls.
 * Input vertex normals define the front; front/back are +/- thickness/2.
 */
export function solidify(geometry, thickness) {
  positive(thickness, 'Thickness');
  const source = geometry.clone();
  const p = source.getAttribute('position');
  if (!p || p.count < 3) throw new Error('Solidify needs triangle positions');
  if (!source.getAttribute('normal')) source.computeVertexNormals();
  const n = source.getAttribute('normal');
  const indices = source.index ? Array.from(source.index.array) : Array.from({ length: p.count }, (_, i) => i);
  if (indices.length % 3) throw new Error('Solidify needs triangles');
  const positions = [], normals = [], uvs = [], uv = source.getAttribute('uv');
  const weld = new Map(), canonical = [], offsets = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = [p.getX(i), p.getY(i), p.getZ(i)].map(v => Math.round(v * 1e6)).join(',');
    if (!weld.has(key)) weld.set(key, { index: i, normals: new Map() });
    const group = weld.get(key);
    canonical[i] = group.index;
    const normal = new GeometryTHREE.Vector3(n.getX(i), n.getY(i), n.getZ(i)).normalize();
    // Duplicate face corners must not bias a seam's offset toward whichever
    // triangle happened to repeat that corner more often.
    group.normals.set(normal.toArray().map(v => Math.round(v * 1e6)).join(','), normal);
  }
  for (const group of weld.values()) {
    const normalsAtSeam = [...group.normals.values()];
    const direction = normalsAtSeam.reduce((sum, normal) => sum.add(normal), new GeometryTHREE.Vector3()).normalize();
    const projection = Math.min(...normalsAtSeam.map(normal => normal.dot(direction)));
    if (projection <= 1e-6) throw new Error('Solidify needs consistently oriented sheet normals');
    // Miter the welded corner, retaining at least the requested thickness on
    // each incident face. Keep original shading normals on separate vertices.
    offsets.set(group.index, direction.multiplyScalar(thickness / (2 * projection)));
  }
  for (let i = 0; i < p.count; i++) {
    const offset = offsets.get(canonical[i]), point = canonical[i];
    for (const sign of [1, -1]) {
      positions.push(p.getX(point) + sign * offset.x, p.getY(point) + sign * offset.y, p.getZ(point) + sign * offset.z);
      normals.push(sign * n.getX(i), sign * n.getY(i), sign * n.getZ(i));
      uvs.push(uv?.getX(i) ?? 0, uv?.getY(i) ?? 0);
    }
  }
  const faces = [], edges = new Map();
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = indices.slice(i, i + 3);
    faces.push(a * 2, b * 2, c * 2, c * 2 + 1, b * 2 + 1, a * 2 + 1);
    for (const [start, end] of [[a, b], [b, c], [c, a]]) {
      const key = [canonical[start], canonical[end]].sort((x, y) => x - y).join(',');
      const edge = edges.get(key);
      if (edge) edge.count++;
      else edges.set(key, { start, end, count: 1 });
    }
  }
  for (const { start, end, count } of edges.values()) {
    if (count > 2) throw new Error('Solidify needs a manifold sheet');
    if (count !== 1) continue;
    // Duplicate wall vertices for a crisp rim and geometric wall normals.
    const offset = positions.length / 3;
    for (const index of [start * 2, start * 2 + 1, end * 2, end * 2 + 1]) {
      positions.push(...positions.slice(index * 3, index * 3 + 3));
      normals.push(0, 0, 0); uvs.push(0, 0);
    }
    faces.push(offset, offset + 1, offset + 2, offset + 2, offset + 1, offset + 3);
    const a = new GeometryTHREE.Vector3().fromArray(positions, offset * 3);
    const b = new GeometryTHREE.Vector3().fromArray(positions, (offset + 1) * 3);
    const c = new GeometryTHREE.Vector3().fromArray(positions, (offset + 2) * 3);
    const normal = b.sub(a).cross(c.sub(a)).normalize();
    for (let j = 0; j < 4; j++) normals.splice((offset + j) * 3, 3, ...normal.toArray());
  }
  source.dispose();
  const result = new GeometryTHREE.BufferGeometry();
  result.setAttribute('position', new GeometryTHREE.Float32BufferAttribute(positions, 3));
  result.setAttribute('normal', new GeometryTHREE.Float32BufferAttribute(normals, 3));
  result.setAttribute('uv', new GeometryTHREE.Float32BufferAttribute(uvs, 2));
  result.setIndex(faces);
  return result;
}

/** Conservative, axis-aligned X/Z footprints; curve(x, row) adds Z only,
 * so it cannot reduce X clearance. Grid rows expand around curve excursions.
 */
export function layoutGrid({ count, footprint, gap = 0, curve = () => 0, columns = Math.ceil(Math.sqrt(count)) }) {
  if (!Number.isInteger(count) || count < 0 || !Number.isInteger(columns) || columns < 1) {
    if (count === 0) return [];
    throw new Error('Layout count and columns must be nonnegative/positive integers');
  }
  const xSize = positive(typeof footprint === 'number' ? footprint : footprint?.x, 'Footprint x');
  const zSize = positive(typeof footprint === 'number' ? footprint : footprint?.z, 'Footprint z');
  if (!Number.isFinite(gap) || gap < 0) throw new Error('Gap must be nonnegative and finite');
  const out = [];
  let previousMax = -Infinity;
  for (let row = 0; out.length < count; row++) {
    const size = Math.min(columns, count - out.length);
    const offsets = Array.from({ length: size }, (_, col) => {
      const x = (col - (size - 1) / 2) * (xSize + gap);
      const z = curve(x, row);
      if (!Number.isFinite(z)) throw new Error('Curve must return a finite Z offset');
      return { x, y: 0, z };
    });
    const minimum = Math.min(...offsets.map(p => p.z));
    const shift = row ? previousMax + zSize + gap - minimum : 0;
    for (const p of offsets) out.push({ ...p, z: p.z + shift });
    previousMax = Math.max(...offsets.map(p => p.z + shift));
  }
  const center = out.length ? (Math.min(...out.map(p => p.z)) + Math.max(...out.map(p => p.z))) / 2 : 0;
  return out.map(p => ({ ...p, z: p.z - center }));
}
export function layoutRow(options) { return layoutGrid({ ...options, columns: Math.max(1, options.count) }); }

/** Explicit author-time check on placed, transformed world bounding boxes. */
export function warnOverlaps(THREE, instances, { warn = message => console.warn(message) } = {}) {
  const boxes = instances.map(object => { object.updateWorldMatrix(true, true); return new THREE.Box3().setFromObject(object); });
  const overlaps = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (Math.min(a.max.x, b.max.x) > Math.max(a.min.x, b.min.x) &&
        Math.min(a.max.y, b.max.y) > Math.max(a.min.y, b.min.y) &&
        Math.min(a.max.z, b.max.z) > Math.max(a.min.z, b.min.z)) overlaps.push([i, j]);
  }
  if (overlaps.length) warn(`⚠️ Toon world: ${overlaps.length} overlapping instance bounds; increase footprint or gap`);
  return overlaps;
}

// Surface normals reconstructed from the nearest visible depth surface. No
// inverted hulls, hidden geometry or extra scene/normal render. Orthographic
// and perspective cameras both use their actual inverse projection.
export const inkShader = /* glsl */`
uniform sampler2D tInkDepth; uniform mat4 uInkInverseProjection;
uniform vec2 uInkRes; uniform vec3 uInkColor;
uniform float uInkWidth, uInkDepthThreshold, uInkNormalThreshold, uInkEnabled;
vec3 inkPosition(vec2 uv){
  float d = texture2D(tInkDepth, uv).x;
  float z = d * 2. - 1.;
  // Standard Three perspective/off-axis and orthographic projections have
  // this sparse inverse. Avoid five full mat4 multiplies per output pixel.
  vec2 xy = (uv * 2. - 1.) * vec2(uInkInverseProjection[0][0], uInkInverseProjection[1][1])
    + vec2(uInkInverseProjection[3][0], uInkInverseProjection[3][1]);
  return vec3(xy, z * uInkInverseProjection[2][2] + uInkInverseProjection[3][2])
    / (z * uInkInverseProjection[2][3] + uInkInverseProjection[3][3]);
}
float inkPlaneEdge(vec3 delta, vec3 n, float threshold){
  float distanceToPlane = dot(delta, n);
  return step(delta.z, 1e-5) * step(threshold, distanceToPlane * distanceToPlane);
}
float inkCrease(vec3 a, vec3 b, float alignment2){
  float alignment = dot(a, b);
  return step(alignment * alignment, alignment2 * dot(a, a) * dot(b, b));
}
vec3 applyInk(vec3 color, vec2 uv){
  if (uInkEnabled < .5 || uInkWidth <= 0.) return color;
  float depth = texture2D(tInkDepth, uv).x;
  if (depth >= .999999) return color;
  vec2 dx = vec2(uInkWidth / uInkRes.x, 0.), dy = vec2(0., uInkWidth / uInkRes.y);
  vec3 p = inkPosition(uv);
  vec3 r = inkPosition(clamp(uv + dx, 0., 1.)) - p;
  vec3 l = p - inkPosition(clamp(uv - dx, 0., 1.));
  vec3 u = inkPosition(clamp(uv + dy, 0., 1.)) - p;
  vec3 d = p - inkPosition(clamp(uv - dy, 0., 1.));
  // Five visible-depth taps supply all four one-sided normals. Choose
  // derivatives on the nearest surface so silhouettes don't tilt its normal.
  vec3 nx = abs(r.z) < abs(l.z) ? r : l;
  vec3 ny = abs(u.z) < abs(d.z) ? u : d;
  vec3 n = cross(nx, ny);
  float normalLength2 = max(dot(n, n), 1e-20);
  float planeThreshold2 = uInkDepthThreshold * uInkDepthThreshold * max(dot(p, p), 1e-6) * normalLength2;
  float alignment2 = (1. - uInkNormalThreshold) * (1. - uInkNormalThreshold);
  float planeEdge = max(
    max(inkPlaneEdge(r, n, planeThreshold2), inkPlaneEdge(-l, n, planeThreshold2)),
    max(inkPlaneEdge(u, n, planeThreshold2), inkPlaneEdge(-d, n, planeThreshold2)));
  // One of each pair is exactly the nearest normal selected above, so a
  // single comparison per axis replaces four comparisons to that normal.
  float creaseX = inkCrease(cross(r, ny), cross(l, ny), alignment2)
    * step(abs(r.z) < abs(l.z) ? -l.z : r.z, 1e-5);
  float creaseY = inkCrease(cross(nx, u), cross(nx, d), alignment2)
    * step(abs(u.z) < abs(d.z) ? -d.z : u.z, 1e-5);
  float edge = max(planeEdge, max(creaseX, creaseY));
  return mix(color, uInkColor, edge);
}`;

export function createInkPass(THREE, renderer, { color = '#181325', width = 1.5, depthThreshold = .015, normalThreshold = .35 } = {}) {
  const uniforms = {
    tInkDepth: { value: null }, uInkInverseProjection: { value: new THREE.Matrix4() },
    uInkRes: { value: new THREE.Vector2(1, 1) }, uInkColor: { value: new THREE.Color(color) },
    uInkWidth: { value: width }, uInkDepthThreshold: { value: depthThreshold },
    uInkNormalThreshold: { value: normalThreshold }, uInkEnabled: { value: 0 },
  };
  let material, quad, stage, camera;
  const configure = (depth, view, w, h, options = {}) => {
    uniforms.tInkDepth.value = depth; uniforms.uInkInverseProjection.value.copy(view.projectionMatrixInverse);
    uniforms.uInkRes.value.set(w, h); uniforms.uInkEnabled.value = options.enabled === false ? 0 : 1;
    uniforms.uInkColor.value.set(options.color ?? color);
    uniforms.uInkWidth.value = options.width ?? width;
    uniforms.uInkDepthThreshold.value = options.depthThreshold ?? depthThreshold;
    uniforms.uInkNormalThreshold.value = options.normalThreshold ?? normalThreshold;
  };
  return {
    uniforms, configure,
    // Caller renders its scene into a depth-textured target, then invokes this
    // before its own grade/grain. The spatial host fuses it into existing passes.
    render(input, view, output = null, options = {}) {
      if (input === output) throw new Error('Ink input and output targets must be distinct');
      if (!input.depthTexture) throw new Error('Ink requires a depth-textured render target');
      configure(input.depthTexture, view, input.width, input.height, options);
      if (!material) {
        material = new THREE.ShaderMaterial({ uniforms: { ...uniforms, tColor: { value: null } },
          vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
          fragmentShader: `varying vec2 vUv; uniform sampler2D tColor; ${inkShader}
          void main(){gl_FragColor=vec4(applyInk(texture2D(tColor,vUv).rgb,vUv),1.);}`,
          depthTest: false, depthWrite: false, toneMapped: false });
        quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
        stage = new THREE.Scene(); stage.add(quad);
        camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      }
      material.uniforms.tColor.value = input.texture;
      const previous = renderer.getRenderTarget();
      try { renderer.setRenderTarget(output); renderer.render(stage, camera); }
      finally { renderer.setRenderTarget(previous); }
    },
    dispose() { material?.dispose(); quad?.geometry.dispose(); material = null; },
  };
}

// Imported manual/layered documents can use these directly. Generated section
// functions receive the same exports through ctx.toonWorld.
