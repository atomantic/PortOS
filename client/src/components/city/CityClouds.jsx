import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const CLOUD_COUNT = 18;
const CLOUD_SPREAD_X = 200;
const CLOUD_SPREAD_Z = 200;
const CLOUD_MIN_Y = 60;
const CLOUD_MAX_Y = 100;
const WIND_SPEED = 1.5;

// Soft cloud billboard shader
const CLOUD_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CLOUD_FRAG = `
  uniform float uOpacity;
  uniform vec3 uColor;
  uniform float uTime;
  varying vec2 vUv;

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
    vec2 uv = vUv;
    // Cloud shape: soft ellipse with noise-based edges
    vec2 centered = (uv - 0.5) * 2.0;
    // Stretch horizontally for flatter clouds
    centered.x *= 0.7;
    float dist = length(centered);
    // Noise for irregular edges
    float n = noise(uv * 4.0 + uTime * 0.05) * 0.3;
    n += noise(uv * 8.0 - uTime * 0.03) * 0.15;
    float shape = smoothstep(1.0 + n, 0.3, dist);
    // Inner brightness variation
    float inner = noise(uv * 3.0 + uTime * 0.02) * 0.2 + 0.8;
    vec3 color = uColor * inner;
    float alpha = shape * uOpacity;
    gl_FragColor = vec4(color, alpha);
  }
`;

function Cloud({ position, scale, speed, seed }) {
  const meshRef = useRef();
  const initialX = position[0];

  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: CLOUD_VERT,
    fragmentShader: CLOUD_FRAG,
    uniforms: {
      uOpacity: { value: 0.6 },
      uColor: { value: new THREE.Color('#ffffff') },
      uTime: { value: seed * 100 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  }), [seed]);

  useEffect(() => () => material.dispose(), [material]);

  useFrame(({ clock, camera }) => {
    if (!meshRef.current) return;
    const t = clock.getElapsedTime();
    material.uniforms.uTime.value = t + seed * 100;

    // Drift with wind, wrap around
    const drift = ((t * speed * WIND_SPEED + initialX + CLOUD_SPREAD_X) % (CLOUD_SPREAD_X * 2)) - CLOUD_SPREAD_X;
    meshRef.current.position.x = drift;

    // Billboard: face camera
    meshRef.current.quaternion.copy(camera.quaternion);
  });

  return (
    <mesh ref={meshRef} position={position} scale={scale} material={material}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}

export default function CityClouds({ settings }) {
  const skyTheme = settings?.skyTheme ?? 'cyberpunk';
  const visible = skyTheme === 'dreamworld';

  const clouds = useMemo(() => {
    const items = [];
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const seed = i / CLOUD_COUNT;
      const x = (Math.random() - 0.5) * CLOUD_SPREAD_X * 2;
      const y = CLOUD_MIN_Y + Math.random() * (CLOUD_MAX_Y - CLOUD_MIN_Y);
      const z = (Math.random() - 0.5) * CLOUD_SPREAD_Z * 2;
      const baseScale = 15 + Math.random() * 25;
      const scaleY = baseScale * (0.3 + Math.random() * 0.3);
      const speed = 0.3 + Math.random() * 0.7;
      items.push({
        key: i,
        position: [x, y, z],
        scale: [baseScale, scaleY, 1],
        speed,
        seed,
      });
    }
    return items;
  }, []);

  if (!visible) return null;

  return (
    <group>
      {clouds.map(c => (
        <Cloud
          key={c.key}
          position={c.position}
          scale={c.scale}
          speed={c.speed}
          seed={c.seed}
        />
      ))}
    </group>
  );
}
