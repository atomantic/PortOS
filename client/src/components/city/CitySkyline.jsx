import { useMemo } from 'react';
import * as THREE from 'three';

// Distant cyberpunk skyline silhouettes with neon trim
// Creates a ring of faint skyscraper outlines around the city perimeter

const SKYLINE_VERT = `
  varying vec2 vUv;
  varying float vHeight;
  void main() {
    vUv = uv;
    vHeight = position.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKYLINE_FRAG = `
  uniform vec3 uColor;
  uniform vec3 uAccent;
  uniform float uMaxHeight;
  varying vec2 vUv;
  varying float vHeight;
  void main() {
    // Dark body that fades near top
    float bodyAlpha = 0.15 * (1.0 - vUv.y * 0.5);

    // Window dots - grid of small lit windows
    float cellX = fract(vUv.x * 8.0);
    float cellY = fract(vUv.y * 20.0);
    float window = step(0.3, cellX) * step(cellX, 0.7) * step(0.3, cellY) * step(cellY, 0.65);

    // Only some windows lit (pseudo-random via position)
    float lit = step(0.55, fract(sin(floor(vUv.x * 8.0) * 127.1 + floor(vUv.y * 20.0) * 311.7) * 43758.5453));
    window *= lit;

    vec3 color = mix(vec3(0.02, 0.02, 0.05), uAccent, window * 0.5);
    float alpha = bodyAlpha + window * 0.15;

    // Neon trim at top edge
    float topLine = smoothstep(0.98, 1.0, vUv.y);
    color = mix(color, uAccent, topLine);
    alpha = max(alpha, topLine * 0.4);

    // Neon trim at bottom
    float bottomLine = smoothstep(0.02, 0.0, vUv.y);
    color = mix(color, uColor, bottomLine);
    alpha = max(alpha, bottomLine * 0.3);

    // Fade with distance (atmospheric perspective)
    alpha *= 0.7;

    gl_FragColor = vec4(color, alpha);
  }
`;

// Create a single skyline building silhouette
function DistantBuilding({ position, width, height, color, accent }) {
  const colorVec = useMemo(() => new THREE.Color(color), [color]);
  const accentVec = useMemo(() => new THREE.Color(accent), [accent]);

  return (
    <mesh position={[position[0], height / 2, position[2]]}>
      <boxGeometry args={[width, height, width * 0.3]} />
      <shaderMaterial
        vertexShader={SKYLINE_VERT}
        fragmentShader={SKYLINE_FRAG}
        uniforms={{
          uColor: { value: colorVec },
          uAccent: { value: accentVec },
          uMaxHeight: { value: height },
        }}
        transparent
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}

export default function CitySkyline() {
  const buildings = useMemo(() => {
    const result = [];
    const colors = ['#06b6d4', '#ec4899', '#8b5cf6', '#3b82f6', '#22c55e', '#f97316'];
    const accents = ['#06b6d4', '#ec4899', '#8b5cf6', '#3b82f6', '#f43f5e', '#a855f7'];

    // Seeded random for consistent skyline
    let s = 42;
    const rand = () => { s = (s * 16807 + 0) % 2147483647; return (s & 0x7fffffff) / 2147483647; };

    const radius = 55;
    const count = 60;

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + rand() * 0.1;
      const r = radius + rand() * 15 - 7;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;

      const bWidth = 1.5 + rand() * 4;
      const bHeight = 5 + rand() * 25;
      const colorIdx = Math.floor(rand() * colors.length);

      result.push({
        id: `skyline-${i}`,
        position: [x, 0, z],
        width: bWidth,
        height: bHeight,
        color: colors[colorIdx],
        accent: accents[colorIdx],
      });
    }

    return result;
  }, []);

  return (
    <group>
      {buildings.map(b => (
        <DistantBuilding
          key={b.id}
          position={b.position}
          width={b.width}
          height={b.height}
          color={b.color}
          accent={b.accent}
        />
      ))}
    </group>
  );
}
