import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getTimeOfDayPreset, tintTowardAccent } from './cityConstants';
import { useCityPalette } from './CityPaletteContext';

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
    uniform vec3 uBelowHorizon;
    uniform vec3 uSunDirection;
    uniform float uSunIntensity;
    uniform float uIsMoon;
    uniform float uOpacity;
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

      // Below horizon: fade to dark. smoothstep requires edge0 < edge1;
      // reverse the result instead of reversing the edges, which is undefined
      // in GLSL and can blow the sky out on some WebGL implementations.
      float belowFade = 1.0 - smoothstep(-0.05, 0.0, dir.y);
      color = mix(color, uBelowHorizon, belowFade);

      gl_FragColor = vec4(color, uOpacity);
    }
  `,
};

// Lerp THREE.Color in place
const lerpColor = (target, a, b, t) => {
  target.r = a.r + (b.r - a.r) * t;
  target.g = a.g + (b.g - a.g) * t;
  target.b = a.b + (b.b - a.b) * t;
};

// Pre-allocate parsed preset colors (keyed by "theme:timeOfDay:accent"). The upper
// sky bands (zenith, midSky) are tinted toward the active theme accent so the sky
// tracks the theme; horizon haze + sun colors stay physical/untinted. The accent is
// in the cache key so a theme switch re-derives instead of serving a stale tint.
const presetColors = {};
const getPresetColors = (name, skyTheme, accent) => {
  const cacheKey = `${skyTheme}:${name}:${accent}`;
  if (!presetColors[cacheKey]) {
    const p = getTimeOfDayPreset(name, skyTheme);
    const isBrightDay = (p.daylightFactor ?? 0) >= 0.75;
    const belowHorizon = isBrightDay ? p.horizonLow : '#03030a';
    presetColors[cacheKey] = {
      zenith: new THREE.Color(tintTowardAccent(p.zenith, 0.16, accent)),
      midSky: new THREE.Color(tintTowardAccent(p.midSky, 0.12, accent)),
      horizonHigh: new THREE.Color(p.horizonHigh),
      horizonLow: new THREE.Color(p.horizonLow),
      belowHorizon: new THREE.Color(belowHorizon),
      sunCore: new THREE.Color(p.sunCore),
      sunGlow: new THREE.Color(p.sunGlow),
      sunLight: new THREE.Color(p.sunLight),
      hour: p.hour,
      sunIntensity: p.sunIntensity,
      // Day is the gradient sky. Night is the bundled galaxy map, so the shader
      // dome gets out of the way and only the moon/light meshes remain.
      overlayOpacity: isBrightDay ? 1.0 : 0.0,
      sunScale: p.sunScale,
      isMoon: p.isMoon,
    };
  }
  return presetColors[cacheKey];
};

// Sun/Moon mesh
function CelestialBody({ groupRef }) {
  const bodyRef = useRef();
  const haloRef = useRef();

  useFrame(({ clock }) => {
    if (!bodyRef.current) return;
    const t = clock.getElapsedTime();
    const pulse = 1.0 + Math.sin(t * 0.5) * 0.08;
    bodyRef.current.material.emissiveIntensity = 0.45 * pulse;
    if (haloRef.current) {
      haloRef.current.material.opacity = 0.035 + Math.sin(t * 0.3) * 0.012;
    }
  });

  return (
    <group ref={groupRef}>
      <mesh ref={bodyRef}>
        <sphereGeometry args={[2.2, 24, 24]} />
        <meshStandardMaterial
          color="#ffaa44"
          emissive="#ffaa44"
          emissiveIntensity={0.45}
          toneMapped
        />
      </mesh>
      <mesh ref={haloRef}>
        <ringGeometry args={[3, 7, 32]} />
        <meshBasicMaterial
          color="#ff6080"
          transparent
          opacity={0.035}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

export default function CitySky({ settings }) {
  // The upper sky bands are tinted toward the theme accent. Mirror it into a ref so
  // the useFrame loop reads the current accent without re-subscribing each frame.
  const { accent } = useCityPalette();
  const accentRef = useRef(accent);
  accentRef.current = accent;

  const brightnessRef = useRef(settings?.ambientBrightness ?? 1.2);
  brightnessRef.current = settings?.ambientBrightness ?? 1.2;

  const timeOfDayRef = useRef(settings?.timeOfDay ?? 'sunset');
  timeOfDayRef.current = settings?.timeOfDay ?? 'sunset';

  const skyThemeRef = useRef(settings?.skyTheme ?? 'cyberpunk');
  const previousSkyThemeRef = useRef(skyThemeRef.current);

  const currentPresetRef = useRef(timeOfDayRef.current);
  const transitionRef = useRef(1.0);

  const nextSkyTheme = settings?.skyTheme ?? 'cyberpunk';
  if (previousSkyThemeRef.current !== nextSkyTheme) {
    previousSkyThemeRef.current = nextSkyTheme;
    skyThemeRef.current = nextSkyTheme;
    transitionRef.current = 0;
  } else {
    skyThemeRef.current = nextSkyTheme;
  }

  const bodyGroupRef = useRef();
  const lightRef = useRef();
  const currentScaleRef = useRef(1.0);
  const initialPreset = getTimeOfDayPreset(settings?.timeOfDay ?? 'sunset', settings?.skyTheme ?? 'cyberpunk');
  const currentHourRef = useRef(initialPreset.hour ?? 18);

  const skyMaterial = useMemo(() => {
    const initialTheme = skyThemeRef.current;
    const initialTod = timeOfDayRef.current;
    const initialHour = getTimeOfDayPreset(initialTod, initialTheme).hour ?? 18;
    const preset = getPresetColors(initialTod, initialTheme, accentRef.current);
    const initPos = getArcPosition(initialHour);
    return new THREE.ShaderMaterial({
      vertexShader: SkyDomeShader.vertexShader,
      fragmentShader: SkyDomeShader.fragmentShader,
      uniforms: {
        uZenith: { value: preset.zenith.clone() },
        uMidSky: { value: preset.midSky.clone() },
        uHorizonHigh: { value: preset.horizonHigh.clone() },
        uHorizonLow: { value: preset.horizonLow.clone() },
        uBelowHorizon: { value: preset.belowHorizon.clone() },
        uSunDirection: { value: new THREE.Vector3(...initPos).normalize() },
        uSunIntensity: { value: preset.sunIntensity },
        uIsMoon: { value: preset.isMoon ? 1.0 : 0.0 },
        uOpacity: { value: preset.overlayOpacity },
        uTime: { value: 0 },
      },
      side: THREE.BackSide,
      transparent: preset.overlayOpacity < 0.999,
      opacity: preset.overlayOpacity,
      blending: THREE.NormalBlending,
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

    const preset = getPresetColors(target, skyThemeRef.current, accentRef.current);

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
    lerpColor(skyMaterial.uniforms.uBelowHorizon.value, skyMaterial.uniforms.uBelowHorizon.value, preset.belowHorizon, lerpFactor);

    // Update sun direction directly from arc position
    skyMaterial.uniforms.uSunDirection.value.copy(bodyDir);
    skyMaterial.uniforms.uSunIntensity.value += (preset.sunIntensity - skyMaterial.uniforms.uSunIntensity.value) * lerpFactor;
    skyMaterial.uniforms.uIsMoon.value += ((preset.isMoon ? 1.0 : 0.0) - skyMaterial.uniforms.uIsMoon.value) * lerpFactor;
    skyMaterial.uniforms.uOpacity.value += (preset.overlayOpacity - skyMaterial.uniforms.uOpacity.value) * lerpFactor;
    skyMaterial.opacity = skyMaterial.uniforms.uOpacity.value;
    const shouldBeTransparent = skyMaterial.opacity < 0.999;
    if (skyMaterial.transparent !== shouldBeTransparent) {
      skyMaterial.transparent = shouldBeTransparent;
      skyMaterial.needsUpdate = true;
    }
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
      {/* Dome radius must exceed the CityLandscape mountain ring (~1210 max extent)
          so the horizon mountains sit INSIDE the dome and aren't occluded by the
          opaque daytime sky. Kept under the camera far plane (2000). */}
      <mesh material={skyMaterial} renderOrder={-1000}>
        <sphereGeometry args={[1600, 32, 32]} />
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
