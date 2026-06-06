import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { PIXEL_FONT_URL, cityDayMix, tintStructure } from './cityConstants';
import CityLabel from './CityLabel';
import { computeVoiceMarker } from '../../utils/cityVoiceMarker';

// CyberCity's voice-agent district marker (roadmap 2.4): a modest ground-level beacon
// north of downtown — a low disc with a short pole and a glowing orb on top. The orb's
// color and pulse mirror the voice agent's live state: calm slate on standby, accent blue
// while listening, green while dictating, red on error, and barely-lit when voice mode is
// off. Keeps to a small footprint so it reads as a district marker, not a landmark.
export default function CityVoiceMarker({ voiceState, settings }) {
  const marker = useMemo(() => computeVoiceMarker(voiceState), [voiceState]);
  const orbRef = useRef();

  // Honor the quality dial: drop the beacon pulse on the lowest preset, but keep the
  // static glow so the voice state stays legible.
  const animate = (settings?.particleDensity ?? 1) >= 0.5;
  const dayMix = cityDayMix(settings);

  useFrame(({ clock }) => {
    if (!animate || !orbRef.current) return;
    // Error throbs urgently; listening/dictating breathe actively; idle sits calm;
    // a disabled marker holds its dim static glow (no pulse).
    if (marker.disabled) {
      orbRef.current.material.emissiveIntensity = marker.intensity;
      return;
    }
    const speed = marker.alerting ? 3 : marker.active ? 2 : 0.7;
    const pulse = 0.5 + ((Math.sin(clock.getElapsedTime() * speed) + 1) / 2) * 0.6;
    orbRef.current.material.emissiveIntensity = pulse * (marker.intensity + 0.2);
  });

  const { position, baseRadius, poleHeight, beaconRadius, color, label } = marker;

  return (
    <group position={position}>
      {/* Low disc base — anchors the marker to the ground */}
      <mesh position={[0, 0.1, 0]}>
        <cylinderGeometry args={[baseRadius, baseRadius * 1.15, 0.2, 24]} />
        <meshStandardMaterial color={tintStructure('#0c1620')} emissive={color} emissiveIntensity={0.12} metalness={0.5} roughness={0.6} />
      </mesh>
      {/* Slim antenna pole */}
      <mesh position={[0, poleHeight / 2, 0]}>
        <cylinderGeometry args={[0.14, 0.18, poleHeight, 12]} />
        <meshStandardMaterial color="#1a2533" emissive={color} emissiveIntensity={0.15} metalness={0.7} roughness={0.4} />
      </mesh>
      {/* Beacon orb — the live voice-state indicator */}
      <mesh ref={orbRef} position={[0, poleHeight + beaconRadius * 0.6, 0]}>
        <sphereGeometry args={[beaconRadius, 20, 20]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={marker.intensity} toneMapped={false} />
      </mesh>
      {/* Label + live-state sublabel above the beacon */}
      <CityLabel position={[0, poleHeight + beaconRadius * 0.6 + 1.6, 0]} fontSize={1} color={color} dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={16}>
        VOICE
      </CityLabel>
      <CityLabel position={[0, poleHeight + beaconRadius * 0.6 + 0.9, 0]} fontSize={0.7} color="#94a3b8" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={16}>
        {label}
      </CityLabel>
    </group>
  );
}
