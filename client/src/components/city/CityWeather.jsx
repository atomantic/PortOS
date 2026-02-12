import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Rain particle shader - elongated drops falling downward
const RAIN_VERT = `
  attribute float speed;
  attribute float offset;
  uniform float uTime;
  varying float vAlpha;
  void main() {
    vec3 pos = position;
    // Animate downward, looping
    float t = mod(uTime * speed + offset, 1.0);
    pos.y = mix(25.0, -2.0, t);
    vAlpha = smoothstep(0.0, 0.1, t) * smoothstep(1.0, 0.8, t);
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    // Elongated point to simulate a rain streak
    gl_PointSize = 2.5 * (150.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const RAIN_FRAG = `
  varying float vAlpha;
  void main() {
    // Elongated vertical drop shape
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(vec2(uv.x * 3.0, uv.y));
    if (d > 0.5) discard;
    float alpha = smoothstep(0.5, 0.1, d) * vAlpha * 0.4;
    gl_FragColor = vec4(0.4, 0.7, 1.0, alpha);
  }
`;

// Lightning flash - brief bright flash across the scene
function LightningFlash({ active, playSfx }) {
  const lightRef = useRef();
  const flashState = useRef({ nextFlash: 0, intensity: 0, flickerCount: 0 });

  useFrame(({ clock }) => {
    if (!lightRef.current || !active) {
      if (lightRef.current) lightRef.current.intensity = 0;
      return;
    }
    const t = clock.getElapsedTime();
    const state = flashState.current;

    if (t > state.nextFlash && state.intensity === 0) {
      // Trigger new flash (every 8-20 seconds when active)
      state.intensity = 2.0 + Math.random() * 3.0;
      state.flickerCount = 2 + Math.floor(Math.random() * 3);
      state.nextFlash = t + 8 + Math.random() * 12;
      playSfx?.('lightning');
    }

    if (state.intensity > 0) {
      // Rapid decay with flicker
      state.intensity *= 0.85;
      if (state.flickerCount > 0 && state.intensity < 0.5) {
        state.intensity = 1.5 + Math.random() * 2;
        state.flickerCount--;
      }
      if (state.intensity < 0.05) state.intensity = 0;
    }

    lightRef.current.intensity = state.intensity;
  });

  return (
    <pointLight
      ref={lightRef}
      position={[Math.random() * 40 - 20, 30, Math.random() * 40 - 20]}
      color="#b4d4ff"
      intensity={0}
      distance={100}
      decay={1.5}
    />
  );
}

export default function CityWeather({ stoppedCount = 0, totalCount = 1, playSfx }) {
  const pointsRef = useRef();
  const matRef = useRef();

  // Weather intensity based on system health (more stopped = more rain)
  const healthRatio = totalCount > 0 ? stoppedCount / totalCount : 0;
  const rainIntensity = healthRatio; // 0 = clear, 1 = heavy rain
  const showLightning = healthRatio > 0.3;

  const rainCount = Math.floor(rainIntensity * 400);

  const { positions, speeds, offsets } = useMemo(() => {
    const count = 400; // Max particles, we'll show a subset based on intensity
    const pos = new Float32Array(count * 3);
    const spd = new Float32Array(count);
    const off = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 60;
      pos[i * 3 + 1] = Math.random() * 25;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 60;
      spd[i] = 0.3 + Math.random() * 0.5;
      off[i] = Math.random();
    }

    return { positions: pos, speeds: spd, offsets: off };
  }, []);

  useFrame(({ clock }) => {
    if (matRef.current) {
      matRef.current.uniforms.uTime.value = clock.getElapsedTime();
    }
  });

  if (rainCount < 5) return null;

  return (
    <group>
      <points ref={pointsRef}>
        <bufferGeometry drawRange={{ start: 0, count: rainCount }}>
          <bufferAttribute attach="attributes-position" count={positions.length / 3} array={positions} itemSize={3} />
          <bufferAttribute attach="attributes-speed" count={speeds.length} array={speeds} itemSize={1} />
          <bufferAttribute attach="attributes-offset" count={offsets.length} array={offsets} itemSize={1} />
        </bufferGeometry>
        <shaderMaterial
          ref={matRef}
          vertexShader={RAIN_VERT}
          fragmentShader={RAIN_FRAG}
          uniforms={{ uTime: { value: 0 } }}
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </points>
      {showLightning && <LightningFlash active={showLightning} playSfx={playSfx} />}
    </group>
  );
}
