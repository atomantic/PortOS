import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Rising ember/spark particles that float upward from the city streets

const EMBER_VERT = `
  attribute float size;
  attribute float speed;
  attribute float phase;
  attribute vec3 emberColor;
  uniform float uTime;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vColor = emberColor;
    vec3 pos = position;

    // Rise upward with drift
    float t = mod(uTime * speed + phase, 1.0);
    pos.y = mix(-1.0, 18.0, t);
    pos.x += sin(uTime * 0.5 + phase * 6.28) * 1.5 * t;
    pos.z += cos(uTime * 0.4 + phase * 3.14) * 1.0 * t;

    // Fade in at bottom, fade out at top
    vAlpha = smoothstep(0.0, 0.1, t) * smoothstep(1.0, 0.6, t);

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = size * (100.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const EMBER_FRAG = `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;

    // Bright core, soft edge
    float core = smoothstep(0.5, 0.0, d);
    float alpha = core * vAlpha * 0.7;

    // Hot white center
    vec3 color = mix(vColor, vec3(1.0, 0.95, 0.9), core * 0.4);

    gl_FragColor = vec4(color, alpha);
  }
`;

export default function CityEmbers() {
  const pointsRef = useRef();
  const matRef = useRef();

  const { positions, sizes, speeds, phases, colors, count } = useMemo(() => {
    const n = 120;
    const pos = new Float32Array(n * 3);
    const sz = new Float32Array(n);
    const spd = new Float32Array(n);
    const ph = new Float32Array(n);
    const col = new Float32Array(n * 3);

    const palette = [
      [1.0, 0.6, 0.1],  // orange
      [1.0, 0.3, 0.1],  // red-orange
      [0.0, 0.7, 0.8],  // cyan
      [0.9, 0.4, 0.9],  // pink
      [0.4, 0.3, 1.0],  // blue
    ];

    for (let i = 0; i < n; i++) {
      // Spread across the city area
      pos[i * 3] = (Math.random() - 0.5) * 50;
      pos[i * 3 + 1] = 0; // Animated in shader
      pos[i * 3 + 2] = (Math.random() - 0.5) * 50;

      sz[i] = 0.8 + Math.random() * 1.5;
      spd[i] = 0.03 + Math.random() * 0.06;
      ph[i] = Math.random();

      const c = palette[Math.floor(Math.random() * palette.length)];
      col[i * 3] = c[0];
      col[i * 3 + 1] = c[1];
      col[i * 3 + 2] = c[2];
    }

    return { positions: pos, sizes: sz, speeds: spd, phases: ph, colors: col, count: n };
  }, []);

  useFrame(({ clock }) => {
    if (matRef.current) {
      matRef.current.uniforms.uTime.value = clock.getElapsedTime();
    }
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={positions} itemSize={3} />
        <bufferAttribute attach="attributes-size" count={count} array={sizes} itemSize={1} />
        <bufferAttribute attach="attributes-speed" count={count} array={speeds} itemSize={1} />
        <bufferAttribute attach="attributes-phase" count={count} array={phases} itemSize={1} />
        <bufferAttribute attach="attributes-emberColor" count={count} array={colors} itemSize={3} />
      </bufferGeometry>
      <shaderMaterial
        ref={matRef}
        vertexShader={EMBER_VERT}
        fragmentShader={EMBER_FRAG}
        uniforms={{ uTime: { value: 0 } }}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  );
}
