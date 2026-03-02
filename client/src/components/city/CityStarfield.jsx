import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getTimeOfDayPreset } from './cityConstants';

const STAR_VERT = `
  attribute float size;
  attribute float phase;
  attribute vec3 starColor;
  varying float vPhase;
  varying vec3 vColor;
  uniform float uTime;
  void main() {
    vPhase = phase;
    vColor = starColor;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (200.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const STAR_FRAG = `
  varying float vPhase;
  varying vec3 vColor;
  uniform float uTime;
  uniform float uDaylight;
  void main() {
    // Soft circular point
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float alpha = smoothstep(0.5, 0.15, d);
    // Twinkle: slow shimmer unique per star
    float twinkle = 0.7 + 0.3 * sin(uTime * (0.4 + vPhase * 0.6) + vPhase * 6.2831);
    // Fade out during daytime
    float nightFactor = 1.0 - uDaylight;
    gl_FragColor = vec4(vColor, alpha * twinkle * nightFactor);
  }
`;

export default function CityStarfield({ settings }) {
  const pointsRef = useRef();
  const matRef = useRef();
  const daylightRef = useRef(0);

  const { positions, sizes, phases, colors } = useMemo(() => {
    const count = 1500;
    const pos = new Float32Array(count * 3);
    const sz = new Float32Array(count);
    const ph = new Float32Array(count);
    const col = new Float32Array(count * 3);

    // Star color palette: white, blue-white, warm-white, cyan-tinted
    const palette = [
      [1.0, 1.0, 1.0],
      [0.8, 0.85, 1.0],
      [1.0, 0.95, 0.85],
      [0.75, 0.9, 1.0],
      [0.85, 0.8, 1.0],
    ];

    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.5; // Upper hemisphere
      const r = 60 + Math.random() * 50;

      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi) + 8;
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);

      // Most stars small, a few bright ones
      const bright = Math.random();
      sz[i] = bright < 0.05 ? 2.0 + Math.random() * 1.5 : 0.4 + Math.random() * 1.0;

      ph[i] = Math.random(); // Unique twinkle phase

      const c = palette[Math.floor(Math.random() * palette.length)];
      col[i * 3] = c[0];
      col[i * 3 + 1] = c[1];
      col[i * 3 + 2] = c[2];
    }

    return { positions: pos, sizes: sz, phases: ph, colors: col };
  }, []);

  const timeOfDay = settings?.timeOfDay ?? 'sunset';
  const skyTheme = settings?.skyTheme ?? 'cyberpunk';
  const preset = getTimeOfDayPreset(timeOfDay, skyTheme);
  const targetDaylight = preset.daylightFactor ?? 0;

  useFrame(({ clock }, delta) => {
    if (!pointsRef.current) return;
    pointsRef.current.rotation.y = clock.getElapsedTime() * 0.003;
    // Lerp daylight uniform toward target
    const lf = Math.min(1, delta * 3);
    daylightRef.current += (targetDaylight - daylightRef.current) * lf;
    if (matRef.current) {
      matRef.current.uniforms.uTime.value = clock.getElapsedTime();
      matRef.current.uniforms.uDaylight.value = daylightRef.current;
    }
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={positions.length / 3} array={positions} itemSize={3} />
        <bufferAttribute attach="attributes-size" count={sizes.length} array={sizes} itemSize={1} />
        <bufferAttribute attach="attributes-phase" count={phases.length} array={phases} itemSize={1} />
        <bufferAttribute attach="attributes-starColor" count={colors.length / 3} array={colors} itemSize={3} />
      </bufferGeometry>
      <shaderMaterial
        ref={matRef}
        vertexShader={STAR_VERT}
        fragmentShader={STAR_FRAG}
        uniforms={{ uTime: { value: 0 }, uDaylight: { value: 0 } }}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        fog={false}
      />
    </points>
  );
}
