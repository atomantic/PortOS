import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CITY_COLORS } from './cityConstants';

// Volumetric light cone shader
const CONE_VERT = `
  varying vec2 vUv;
  varying float vHeight;
  void main() {
    vUv = uv;
    vHeight = position.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CONE_FRAG = `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uIntensity;
  varying vec2 vUv;
  varying float vHeight;
  void main() {
    // Fade from bottom to top
    float alpha = (1.0 - vUv.y) * 0.12 * uIntensity;
    // Radial fade from center
    float radial = 1.0 - abs(vUv.x - 0.5) * 2.0;
    alpha *= radial * radial;
    // Slow shimmer
    alpha *= 0.8 + 0.2 * sin(uTime * 0.5 + vHeight * 2.0);
    // Noise-like variation
    float noise = sin(vUv.y * 30.0 + uTime) * 0.1;
    alpha += noise * 0.02;
    alpha = max(alpha, 0.0);
    gl_FragColor = vec4(uColor, alpha);
  }
`;

// A single volumetric light beam (upward cone)
function LightBeam({ position, color, height = 15, radius = 2, intensity = 1, phase = 0 }) {
  const matRef = useRef();

  const coneGeom = useMemo(() => {
    const geom = new THREE.CylinderGeometry(radius * 0.3, radius, height, 8, 16, true);
    return geom;
  }, [radius, height]);

  useFrame(({ clock }) => {
    if (!matRef.current) return;
    matRef.current.uniforms.uTime.value = clock.getElapsedTime() + phase;
  });

  const colorVec = useMemo(() => new THREE.Color(color), [color]);

  return (
    <group position={position}>
      <mesh geometry={coneGeom} position={[0, height / 2, 0]}>
        <shaderMaterial
          ref={matRef}
          vertexShader={CONE_VERT}
          fragmentShader={CONE_FRAG}
          uniforms={{
            uColor: { value: colorVec },
            uTime: { value: 0 },
            uIntensity: { value: intensity },
          }}
          transparent
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {/* Ground glow disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <circleGeometry args={[radius, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.08 * intensity}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

// Horizontal scanning laser beam between two points
function ScanBeam({ start, end, color, speed = 0.2, delay = 0 }) {
  const meshRef = useRef();

  const { length, midX, midZ, angle } = useMemo(() => {
    const dx = end[0] - start[0];
    const dz = end[2] - start[2];
    return {
      length: Math.sqrt(dx * dx + dz * dz),
      midX: (start[0] + end[0]) / 2,
      midZ: (start[2] + end[2]) / 2,
      angle: Math.atan2(dz, dx),
    };
  }, [start, end]);

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const t = clock.getElapsedTime();
    // Slowly fade in and out
    const cycle = ((t * speed + delay) % 4.0);
    meshRef.current.material.opacity = cycle < 2 ?
      Math.sin((cycle / 2) * Math.PI) * 0.06 : 0;
  });

  const y = 3 + Math.sin(delay * 7) * 2;

  return (
    <mesh
      ref={meshRef}
      position={[midX, y, midZ]}
      rotation={[-Math.PI / 2, 0, angle]}
    >
      <planeGeometry args={[length, 0.03]} />
      <meshBasicMaterial
        color={color}
        transparent
        opacity={0.05}
        blending={THREE.AdditiveBlending}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

export default function CityVolumetricLights({ positions }) {
  const beams = useMemo(() => {
    if (!positions || positions.size < 2) return { lights: [], scans: [] };

    const entries = [];
    positions.forEach((pos) => {
      if (pos.district === 'downtown') entries.push(pos);
    });

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    entries.forEach(p => {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    });

    const pad = 5;
    const colors = CITY_COLORS.neonAccents;

    // Spotlight beams at corners and edges of the city
    const lights = [
      { pos: [minX - pad, 0, minZ - pad], color: colors[0], height: 20, radius: 2.5, intensity: 0.8, phase: 0 },
      { pos: [maxX + pad, 0, minZ - pad], color: colors[1], height: 18, radius: 2, intensity: 0.7, phase: 1.5 },
      { pos: [minX - pad, 0, maxZ + pad], color: colors[4], height: 16, radius: 2, intensity: 0.6, phase: 3 },
      { pos: [maxX + pad, 0, maxZ + pad], color: colors[5], height: 22, radius: 3, intensity: 0.9, phase: 4.5 },
      // Center beam - tall and bright
      { pos: [(minX + maxX) / 2, 0, (minZ + maxZ) / 2], color: colors[0], height: 25, radius: 1.5, intensity: 0.5, phase: 2 },
    ];

    // Scanning laser beams across the city
    const scans = [
      { start: [minX - pad - 3, 0, minZ], end: [maxX + pad + 3, 0, minZ], color: colors[0], speed: 0.15, delay: 0 },
      { start: [minX, 0, minZ - pad - 3], end: [minX, 0, maxZ + pad + 3], color: colors[1], speed: 0.12, delay: 1 },
      { start: [minX - pad, 0, maxZ], end: [maxX + pad, 0, maxZ], color: colors[4], speed: 0.18, delay: 2 },
    ];

    return { lights, scans };
  }, [positions]);

  if (beams.lights.length === 0) return null;

  return (
    <group>
      {beams.lights.map((beam, i) => (
        <LightBeam
          key={`beam-${i}`}
          position={beam.pos}
          color={beam.color}
          height={beam.height}
          radius={beam.radius}
          intensity={beam.intensity}
          phase={beam.phase}
        />
      ))}
      {beams.scans.map((scan, i) => (
        <ScanBeam
          key={`scan-${i}`}
          start={scan.start}
          end={scan.end}
          color={scan.color}
          speed={scan.speed}
          delay={scan.delay}
        />
      ))}
    </group>
  );
}
