import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { cityDayMix, mixHex, seededRand, smoothstepRange } from './cityConstants';
import { useCityPalette } from './CityPaletteContext';

const TERRAIN_SIZE = 2400;
const MOUNTAIN_INNER_RADIUS = 560;
const MOUNTAIN_RADIUS_SPREAD = 190;

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
    float cityTrace = (1.0 - meadowMix) * 0.08 * (1.0 - uDayMix * 0.65);
    color = mix(color, uAccent, cityTrace);

    gl_FragColor = vec4(color, 1.0);
  }
`;

function TerrainPlane({ dayMix, accent }) {
  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: TERRAIN_VERT,
    fragmentShader: TERRAIN_FRAG,
    uniforms: {
      uInner: { value: new THREE.Color(mixHex('#202426', '#686d68', dayMix)) },
      uMeadow: { value: new THREE.Color(mixHex('#172719', '#6f8758', dayMix)) },
      uRidge: { value: new THREE.Color(mixHex('#111827', '#8d937f', dayMix)) },
      uAccent: { value: new THREE.Color(accent) },
      uDayMix: { value: dayMix },
    },
    side: THREE.DoubleSide,
    depthWrite: true,
    // accent intentionally NOT a dep — a theme switch updates the uniform in
    // place (effect below) rather than recompiling the GLSL program. Matches the
    // imperative-uniform pattern in CitySky / CityBillboards / CityVolumetricLights.
  }), [dayMix]); // eslint-disable-line react-hooks/exhaustive-deps

  // Push the accent into the existing material on theme change — no rebuild.
  useEffect(() => { material.uniforms.uAccent.value.set(accent); }, [material, accent]);

  // R3F doesn't dispose a material handed in via the `material` prop, so free the
  // prior one when dayMix flips (Day/Night toggle) and on unmount.
  useEffect(() => () => material.dispose(), [material]);

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.08, 0]}
      material={material}
      frustumCulled={false}
    >
      <planeGeometry args={[TERRAIN_SIZE, TERRAIN_SIZE, 1, 1]} />
    </mesh>
  );
}

function Mountain({ mountain, dayMix }) {
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
        />
      </mesh>
    </group>
  );
}

export default function CityLandscape({ settings }) {
  const { accent } = useCityPalette();
  const dayMix = cityDayMix(settings);

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

  return (
    <group>
      <TerrainPlane dayMix={dayMix} accent={accent} />
      <group>
        {mountains.map((mountain) => (
          <Mountain key={mountain.id} mountain={mountain} dayMix={dayMix} />
        ))}
      </group>
    </group>
  );
}
