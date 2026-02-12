import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CITY_COLORS } from './cityConstants';

const SUN_RADIUS = 100;

// Compute sun/moon position from hour (0-24) along a proper overhead arc
// 6h = east horizon, 12h = high overhead, 18h = west horizon, 0h = below (north)
const getArcPosition = (hour) => {
  // Normalize hour to 0-2PI, where 6h=0 (sunrise east), 12h=PI/2 (overhead), 18h=PI (sunset west)
  const t = ((hour - 6) / 24) * Math.PI * 2;
  // Elevation: sin curve, peaks at noon (t=PI/2), dips below at midnight
  const elevation = Math.sin(t);
  // Azimuth: sweeps from east(0) through south(PI/2) to west(PI) to north
  const azimuth = t;
  const y = elevation * SUN_RADIUS;
  const horizontalR = Math.cos(Math.asin(Math.min(1, Math.max(-1, elevation)))) * SUN_RADIUS;
  const x = Math.cos(azimuth) * horizontalR;
  const z = -Math.sin(azimuth) * horizontalR;
  return [x, y, z];
};

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
    uniform float uSunIntensity;
    uniform float uIsMoon;
    uniform float uTime;
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
      vec3 dir = normalize(vWorldPosition);
      float h = max(dir.y, 0.0);

      // Base gradient bands
      vec3 color = uHorizonLow;
      color = mix(color, uHorizonHigh, smoothstep(0.0, 0.08, h));
      color = mix(color, uMidSky, smoothstep(0.05, 0.25, h));
      color = mix(color, uZenith, smoothstep(0.2, 0.6, h));

      // Glow around sun/moon
      float bodyDot = max(dot(dir, normalize(uSunDirection)), 0.0);

      if (uIsMoon < 0.5) {
        // Sun: warm orange/red glow
        float sunGlow = pow(bodyDot, 8.0) * 0.4 * uSunIntensity;
        color += vec3(1.0, 0.3, 0.15) * sunGlow;
        float warmWash = pow(bodyDot, 3.0) * 0.15 * uSunIntensity;
        color += vec3(0.8, 0.2, 0.3) * warmWash;
      } else {
        // Moon: cool silver/blue glow
        float moonGlow = pow(bodyDot, 12.0) * 0.3 * uSunIntensity;
        color += vec3(0.6, 0.65, 0.9) * moonGlow;
        float coolWash = pow(bodyDot, 4.0) * 0.08 * uSunIntensity;
        color += vec3(0.3, 0.35, 0.6) * coolWash;
      }

      // Subtle noise ripple
      float n = noise(dir.xz * 3.0 + uTime * 0.02) * 0.03;
      color += n;

      // Below horizon: fade to dark
      float belowFade = smoothstep(0.0, -0.05, dir.y);
      color = mix(color, vec3(0.01, 0.01, 0.03), belowFade);

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

// Lerp THREE.Color in place
const lerpColor = (target, a, b, t) => {
  target.r = a.r + (b.r - a.r) * t;
  target.g = a.g + (b.g - a.g) * t;
  target.b = a.b + (b.b - a.b) * t;
};

// Pre-allocate parsed preset colors
const presetColors = {};
const getPresetColors = (name) => {
  if (!presetColors[name]) {
    const p = CITY_COLORS.timeOfDay[name];
    presetColors[name] = {
      zenith: new THREE.Color(p.zenith),
      midSky: new THREE.Color(p.midSky),
      horizonHigh: new THREE.Color(p.horizonHigh),
      horizonLow: new THREE.Color(p.horizonLow),
      sunCore: new THREE.Color(p.sunCore),
      sunGlow: new THREE.Color(p.sunGlow),
      sunLight: new THREE.Color(p.sunLight),
      hour: p.hour,
      sunIntensity: p.sunIntensity,
      sunScale: p.sunScale,
      isMoon: p.isMoon,
      daylightFactor: p.daylightFactor,
    };
  }
  return presetColors[name];
};

// Sun/Moon mesh
function CelestialBody({ groupRef }) {
  const bodyRef = useRef();
  const haloRef = useRef();

  useFrame(({ clock }) => {
    if (!bodyRef.current) return;
    const t = clock.getElapsedTime();
    const pulse = 1.0 + Math.sin(t * 0.5) * 0.1;
    bodyRef.current.material.emissiveIntensity = 2.0 * pulse;
    if (haloRef.current) {
      haloRef.current.material.opacity = 0.15 + Math.sin(t * 0.3) * 0.05;
    }
  });

  return (
    <group ref={groupRef}>
      <mesh ref={bodyRef}>
        <sphereGeometry args={[4, 24, 24]} />
        <meshStandardMaterial
          color="#ffaa44"
          emissive="#ffaa44"
          emissiveIntensity={2.0}
          toneMapped={false}
        />
      </mesh>
      <mesh ref={haloRef}>
        <ringGeometry args={[5, 14, 32]} />
        <meshBasicMaterial
          color="#ff6080"
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

export default function CitySky({ settings }) {
  const brightnessRef = useRef(settings?.ambientBrightness ?? 1.2);
  brightnessRef.current = settings?.ambientBrightness ?? 1.2;

  const timeOfDayRef = useRef(settings?.timeOfDay ?? 'sunset');
  timeOfDayRef.current = settings?.timeOfDay ?? 'sunset';

  const currentPresetRef = useRef(timeOfDayRef.current);
  const transitionRef = useRef(1.0);

  const bodyGroupRef = useRef();
  const lightRef = useRef();
  const currentScaleRef = useRef(1.0);
  const currentHourRef = useRef(18); // start at sunset

  const skyMaterial = useMemo(() => {
    const preset = getPresetColors('sunset');
    const initPos = getArcPosition(18);
    return new THREE.ShaderMaterial({
      vertexShader: SkyDomeShader.vertexShader,
      fragmentShader: SkyDomeShader.fragmentShader,
      uniforms: {
        uZenith: { value: preset.zenith.clone() },
        uMidSky: { value: preset.midSky.clone() },
        uHorizonHigh: { value: preset.horizonHigh.clone() },
        uHorizonLow: { value: preset.horizonLow.clone() },
        uSunDirection: { value: new THREE.Vector3(...initPos).normalize() },
        uSunIntensity: { value: preset.sunIntensity },
        uIsMoon: { value: 0.0 },
        uTime: { value: 0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
    });
  }, []);

  useFrame(({ clock }, delta) => {
    const target = timeOfDayRef.current;
    const brightness = brightnessRef.current;

    if (currentPresetRef.current !== target) {
      currentPresetRef.current = target;
      transitionRef.current = 0;
    }

    transitionRef.current = Math.min(1.0, transitionRef.current + delta * 1.5);
    const lerpFactor = transitionRef.current < 1 ? delta * 3 : 1;

    const preset = getPresetColors(target);

    // Lerp hour along shortest path on the 24h clock
    let hourDiff = preset.hour - currentHourRef.current;
    if (hourDiff > 12) hourDiff -= 24;
    if (hourDiff < -12) hourDiff += 24;
    currentHourRef.current += hourDiff * lerpFactor;
    // Wrap to 0-24
    if (currentHourRef.current < 0) currentHourRef.current += 24;
    if (currentHourRef.current >= 24) currentHourRef.current -= 24;

    // Compute sun position from current hour on the arc
    const bodyPos = getArcPosition(currentHourRef.current);
    const bodyDir = new THREE.Vector3(...bodyPos).normalize();

    // Lerp sky dome colors
    lerpColor(skyMaterial.uniforms.uZenith.value, skyMaterial.uniforms.uZenith.value, preset.zenith, lerpFactor);
    lerpColor(skyMaterial.uniforms.uMidSky.value, skyMaterial.uniforms.uMidSky.value, preset.midSky, lerpFactor);
    lerpColor(skyMaterial.uniforms.uHorizonHigh.value, skyMaterial.uniforms.uHorizonHigh.value, preset.horizonHigh, lerpFactor);
    lerpColor(skyMaterial.uniforms.uHorizonLow.value, skyMaterial.uniforms.uHorizonLow.value, preset.horizonLow, lerpFactor);

    // Update sun direction directly from arc position
    skyMaterial.uniforms.uSunDirection.value.copy(bodyDir);
    skyMaterial.uniforms.uSunIntensity.value += (preset.sunIntensity - skyMaterial.uniforms.uSunIntensity.value) * lerpFactor;
    skyMaterial.uniforms.uIsMoon.value += ((preset.isMoon ? 1.0 : 0.0) - skyMaterial.uniforms.uIsMoon.value) * lerpFactor;
    skyMaterial.uniforms.uTime.value = clock.getElapsedTime();

    // Move celestial body mesh
    if (bodyGroupRef.current) {
      const sp = bodyGroupRef.current.position;
      sp.set(bodyPos[0], bodyPos[1], bodyPos[2]);

      currentScaleRef.current += (preset.sunScale - currentScaleRef.current) * lerpFactor;
      const s = currentScaleRef.current;
      bodyGroupRef.current.scale.set(s, s, s);

      const bodyMesh = bodyGroupRef.current.children[0];
      const haloMesh = bodyGroupRef.current.children[1];
      if (bodyMesh?.material) {
        bodyMesh.material.color.lerp(preset.sunCore, lerpFactor);
        bodyMesh.material.emissive.lerp(preset.sunCore, lerpFactor);
      }
      if (haloMesh?.material) {
        haloMesh.material.color.lerp(preset.sunGlow, lerpFactor);
      }
    }

    // Directional light follows body
    if (lightRef.current) {
      lightRef.current.position.set(bodyPos[0], bodyPos[1], bodyPos[2]);
      lightRef.current.intensity += (preset.sunIntensity * brightness - lightRef.current.intensity) * lerpFactor;
      lightRef.current.color.lerp(preset.sunLight, lerpFactor);
    }
  });

  return (
    <group>
      <mesh material={skyMaterial}>
        <sphereGeometry args={[500, 32, 32]} />
      </mesh>
      <CelestialBody groupRef={bodyGroupRef} />
      <directionalLight
        ref={lightRef}
        position={[-60, 5, -80]}
        intensity={0.6}
        color="#ffccaa"
      />
    </group>
  );
}
