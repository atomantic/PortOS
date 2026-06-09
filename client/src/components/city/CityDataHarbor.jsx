import { useMemo, useRef, useState, useCallback } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { PIXEL_FONT_URL, cityDayMix } from './cityConstants';
import { useCityPalette } from './CityPaletteContext';
import CityLabel from './CityLabel';
import { computeDataHarbor, DATA_HARBOR } from '../../utils/cityDataHarbor';
import { WORLD, AVENUE_WIDTH } from '../../utils/cityPlan';

// CyberCity's Data Harbor: a pier district over the bay (master plan, north shore) that
// renders GET /api/city/introspection — the database quay (one disk-stack silo per Postgres
// table, an orbiting ring on pgvector tables, a migration obelisk) beside the archive racks
// (one container rack per data/ domain, lit slats tracking disk usage). Clicking a silo or
// rack opens a holographic detail card. Mirrors CityMemoryDistrict: the pure helper does
// all topology, this component only renders + animates.

const DECK_COLOR = '#10182a';
const PYLON_COLOR = '#0a0f1c';
const OFFLINE_COLOR = '#ef4444';

// Holographic info card for a clicked silo/rack — same visual language as
// HolographicPanel.jsx (the app-building hologram).
function HarborHoloCard({ selected }) {
  const { kind, data } = selected;
  const accentClass = kind === 'silo' ? 'border-cyan-500/50 text-cyan-300' : 'border-violet-500/50 text-violet-300';
  return (
    <Html position={[data.x, DATA_HARBOR.deckY + data.height + 2.6, data.z]} center distanceFactor={12} style={{ pointerEvents: 'none' }}>
      <div className={`bg-black/90 border ${accentClass} rounded-md px-3 py-2 whitespace-nowrap backdrop-blur-sm`} style={{ boxShadow: '0 0 16px rgba(6,182,212,0.25)' }}>
        <div className="font-pixel tracking-wider font-bold text-[12px] max-w-[180px] truncate">{data.label}</div>
        <div className="text-[9px] font-pixel tracking-wide mt-1 space-y-0.5 text-gray-300">
          {kind === 'silo' ? (
            <>
              <div>{data.rowEstimate.toLocaleString()} rows</div>
              <div>{data.bytesLabel}</div>
              {data.hasEmbedding && <div className="text-pink-400">pgvector embeddings</div>}
            </>
          ) : (
            <>
              <div>{data.sublabel}</div>
              <div>{data.files.toLocaleString()} files</div>
              <div className="text-gray-500">data/{data.name}</div>
            </>
          )}
        </div>
      </div>
    </Html>
  );
}

// One database table: a stack of glowing disks on a dark plinth; pgvector tables carry a
// slowly orbiting ring (rotated by the parent's single useFrame via ringRefs).
function TableSilo({ silo, color, onSelect, registerRing, dayMix }) {
  const disks = useMemo(() => Array.from({ length: silo.diskCount }, (_, i) => i), [silo.diskCount]);
  const [hovered, setHovered] = useState(false);
  const step = DATA_HARBOR.diskHeight + DATA_HARBOR.diskGap;
  return (
    <group position={[silo.x, DATA_HARBOR.deckY, silo.z]}>
      <group
        onClick={(e) => { e.stopPropagation(); onSelect(); }}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        {/* Plinth */}
        <mesh position={[0, 0.1, 0]}>
          <cylinderGeometry args={[silo.diskRadius + 0.25, silo.diskRadius + 0.35, 0.2, 16]} />
          <meshStandardMaterial color={PYLON_COLOR} roughness={0.8} />
        </mesh>
        {disks.map((i) => (
          <mesh key={i} position={[0, 0.2 + step * i + DATA_HARBOR.diskHeight / 2, 0]}>
            <cylinderGeometry args={[silo.diskRadius, silo.diskRadius, DATA_HARBOR.diskHeight, 20]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              // The top disk reads as the silo's "live" surface; lower disks dim slightly.
              emissiveIntensity={(i === silo.diskCount - 1 ? 0.55 : 0.28) + (hovered ? 0.3 : 0)}
              metalness={0.4}
              roughness={0.3}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>
      {silo.hasEmbedding && (
        <mesh ref={registerRing} position={[0, 0.2 + step * silo.diskCount + 0.35, 0]} rotation={[Math.PI / 2.6, 0, 0]}>
          <torusGeometry args={[silo.diskRadius + 0.45, 0.05, 8, 32]} />
          <meshBasicMaterial color={color} transparent opacity={0.7} toneMapped={false} />
        </mesh>
      )}
      <CityLabel position={[0, silo.height + 1.5, 0]} fontSize={0.42} color={color} dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={7}>
        {silo.label}
      </CityLabel>
      <CityLabel position={[0, silo.height + 1.05, 0]} fontSize={0.3} color="#94a3b8" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={7}>
        {silo.sublabel}
      </CityLabel>
    </group>
  );
}

// One data/ domain: a container rack whose lit slat count tracks its share of disk usage.
function DomainRack({ rack, accent, tintStructure, onSelect, dayMix }) {
  const [hovered, setHovered] = useState(false);
  const slats = useMemo(() => Array.from({ length: DATA_HARBOR.rackSlats }, (_, i) => i), []);
  const slatStep = (rack.height - 0.6) / DATA_HARBOR.rackSlats;
  return (
    <group position={[rack.x, DATA_HARBOR.deckY, rack.z]}>
      <group
        onClick={(e) => { e.stopPropagation(); onSelect(); }}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <mesh position={[0, rack.height / 2, 0]}>
          <boxGeometry args={[rack.width, rack.height, rack.depth]} />
          <meshStandardMaterial color={tintStructure(DECK_COLOR)} roughness={0.6} metalness={0.3} />
        </mesh>
        {/* Slat rows on the front (bay-facing) face — lit bottom-up by fill ratio. */}
        {slats.map((i) => {
          const lit = i < rack.litSlats;
          return (
            <mesh key={i} position={[0, 0.45 + i * slatStep, rack.depth / 2 + 0.02]}>
              <boxGeometry args={[rack.width - 0.5, slatStep * 0.45, 0.05]} />
              <meshStandardMaterial
                color={lit ? accent : '#1f2937'}
                emissive={lit ? accent : '#000000'}
                emissiveIntensity={lit ? 0.6 + (hovered ? 0.3 : 0) : 0}
                toneMapped={false}
              />
            </mesh>
          );
        })}
      </group>
      <CityLabel position={[0, rack.height + 1.2, 0]} fontSize={0.42} color={accent} dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={7}>
        {rack.label}
      </CityLabel>
      <CityLabel position={[0, rack.height + 0.75, 0]} fontSize={0.3} color="#94a3b8" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={7}>
        {rack.sublabel}
      </CityLabel>
    </group>
  );
}

// A pier deck on pylons over the water.
function PierDeck({ x, z, width, depth, tintStructure }) {
  const pylons = useMemo(() => {
    const out = [];
    const halfW = width / 2 - 0.6;
    const halfD = depth / 2 - 0.6;
    for (const px of [-halfW, halfW]) {
      for (const pz of [-halfD, halfD]) out.push([x + px, pz + z]);
    }
    return out;
  }, [x, z, width, depth]);
  return (
    <group>
      <mesh position={[x, DATA_HARBOR.deckY - 0.15, z]}>
        <boxGeometry args={[width, 0.3, depth]} />
        <meshStandardMaterial color={tintStructure(DECK_COLOR)} roughness={0.7} metalness={0.25} />
      </mesh>
      {pylons.map(([px, pz], i) => (
        <mesh key={i} position={[px, WORLD.waterY - 0.8, pz]}>
          <cylinderGeometry args={[0.28, 0.34, 3, 8]} />
          <meshStandardMaterial color={PYLON_COLOR} roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

export default function CityDataHarbor({ introspection, settings }) {
  const { accent, tintStructure, getAccentColor } = useCityPalette();
  const district = useMemo(() => computeDataHarbor(introspection), [introspection]);
  const [selected, setSelected] = useState(null);
  const dayMix = cityDayMix(settings);
  const animate = (settings?.particleDensity ?? 1) >= 0.5;

  // All pgvector rings spin from one frame callback (single mutation site). Keyed by
  // silo name (set on mount, cleared on unmount) so a re-render that doesn't remount
  // the silos can't strand the registry empty.
  const ringRefs = useRef(new Map());
  const makeRingRef = useCallback((name) => (el) => {
    if (el) ringRefs.current.set(name, el);
    else ringRefs.current.delete(name);
  }, []);
  const offlineRef = useRef();

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (animate) {
      for (const ring of ringRefs.current.values()) ring.rotation.z = t * 0.6;
    }
    if (offlineRef.current) {
      offlineRef.current.material.emissiveIntensity = 0.5 + ((Math.sin(t * 2.2) + 1) / 2) * 0.6;
    }
  });

  if (district.empty) return null;

  const [bx, , bz] = district.base;
  const { silos, racks, decks, obelisk, totals, overflow, dbDown } = district;
  const select = (kind, data) => setSelected((prev) =>
    prev && prev.kind === kind && prev.data.name === data.name ? null : { kind, data });

  return (
    <group>
      {/* Gangway from the shoreline avenue out to the pier head — same width as the
          avenue it continues, so the shoreline joint stays seamless. */}
      <PierDeck x={bx} z={(WORLD.shorelineZ + bz) / 2} width={AVENUE_WIDTH} depth={Math.abs(bz - WORLD.shorelineZ) + 2} tintStructure={tintStructure} />
      {/* West quay (database silos) + east yard (archive racks) — sized by the helper
          to contain whatever stands on them. */}
      {decks.map((deck, i) => (
        <PierDeck key={i} x={deck.x} z={deck.z} width={deck.w} depth={deck.d} tintStructure={tintStructure} />
      ))}

      {silos.map((silo) => (
        <TableSilo
          key={silo.name}
          silo={silo}
          color={getAccentColor({ name: silo.name })}
          onSelect={() => select('silo', silo)}
          registerRing={silo.hasEmbedding ? makeRingRef(silo.name) : undefined}
          dayMix={dayMix}
        />
      ))}

      {/* DB offline: the quay keeps its deck but flies a pulsing red beacon. */}
      {dbDown && (
        <group position={[decks[0].x, DATA_HARBOR.deckY, decks[0].z]}>
          <mesh ref={offlineRef} position={[0, 1.6, 0]}>
            <octahedronGeometry args={[0.9, 0]} />
            <meshStandardMaterial color={OFFLINE_COLOR} emissive={OFFLINE_COLOR} emissiveIntensity={0.8} toneMapped={false} />
          </mesh>
          <CityLabel position={[0, 3.4, 0]} fontSize={0.7} color={OFFLINE_COLOR} dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={10}>
            DB OFFLINE
          </CityLabel>
        </group>
      )}

      {racks.map((rack) => (
        <DomainRack
          key={rack.name}
          rack={rack}
          accent={accent}
          tintStructure={tintStructure}
          onSelect={() => select('rack', rack)}
          dayMix={dayMix}
        />
      ))}

      {/* Migration obelisk at the pier head. */}
      {obelisk && (
        <group position={[obelisk.x, DATA_HARBOR.deckY, obelisk.z]}>
          <mesh position={[0, 1.8, 0]}>
            <boxGeometry args={[0.7, 3.6, 0.7]} />
            <meshStandardMaterial color={tintStructure('#16213a')} emissive={accent} emissiveIntensity={0.18} roughness={0.4} toneMapped={false} />
          </mesh>
          <mesh position={[0, 3.85, 0]}>
            <octahedronGeometry args={[0.45, 0]} />
            <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.7} toneMapped={false} />
          </mesh>
          <CityLabel position={[0, 5, 0]} fontSize={0.42} color={accent} dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={8}>
            {`${obelisk.applied} MIGRATIONS`}
          </CityLabel>
        </group>
      )}

      {/* District title + totals, tall enough to read from the shore. */}
      <CityLabel position={[bx, 11, bz - 2]} fontSize={1.4} color={accent} dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={30}>
        DATA HARBOR
      </CityLabel>
      <CityLabel position={[bx, 9.9, bz - 2]} fontSize={0.7} color="#94a3b8" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={34}>
        {dbDown
          ? (totals.fsLabel ? `FILES ${totals.fsLabel}` : 'NO DATA')
          : `${totals.tableCount} TABLES${totals.dbSizeLabel ? ` ${totals.dbSizeLabel}` : ''}${totals.fsLabel ? ` • FILES ${totals.fsLabel}` : ''}`}
      </CityLabel>
      {(overflow.tables > 0 || overflow.domains > 0) && (
        <CityLabel position={[bx, 9.1, bz - 2]} fontSize={0.45} color="#64748b" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={30}>
          {`+${overflow.tables + overflow.domains} MORE`}
        </CityLabel>
      )}

      {selected && <HarborHoloCard selected={selected} />}
    </group>
  );
}
