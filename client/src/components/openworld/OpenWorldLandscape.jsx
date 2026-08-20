import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { openWorldDayMix, mixHex, seededRand, smoothstepRange } from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';
import { WORLD } from '../../utils/openWorldPlan';

const TERRAIN_SIZE = 2400;
const MOUNTAIN_INNER_RADIUS = 560;
const MOUNTAIN_RADIUS_SPREAD = 190;
const NEAR_HILL_INNER_RADIUS = 72;
const NEAR_HILL_RADIUS_SPREAD = 28;

const TERRAIN_VERT = `
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TERRAIN_FRAG = `
  uniform vec3 uInner;
  uniform vec3 uMeadow;
  uniform vec3 uRidge;
  uniform vec3 uAccent;
  uniform float uDayMix;
  varying vec2 vUv;
  varying vec3 vWorldPosition;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  void main() {
    float dist = length(vWorldPosition.xz);
    float meadowMix = smoothstep(42.0, 86.0, dist);
    float ridgeMix = smoothstep(260.0, 760.0, dist);
    float n = noise(vWorldPosition.xz * 0.035);
    float largeN = noise(vWorldPosition.xz * 0.006);
    vec3 color = mix(uInner, uMeadow, meadowMix);
    color = mix(color, uRidge, ridgeMix * mix(0.26, 0.42, uDayMix));
    color += (n - 0.5) * mix(0.025, 0.06, uDayMix);
    color += (largeN - 0.5) * mix(0.025, 0.045, uDayMix);

    // Keep a faint themed tech trace near the city, but let nature dominate outside.
    float openWorldTrace = (1.0 - meadowMix) * 0.08 * (1.0 - uDayMix * 0.65);
    color = mix(color, uAccent, openWorldTrace);

    gl_FragColor = vec4(color, 1.0);
  }
`;

function TerrainPlane({ dayMix, accent, terrain }) {
  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: TERRAIN_VERT,
    fragmentShader: TERRAIN_FRAG,
    uniforms: {
      // Night bands are shared; the daytime bands come from the active world style's
      // terrain trio (WORLD_STYLE_DEFS in openWorldConstants), so retuning a style's ground
      // doesn't mean grepping raw hexes across two files.
      uInner: { value: new THREE.Color(mixHex('#202426', terrain.inner, dayMix)) },
      uMeadow: { value: new THREE.Color(mixHex('#172719', terrain.meadow, dayMix)) },
      uRidge: { value: new THREE.Color(mixHex('#111827', terrain.ridge, dayMix)) },
      uAccent: { value: new THREE.Color(accent) },
      uDayMix: { value: dayMix },
    },
    side: THREE.DoubleSide,
    depthWrite: true,
    // accent intentionally NOT a dep — a theme switch updates the uniform in
    // place (effect below) rather than recompiling the GLSL program. Matches the
    // imperative-uniform pattern in OpenWorldSky / OpenWorldBillboards / OpenWorldVolumetricLights.
  }), [dayMix, terrain]);

  // Push the accent into the existing material on theme change — no rebuild.
  useEffect(() => { material.uniforms.uAccent.value.set(accent); }, [material, accent]);

  // R3F doesn't dispose a material handed in via the `material` prop, so free the
  // prior one when dayMix flips (Day/Night toggle) and on unmount.
  useEffect(() => () => material.dispose(), [material]);

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, WORLD.terrainY, 0]}
      material={material}
      frustumCulled={false}
    >
      <planeGeometry args={[TERRAIN_SIZE, TERRAIN_SIZE, 1, 1]} />
    </mesh>
  );
}

function Mountain({ mountain, dayMix, surface }) {
  const geometry = useMemo(() => {
    const geom = new THREE.ConeGeometry(mountain.radius, mountain.height, mountain.sides, 6);
    const position = geom.getAttribute('position');
    const colors = [];
    const base = new THREE.Color(mixHex('#111827', '#9aa794', dayMix));
    const lit = new THREE.Color(mixHex('#243044', '#dfe7d8', dayMix));
    const snow = new THREE.Color(mixHex('#64748b', '#f4f7f0', dayMix));

    for (let i = 0; i < position.count; i += 1) {
      const y = (position.getY(i) + mountain.height / 2) / mountain.height;
      const shoulder = smoothstepRange(0.22, 0.88, y);
      const snowMix = smoothstepRange(0.68, 0.95, y) * mountain.snow;
      const color = base.clone()
        .lerp(lit, Math.min(1, mountain.light + shoulder * 0.28))
        .lerp(snow, snowMix);
      colors.push(color.r, color.g, color.b);
    }

    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geom.computeVertexNormals();
    return geom;
  }, [dayMix, mountain.height, mountain.light, mountain.radius, mountain.sides, mountain.snow]);

  // Attached via <primitive object={geometry}>, which R3F never auto-disposes —
  // free the prior cone when dayMix rebuilds it, and on unmount.
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <group position={mountain.position} rotation={[0, mountain.rotation, 0]} scale={mountain.scale}>
      <mesh position={[0, mountain.height / 2 - 0.08, 0]}>
        <primitive attach="geometry" object={geometry} />
        <meshStandardMaterial
          vertexColors
          roughness={0.92}
          metalness={0}
          depthWrite
          {...surface}
        />
      </mesh>
    </group>
  );
}

function NearHill({ hill, dayMix, surface, terrain }) {
  const geometry = useMemo(() => {
    const geom = new THREE.ConeGeometry(hill.radius, hill.height, hill.sides, 4);
    const position = geom.getAttribute('position');
    const colors = [];
    const base = new THREE.Color(mixHex('#304b58', terrain.ridge, dayMix));
    const lit = new THREE.Color(mixHex('#466b72', terrain.meadow, dayMix));
    const cap = new THREE.Color(mixHex('#6b7890', '#d5c49c', dayMix));

    for (let i = 0; i < position.count; i += 1) {
      const y = (position.getY(i) + hill.height / 2) / hill.height;
      const shoulder = smoothstepRange(0.16, 0.78, y);
      const capMix = smoothstepRange(0.72, 1, y) * hill.cap;
      const color = base.clone()
        .lerp(lit, Math.min(1, hill.light + shoulder * 0.3))
        .lerp(cap, capMix);
      colors.push(color.r, color.g, color.b);
    }

    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geom.computeVertexNormals();
    return geom;
  }, [dayMix, hill.cap, hill.height, hill.light, hill.radius, hill.sides, terrain]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <group position={hill.position} rotation={[0, hill.rotation, 0]} scale={hill.scale}>
      <mesh position={[0, hill.height / 2 - 0.08, 0]}>
        <primitive attach="geometry" object={geometry} />
        <meshStandardMaterial vertexColors roughness={0.98} metalness={0} depthWrite {...surface} />
      </mesh>
    </group>
  );
}

export default function OpenWorldLandscape({ settings }) {
  const { accent, terrain, surface } = useOpenWorldPalette();
  const dayMix = openWorldDayMix(settings);

  const mountains = useMemo(() => {
    const result = [];
    const rand = seededRand(3187);
    const count = 28;

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + (rand() - 0.5) * 0.16;
      const radius = MOUNTAIN_INNER_RADIUS + rand() * MOUNTAIN_RADIUS_SPREAD;
      const height = 42 + rand() * 66;
      const base = 72 + rand() * 86;
      result.push({
        id: `mountain-${i}`,
        position: [Math.cos(angle) * radius, 0, Math.sin(angle) * radius],
        rotation: -angle + Math.PI / 2,
        height,
        radius: base,
        sides: rand() > 0.45 ? 4 : 5,
        light: 0.18 + rand() * 0.34,
        snow: rand() > 0.35 ? 1 : 0.35,
        scale: [1.1 + rand() * 1.8, 1, 0.2 + rand() * 0.22],
      });
    }

    return result;
  }, []);

  // A second, closer ring gives the playable city a landscape silhouette. The far
  // mountain ring is intentionally distant for orbital mode, but without this nearer
  // ring the empty/offline world reads as a flat plane until live buildings arrive.
  const nearHills = useMemo(() => {
    const result = [];
    const rand = seededRand(8421);
    const count = 14;

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + (rand() - 0.5) * 0.22;
      const radius = NEAR_HILL_INNER_RADIUS + rand() * NEAR_HILL_RADIUS_SPREAD;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      if (z < WORLD.shorelineZ + 6) continue;
      result.push({
        id: `near-hill-${i}`,
        position: [x, 0, z],
        rotation: -angle + Math.PI / 2,
        height: 6 + rand() * 12,
        radius: 8 + rand() * 10,
        sides: rand() > 0.45 ? 5 : 6,
        light: 0.22 + rand() * 0.32,
        cap: rand() > 0.7 ? 0.55 : 0.12,
        scale: [1.1 + rand() * 1.4, 0.72 + rand() * 0.28, 0.7 + rand() * 0.9],
      });
    }

    return result;
  }, []);

  const roadsideRocks = useMemo(() => {
    const rand = seededRand(6112);
    return Array.from({ length: 10 }, (_, i) => {
      const side = i % 2 === 0 ? -1 : 1;
      const row = Math.floor(i / 2);
      return {
        id: `roadside-rock-${i}`,
        position: [side * (6 + rand() * 2.2), 0, 38 + row * 7 + rand() * 2.2],
        rotation: rand() * Math.PI * 2,
        height: 0.9 + rand() * 1.2,
        radius: 0.8 + rand() * 0.7,
        sides: 5,
        light: 0.18 + rand() * 0.26,
        cap: 0,
        scale: [1.05 + rand() * 0.45, 0.7 + rand() * 0.2, 0.85 + rand() * 0.35],
      };
    });
  }, []);

  return (
    <group>
      <TerrainPlane dayMix={dayMix} accent={accent} terrain={terrain} />
      <group>
        {mountains.map((mountain) => (
          <Mountain key={mountain.id} mountain={mountain} dayMix={dayMix} surface={surface} />
        ))}
      </group>
      <group>
        {nearHills.map((hill) => (
          <NearHill key={hill.id} hill={hill} dayMix={dayMix} surface={surface} terrain={terrain} />
        ))}
      </group>
      <group>
        {roadsideRocks.map((rock) => (
          <NearHill key={rock.id} hill={rock} dayMix={dayMix} surface={surface} terrain={terrain} />
        ))}
      </group>
    </group>
  );
}
