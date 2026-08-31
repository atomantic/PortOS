import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { openWorldShowDetail, getTimeOfDayPreset } from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';

// Animated accent light that slowly shifts color, with reactive brightness
function AnimatedLight({ position, baseColor, baseIntensity, distance, shiftRange = 0.1, speed = 0.5, brightnessRef, neonScaleRef }) {
  const ref = useRef();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const b = brightnessRef.current;
    const ns = neonScaleRef?.current ?? 1;
    const t = clock.getElapsedTime();
    ref.current.intensity = (baseIntensity + Math.sin(t * speed) * baseIntensity * shiftRange) * b * ns;
  });

  return (
    <pointLight
      ref={ref}
      position={position}
      intensity={baseIntensity}
      color={baseColor}
      distance={distance}
    />
  );
}

// Sweeping searchlight effect with reactive brightness
function Searchlight({ brightnessRef, neonScaleRef }) {
  const ref = useRef();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    const angle = t * 0.2;
    const radius = 25;
    ref.current.position.x = Math.cos(angle) * radius;
    ref.current.position.z = Math.sin(angle) * radius;
    const ns = neonScaleRef?.current ?? 1;
    ref.current.intensity = 0.6 * brightnessRef.current * ns;
    ref.current.target.position.set(0, 0, 0);
    ref.current.target.updateMatrixWorld();
  });

  return (
    <spotLight
      ref={ref}
      position={[25, 30, 0]}
      intensity={0.6}
      color="#06b6d4"
      angle={0.2}
      penumbra={0.8}
      distance={90}
      decay={1.2}
      castShadow={false}
    />
  );
}

// Static point light that updates intensity every frame from brightness ref
function ReactivePointLight({ position, baseIntensity, color, distance, brightnessRef, neonScaleRef }) {
  const ref = useRef();

  useFrame(() => {
    if (!ref.current) return;
    const ns = neonScaleRef?.current ?? 1;
    ref.current.intensity = baseIntensity * brightnessRef.current * ns;
  });

  return (
    <pointLight
      ref={ref}
      position={position}
      intensity={baseIntensity}
      color={color}
      distance={distance}
    />
  );
}

export default function OpenWorldLights({ settings, lightingTier }) {
  const { ground } = useOpenWorldPalette();
  const brightnessRef = useRef(settings?.ambientBrightness ?? 1.2);
  brightnessRef.current = settings?.ambientBrightness ?? 1.2;

  const timeOfDay = settings?.timeOfDay ?? 'sunset';
  const skyTheme = settings?.skyTheme ?? 'cyberpunk';
  const preset = getTimeOfDayPreset(timeOfDay, skyTheme);
  const cozyLighting = Boolean(settings?.explorationMode);
  const daylightFactor = cozyLighting ? Math.max(0.72, preset.daylightFactor ?? 0) : (preset.daylightFactor ?? 0);
  const nightGlow = 1 - Math.min(1, daylightFactor);

  // Medium tier and up — the same gate the rest of the optional set dressing uses, so the
  // low tier sheds light count along with the props those lights were there to accent.
  //
  // Gated on the SETTLED tier, not the render tier the rest of the set dressing
  // reads. OpenWorldScene pins `effectiveTier: 'low'` for the first 1.2s of every mount
  // and visibility resume, and light count is part of three.js's program cache key
  // — so reading the clamped tier here would recompile every MeshStandardMaterial
  // in the scene at the warm-up boundary, a stall at exactly the moment the warm-up
  // exists to avoid one. Falls back to `settings` when the prop is absent.
  const showAccentLights = openWorldShowDetail(lightingTier ? { effectiveTier: lightingTier } : settings);

  // Neon scale: dim neon point lights during daytime (30% at noon, 100% at night)
  const neonScaleRef = useRef(1);
  const targetNeonScale = 1.0 - daylightFactor * 0.7;

  // Hemisphere light refs — provides natural sky fill (like Unreal Engine's Sky Light)
  const hemiRef = useRef();
  const hemiSkyTarget = useRef(new THREE.Color(preset.hemiSkyColor));
  const hemiGroundTarget = useRef(new THREE.Color(preset.hemiGroundColor));
  hemiSkyTarget.current.set(cozyLighting ? '#b9d9dc' : preset.hemiSkyColor);
  hemiGroundTarget.current.set(cozyLighting ? '#7c7153' : preset.hemiGroundColor);
  const hemiIntensityTarget = useRef(preset.hemiIntensity);
  hemiIntensityTarget.current = (cozyLighting ? 0.92 : preset.hemiIntensity) * brightnessRef.current;

  // Ambient light refs
  const ambientRef = useRef();
  const ambientColorTarget = useRef(new THREE.Color(preset.ambientColor));
  ambientColorTarget.current.set(cozyLighting ? '#fff0ce' : preset.ambientColor);
  const ambientIntensityTarget = useRef(preset.ambientIntensity);
  ambientIntensityTarget.current = (cozyLighting ? 0.3 : preset.ambientIntensity) * brightnessRef.current;

  useFrame((_, delta) => {
    const lf = Math.min(1, delta * 3);

    // Lerp neon scale
    neonScaleRef.current += (targetNeonScale - neonScaleRef.current) * lf;

    // Hemisphere light — main daytime fill
    if (hemiRef.current) {
      hemiRef.current.color.lerp(hemiSkyTarget.current, lf);
      hemiRef.current.groundColor.lerp(hemiGroundTarget.current, lf);
      hemiRef.current.intensity += (hemiIntensityTarget.current - hemiRef.current.intensity) * lf;
    }

    // Ambient light
    if (ambientRef.current) {
      ambientRef.current.color.lerp(ambientColorTarget.current, lf);
      ambientRef.current.intensity += (ambientIntensityTarget.current - ambientRef.current.intensity) * lf;
    }
  });

  return (
    <>
      {/* Hemisphere sky light — like Unreal Engine's Sky Light, illuminates all geometry from sky/ground */}
      <hemisphereLight ref={hemiRef} color="#1a1a3a" groundColor="#0a0a20" intensity={0.3} />
      <ambientLight ref={ambientRef} intensity={0.18} color="#1a1a3a" />
      {cozyLighting && (
        <>
          {/* One authored sun creates the long readable shadows and object grounding the
              village references rely on. A soft amber fill keeps shaded porches warm. */}
          <directionalLight
            position={[-42, 68, 36]}
            color="#fff0c4"
            intensity={(0.72 + daylightFactor * 1.15) * brightnessRef.current}
            castShadow={showAccentLights}
            shadow-mapSize-width={2048}
            shadow-mapSize-height={2048}
            shadow-camera-left={-78}
            shadow-camera-right={78}
            shadow-camera-top={78}
            shadow-camera-bottom={-78}
            shadow-camera-near={1}
            shadow-camera-far={165}
            shadow-normalBias={0.035}
          />
          <ReactivePointLight position={[18, 14, 26]} baseIntensity={0.42} color="#ffb982" distance={82} brightnessRef={brightnessRef} neonScaleRef={neonScaleRef} />
        </>
      )}
      {!cozyLighting && (
        <>
          {/* Main overhead cyan */}
          <ReactivePointLight position={[0, 30, 0]} baseIntensity={1.2} color="#06b6d4" distance={100} brightnessRef={brightnessRef} neonScaleRef={neonScaleRef} />
          {/* Secondary overhead fill - broad white/blue */}
          <ReactivePointLight position={[0, 20, 10]} baseIntensity={0.5} color="#4488cc" distance={90} brightnessRef={brightnessRef} neonScaleRef={neonScaleRef} />
          {/* Broad nighttime city glow — signage bounce + moonlit haze, faded in daylight */}
          <ReactivePointLight position={[0, 16, 0]} baseIntensity={1.8 * nightGlow} color={ground} distance={150} brightnessRef={brightnessRef} neonScaleRef={neonScaleRef} />
          <ReactivePointLight position={[-28, 10, 24]} baseIntensity={1.05 * nightGlow} color="#ec4899" distance={118} brightnessRef={brightnessRef} neonScaleRef={neonScaleRef} />
          <ReactivePointLight position={[30, 12, -22]} baseIntensity={1.1 * nightGlow} color="#60a5fa" distance={120} brightnessRef={brightnessRef} neonScaleRef={neonScaleRef} />
          {/* Magenta accent from left - animated color shift */}
          <AnimatedLight position={[-20, 12, -15]} baseColor="#ec4899" baseIntensity={0.7} distance={60} speed={0.3} shiftRange={0.15} brightnessRef={brightnessRef} neonScaleRef={neonScaleRef} />
          {/* Blue accent from right - animated shift */}
          <AnimatedLight position={[20, 12, 15]} baseColor="#3b82f6" baseIntensity={0.7} distance={60} speed={0.4} shiftRange={0.12} brightnessRef={brightnessRef} neonScaleRef={neonScaleRef} />
          {/* Purple from behind - more presence */}
          <ReactivePointLight position={[0, 15, -25]} baseIntensity={0.5} color="#8b5cf6" distance={60} brightnessRef={brightnessRef} neonScaleRef={neonScaleRef} />
          {/* Warm orange ground level accent */}
          <ReactivePointLight position={[10, 3, 5]} baseIntensity={0.35} color="#f97316" distance={35} brightnessRef={brightnessRef} neonScaleRef={neonScaleRef} />
        </>
      )}
      {/* Ground-level small-radius accents (green + red warning). Culled on the low tier:
          every mounted light costs a per-fragment iteration in the lighting loop of every
          MeshStandardMaterial in the scene, whatever its intensity — so dimming them saves
          nothing and only unmounting does (#3397). These two are the least visually
          significant of the set: lowest intensity (0.2 / 0.15) and smallest radius (25 / 22
          units), so they only tint a small patch of street the low tier already renders
          without its set dressing. */}
      {showAccentLights && !cozyLighting && (
        <>
          {/* Additional green accent - ground level from opposite side */}
          <ReactivePointLight position={[-12, 3, 8]} baseIntensity={0.2} color="#22c55e" distance={25} brightnessRef={brightnessRef} neonScaleRef={neonScaleRef} />
          {/* Red warning accent from below-right */}
          <ReactivePointLight position={[15, 2, -10]} baseIntensity={0.15} color="#f43f5e" distance={22} brightnessRef={brightnessRef} neonScaleRef={neonScaleRef} />
        </>
      )}
      {/* Sweeping searchlight */}
      {!cozyLighting && <Searchlight brightnessRef={brightnessRef} neonScaleRef={neonScaleRef} />}
    </>
  );
}
