import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getTimeOfDayPreset } from './cityConstants';

// Vertex shader for shooting star trail
const TRAIL_VERT = `
  attribute float trailPosition;
  varying float vTrailPos;
  void main() {
    vTrailPos = trailPosition;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const TRAIL_FRAG = `
  varying float vTrailPos;
  uniform vec3 uColor;
  uniform float uOpacity;
  void main() {
    // Fade trail from bright head to transparent tail
    float alpha = smoothstep(0.0, 0.3, vTrailPos) * (1.0 - vTrailPos) * uOpacity;
    gl_FragColor = vec4(uColor, alpha * 0.8);
  }
`;

// A single shooting star with glowing head and fading trail
function ShootingStar({ index, playSfx, daylightRef }) {
  const groupRef = useRef();
  const headRef = useRef();
  const trailRef = useRef();
  const matRef = useRef();

  const state = useRef({
    active: false,
    nextSpawn: 3 + index * 5 + Math.random() * 10,
    progress: 0,
    speed: 0,
    startPos: [0, 0, 0],
    direction: [0, 0, 0],
    color: [1, 1, 1],
    length: 8,
  });

  const trailPoints = useMemo(() => {
    const segments = 20;
    const positions = new Float32Array(segments * 3);
    const trailPos = new Float32Array(segments);
    for (let i = 0; i < segments; i++) {
      trailPos[i] = i / (segments - 1); // 0 = head, 1 = tail
    }
    return { positions, trailPos, segments };
  }, []);

  const colors = useMemo(() => [
    [1.0, 1.0, 1.0],    // white
    [0.6, 0.8, 1.0],    // blue-white
    [1.0, 0.7, 0.3],    // golden
    [0.4, 1.0, 0.9],    // cyan
  ], []);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const s = state.current;

    const daylight = daylightRef?.current ?? 0;
    const nightFactor = 1 - daylight;

    if (!s.active) {
      // Block spawning when daylight > 0.5
      if (t > s.nextSpawn && daylight <= 0.5) {
        // Spawn a new shooting star
        s.active = true;
        s.progress = 0;
        s.speed = 0.6 + Math.random() * 0.8;
        playSfx?.('shootingStar');
        s.length = 6 + Math.random() * 6;

        // Random start position in upper sky hemisphere
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.random() * 0.4; // Near top
        const r = 55 + Math.random() * 20;
        s.startPos = [
          r * Math.sin(phi) * Math.cos(theta),
          r * Math.cos(phi) + 10,
          r * Math.sin(phi) * Math.sin(theta),
        ];

        // Direction: downward and across
        const dx = (Math.random() - 0.5) * 2;
        const dy = -0.5 - Math.random() * 0.5;
        const dz = (Math.random() - 0.5) * 2;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        s.direction = [dx / len, dy / len, dz / len];

        s.color = colors[Math.floor(Math.random() * colors.length)];
      }
      if (headRef.current) headRef.current.visible = false;
      if (trailRef.current) trailRef.current.visible = false;
      return;
    }

    // Advance the star
    s.progress += s.speed * 0.016; // ~60fps delta

    if (s.progress > 1.5) {
      // Star has crossed the sky
      s.active = false;
      s.nextSpawn = t + 5 + Math.random() * 15;
      return;
    }

    // Current head position
    const totalDist = s.length * 8;
    const headX = s.startPos[0] + s.direction[0] * totalDist * s.progress;
    const headY = s.startPos[1] + s.direction[1] * totalDist * s.progress;
    const headZ = s.startPos[2] + s.direction[2] * totalDist * s.progress;

    // Update head glow (scale opacity by nightFactor)
    if (headRef.current) {
      headRef.current.visible = true;
      headRef.current.position.set(headX, headY, headZ);
      headRef.current.material.opacity = Math.min(1, (1 - s.progress) * 2) * nightFactor;
    }

    // Update trail geometry
    if (trailRef.current) {
      trailRef.current.visible = true;
      const posAttr = trailRef.current.geometry.attributes.position;
      for (let i = 0; i < trailPoints.segments; i++) {
        const tp = (i / (trailPoints.segments - 1)) * s.length;
        posAttr.array[i * 3] = headX - s.direction[0] * tp;
        posAttr.array[i * 3 + 1] = headY - s.direction[1] * tp;
        posAttr.array[i * 3 + 2] = headZ - s.direction[2] * tp;
      }
      posAttr.needsUpdate = true;
    }

    if (matRef.current) {
      matRef.current.uniforms.uColor.value.set(s.color[0], s.color[1], s.color[2]);
      matRef.current.uniforms.uOpacity.value = Math.min(1, (1 - s.progress) * 2.5) * nightFactor;
    }
  });

  return (
    <group ref={groupRef}>
      {/* Glowing head */}
      <mesh ref={headRef} visible={false}>
        <sphereGeometry args={[0.15, 8, 8]} />
        <meshBasicMaterial
          color="#ffffff"
          transparent
          opacity={1}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {/* Trail line */}
      <line ref={trailRef} visible={false}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            count={trailPoints.segments}
            array={trailPoints.positions}
            itemSize={3}
          />
          <bufferAttribute
            attach="attributes-trailPosition"
            count={trailPoints.segments}
            array={trailPoints.trailPos}
            itemSize={1}
          />
        </bufferGeometry>
        <shaderMaterial
          ref={matRef}
          vertexShader={TRAIL_VERT}
          fragmentShader={TRAIL_FRAG}
          uniforms={{
            uColor: { value: new THREE.Color(1, 1, 1) },
            uOpacity: { value: 1.0 },
          }}
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </line>
    </group>
  );
}

export default function CityShootingStars({ playSfx, settings }) {
  const daylightRef = useRef(0);
  const timeOfDay = settings?.timeOfDay ?? 'sunset';
  const skyTheme = settings?.skyTheme ?? 'cyberpunk';
  const preset = getTimeOfDayPreset(timeOfDay, skyTheme);
  const targetDaylight = preset.daylightFactor ?? 0;

  useFrame((_, delta) => {
    const lf = Math.min(1, delta * 3);
    daylightRef.current += (targetDaylight - daylightRef.current) * lf;
  });

  return (
    <group>
      {/* 3 potential shooting stars, staggered spawn times */}
      <ShootingStar index={0} playSfx={playSfx} daylightRef={daylightRef} />
      <ShootingStar index={1} playSfx={playSfx} daylightRef={daylightRef} />
      <ShootingStar index={2} playSfx={playSfx} daylightRef={daylightRef} />
    </group>
  );
}
