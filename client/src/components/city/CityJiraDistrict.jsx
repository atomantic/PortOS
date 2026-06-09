import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { PIXEL_FONT_URL, cityDayMix } from './cityConstants';
import { useCityPalette } from './CityPaletteContext';
import CityLabel from './CityLabel';
import { computeJiraDistrict, JIRA_DISTRICT } from '../../utils/cityJiraDistrict';

// CyberCity's JIRA sprint district (roadmap 3.7): the current sprint's tickets become a small
// construction yard. To-Do tickets are stacked crates (unbuilt), In-Progress tickets are
// under-construction wireframe frames (scaffold), and Done tickets are finished, lit buildings.
// Tickets are gathered across every JIRA-enabled app and deduped by key in the pure helper; this
// component only renders + animates. Mirrors CityTaskQueue / CityGoalMonuments.

// One ticket structure. The mesh form is chosen by workflow state so the yard reads as work
// progressing from crates → scaffolds → finished buildings.
function SprintStructure({ structure, pulseRef, isPulse }) {
  const { tintStructure } = useCityPalette();
  const { position, color, height, state } = structure;
  const size = JIRA_DISTRICT.crateSize;

  if (state === 'done') {
    // Finished building — solid, emissive, the in-progress pulse never lands here.
    return (
      <group position={position}>
        <mesh position={[0, height / 2, 0]}>
          <boxGeometry args={[size, height, size]} />
          <meshStandardMaterial color={tintStructure('#0d1a12')} emissive={color} emissiveIntensity={0.7} metalness={0.6} roughness={0.4} toneMapped={false} />
        </mesh>
      </group>
    );
  }

  if (state === 'inProgress') {
    // Under construction — a built lower portion topped by a translucent scaffold cage that
    // breathes (the pulse target). Reads as "actively being worked".
    const builtH = Math.max(0.4, height * 0.45);
    const scaffoldH = Math.max(0.3, height - builtH);
    return (
      <group position={position}>
        <mesh position={[0, builtH / 2, 0]}>
          <boxGeometry args={[size, builtH, size]} />
          <meshStandardMaterial color="#1a1206" emissive={color} emissiveIntensity={0.5} metalness={0.4} roughness={0.6} toneMapped={false} />
        </mesh>
        <mesh ref={isPulse ? pulseRef : undefined} position={[0, builtH + scaffoldH / 2, 0]}>
          <boxGeometry args={[size * 1.05, scaffoldH, size * 1.05]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} wireframe transparent opacity={0.7} toneMapped={false} />
        </mesh>
      </group>
    );
  }

  // To-Do — a stack of dim crates waiting to be built.
  const crateH = size * 0.7;
  const crates = Math.max(1, Math.round(height / crateH));
  return (
    <group position={position}>
      {Array.from({ length: crates }, (_, i) => (
        <mesh key={i} position={[0, crateH * (i + 0.5), 0]}>
          <boxGeometry args={[size * 0.9, crateH * 0.9, size * 0.9]} />
          <meshStandardMaterial color="#161a22" emissive={color} emissiveIntensity={0.18} metalness={0.5} roughness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

export default function CityJiraDistrict({ jiraTickets, settings }) {
  const district = useMemo(() => computeJiraDistrict(jiraTickets), [jiraTickets]);
  const pulseRef = useRef();

  const animate = (settings?.particleDensity ?? 1) >= 0.5;
  const dayMix = cityDayMix(settings);

  // The first in-progress structure carries a breathing scaffold glow (one ref mutation/frame).
  const pulseKey = useMemo(
    () => district.structures.find(s => s.state === 'inProgress')?.key ?? null,
    [district.structures]
  );

  useFrame(({ clock }) => {
    if (!pulseRef.current) return;
    if (!animate) { pulseRef.current.material.emissiveIntensity = 0.5; return; }
    const pulse = (Math.sin(clock.getElapsedTime() * 2.2) + 1) / 2;
    pulseRef.current.material.emissiveIntensity = 0.4 + pulse * 0.5;
  });

  if (district.empty) return null;

  const { base, structures, counts, total, overflow, overflowPosition } = district;

  return (
    <group>
      {structures.map((structure) => (
        <SprintStructure
          key={structure.key}
          structure={structure}
          pulseRef={pulseRef}
          isPulse={structure.key === pulseKey}
        />
      ))}

      {/* Overflow marker — tickets past the render cap */}
      {overflow > 0 && overflowPosition && (
        <CityLabel position={[overflowPosition[0], 1.4, overflowPosition[2]]} fontSize={0.5} color="#94a3b8" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={9}>
          {`+${overflow} MORE`}
        </CityLabel>
      )}

      {/* District title + sprint progress */}
      <CityLabel position={[base[0], 12, base[2] - 2]} fontSize={1.2} color="#3b82f6" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={30}>
        SPRINT
      </CityLabel>
      <CityLabel position={[base[0], 11.1, base[2] - 2]} fontSize={0.72} color="#94a3b8" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={30}>
        {`${counts.done}/${total} DONE · ${counts.inProgress} IN PROGRESS`}
      </CityLabel>
    </group>
  );
}
