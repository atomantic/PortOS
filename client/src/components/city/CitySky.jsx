import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CITY_COLORS } from './cityConstants';

// Sun position: low on horizon, slightly off-center for drama
const SUN_POSITION = [-60, 8, -80];
const SUN_DIRECTION = new THREE.Vector3(...SUN_POSITION).normalize().negate();

// Sky dome gradient shader (inverted sphere)
const SkyDomeShader = {
  vertexShader: `
    varying vec3 vWorldPosition;
    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPos.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 uZenith;
    uniform vec3 uMidSky;
    uniform vec3 uHorizonHigh;
    uniform vec3 uHorizonLow;
    uniform vec3 uSunDirection;
    uniform float uTime;
    varying vec3 vWorldPosition;

    // Simple noise for subtle atmosphere ripple
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
      vec3 dir = normalize(vWorldPosition);
      // Height factor: 0 at horizon, 1 at zenith
      float h = max(dir.y, 0.0);

      // Base gradient bands
      vec3 color = uHorizonLow;
      color = mix(color, uHorizonHigh, smoothstep(0.0, 0.08, h));
      color = mix(color, uMidSky, smoothstep(0.05, 0.25, h));
      color = mix(color, uZenith, smoothstep(0.2, 0.6, h));

      // Sun glow on horizon
      float sunDot = max(dot(dir, uSunDirection), 0.0);
      float sunGlow = pow(sunDot, 8.0) * 0.4;
      color += vec3(1.0, 0.3, 0.15) * sunGlow;
      // Wider warm wash
      float warmWash = pow(sunDot, 3.0) * 0.15;
      color += vec3(0.8, 0.2, 0.3) * warmWash;

      // Subtle noise ripple for living atmosphere
      float n = noise(dir.xz * 3.0 + uTime * 0.02) * 0.03;
      color += n;

      // Below horizon: fade to black
      float belowFade = smoothstep(0.0, -0.05, dir.y);
      color = mix(color, vec3(0.01, 0.01, 0.03), belowFade);

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

// Glowing sun mesh on the horizon
function Sun({ brightnessRef }) {
  const sunRef = useRef();
  const haloRef = useRef();

  useFrame(({ clock }) => {
    if (!sunRef.current) return;
    const t = clock.getElapsedTime();
    // Gentle pulse
    const pulse = 1.0 + Math.sin(t * 0.5) * 0.1;
    sunRef.current.material.emissiveIntensity = 2.0 * pulse;
    if (haloRef.current) {
      haloRef.current.material.opacity = 0.15 + Math.sin(t * 0.3) * 0.05;
    }
  });

  return (
    <group position={SUN_POSITION}>
      {/* Sun core */}
      <mesh ref={sunRef}>
        <sphereGeometry args={[4, 24, 24]} />
        <meshStandardMaterial
          color={CITY_COLORS.sky.sunCore}
          emissive={CITY_COLORS.sky.sunCore}
          emissiveIntensity={2.0}
          toneMapped={false}
        />
      </mesh>
      {/* Glow halo ring */}
      <mesh ref={haloRef} rotation={[0, 0, 0]}>
        <ringGeometry args={[5, 14, 32]} />
        <meshBasicMaterial
          color={CITY_COLORS.sky.sunGlow}
          transparent
          opacity={0.15}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

// Directional light from the sun position
function SunLight({ brightnessRef }) {
  const ref = useRef();

  useFrame(() => {
    if (!ref.current) return;
    ref.current.intensity = 0.6 * brightnessRef.current;
  });

  return (
    <directionalLight
      ref={ref}
      position={SUN_POSITION}
      target-position={[0, 0, 0]}
      intensity={0.6}
      color={CITY_COLORS.sky.sunLight}
    />
  );
}

export default function CitySky({ settings }) {
  const brightnessRef = useRef(settings?.ambientBrightness ?? 1.2);
  brightnessRef.current = settings?.ambientBrightness ?? 1.2;

  const skyMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      vertexShader: SkyDomeShader.vertexShader,
      fragmentShader: SkyDomeShader.fragmentShader,
      uniforms: {
        uZenith: { value: new THREE.Color(CITY_COLORS.sky.zenith) },
        uMidSky: { value: new THREE.Color(CITY_COLORS.sky.midSky) },
        uHorizonHigh: { value: new THREE.Color(CITY_COLORS.sky.horizonHigh) },
        uHorizonLow: { value: new THREE.Color(CITY_COLORS.sky.horizonLow) },
        uSunDirection: { value: SUN_DIRECTION },
        uTime: { value: 0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
    });
  }, []);

  useFrame(({ clock }) => {
    skyMaterial.uniforms.uTime.value = clock.getElapsedTime();
  });

  return (
    <group>
      {/* Sky dome - large inverted sphere */}
      <mesh material={skyMaterial}>
        <sphereGeometry args={[500, 32, 32]} />
      </mesh>
      <Sun brightnessRef={brightnessRef} />
      <SunLight brightnessRef={brightnessRef} />
    </group>
  );
}
