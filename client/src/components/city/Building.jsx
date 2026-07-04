import { useRef, useState, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getBuildingHeight, BUILDING_PARAMS, PIXEL_FONT_URL, mixHex, seededRand } from './cityConstants';
import { useCityPalette } from './CityPaletteContext';
import CityLabel from './CityLabel';
import HolographicPanel from './HolographicPanel';
import BuildingHologram from './BuildingHologram';
import BuildingWindows from './BuildingWindows';
import { computeRooftopKit } from '../../utils/cityRooftops';
import { buildingHasInteriorWindows } from '../../utils/cityInteriorWindows';

// Rooftop fixture geometry/materials are module-scope singletons shared by every
// building — fixtures are tiny set dressing, so they keep fixed colors (the antenna
// tip is a red aviation blinker on purpose) instead of per-theme materials.
const ROOF_METAL_MAT = new THREE.MeshStandardMaterial({ color: '#232d40', roughness: 0.6, metalness: 0.5 });
const ROOF_TIP_MAT = new THREE.MeshBasicMaterial({ color: '#ff3344', toneMapped: false });
const ROOF_GEOMS = {
  antennaMast: new THREE.CylinderGeometry(0.02, 0.035, 1.2, 5),
  antennaTip: new THREE.SphereGeometry(0.05, 6, 6),
  tank: new THREE.CylinderGeometry(0.22, 0.22, 0.45, 10),
  ac: new THREE.BoxGeometry(0.4, 0.22, 0.34),
  dish: new THREE.SphereGeometry(0.24, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
};

// 0–3 deterministic fixtures (antenna/tank/AC/dish) on the roof, seeded by app name —
// the same determinism as the window textures, so a building keeps its roof forever.
function RooftopKit({ name, width, y }) {
  const kit = useMemo(() => computeRooftopKit(name, width), [name, width]);
  if (kit.length === 0) return null;
  return (
    <group position={[0, y, 0]}>
      {kit.map((f, i) => (
        <group key={i} position={[f.x, 0, f.z]} rotation={[0, f.rotation, 0]} scale={f.scale}>
          {f.type === 'antenna' && (
            <>
              <mesh geometry={ROOF_GEOMS.antennaMast} material={ROOF_METAL_MAT} position={[0, 0.6, 0]} />
              <mesh geometry={ROOF_GEOMS.antennaTip} material={ROOF_TIP_MAT} position={[0, 1.22, 0]} />
            </>
          )}
          {f.type === 'tank' && (
            <mesh geometry={ROOF_GEOMS.tank} material={ROOF_METAL_MAT} position={[0, 0.225, 0]} />
          )}
          {f.type === 'ac' && (
            <mesh geometry={ROOF_GEOMS.ac} material={ROOF_METAL_MAT} position={[0, 0.11, 0]} />
          )}
          {f.type === 'dish' && (
            <mesh
              geometry={ROOF_GEOMS.dish}
              material={ROOF_METAL_MAT}
              position={[0, 0.12, 0]}
              rotation={[Math.PI / 5, 0, 0]}
            />
          )}
        </group>
      ))}
    </group>
  );
}

// 7x7 pixel art icons drawn on building faces via lit office windows
const PIXEL_ICONS = [
  // Heart
  [
    [0,1,0,0,0,1,0],
    [1,1,1,0,1,1,1],
    [1,1,1,1,1,1,1],
    [0,1,1,1,1,1,0],
    [0,0,1,1,1,0,0],
    [0,0,0,1,0,0,0],
    [0,0,0,0,0,0,0],
  ],
  // Server rack
  [
    [1,1,1,1,1,1,1],
    [1,0,0,0,0,1,1],
    [1,1,1,1,1,1,1],
    [1,0,0,0,0,1,1],
    [1,1,1,1,1,1,1],
    [1,0,0,0,0,1,1],
    [1,1,1,1,1,1,1],
  ],
  // Lightning bolt
  [
    [0,0,0,1,1,0,0],
    [0,0,1,1,0,0,0],
    [0,1,1,1,1,0,0],
    [0,0,1,1,1,1,0],
    [0,0,0,1,1,0,0],
    [0,0,1,1,0,0,0],
    [0,0,1,0,0,0,0],
  ],
  // Star
  [
    [0,0,0,1,0,0,0],
    [0,0,1,1,1,0,0],
    [1,1,1,1,1,1,1],
    [0,1,1,1,1,1,0],
    [0,1,1,0,1,1,0],
    [0,1,0,0,0,1,0],
    [1,0,0,0,0,0,1],
  ],
  // Shield
  [
    [0,1,1,1,1,1,0],
    [1,1,1,1,1,1,1],
    [1,1,0,1,0,1,1],
    [1,1,1,1,1,1,1],
    [0,1,1,1,1,1,0],
    [0,0,1,1,1,0,0],
    [0,0,0,1,0,0,0],
  ],
  // Gear
  [
    [0,1,0,1,0,1,0],
    [1,1,1,1,1,1,1],
    [0,1,0,0,0,1,0],
    [1,1,0,0,0,1,1],
    [0,1,0,0,0,1,0],
    [1,1,1,1,1,1,1],
    [0,1,0,1,0,1,0],
  ],
  // Globe
  [
    [0,0,1,1,1,0,0],
    [0,1,0,1,0,1,0],
    [1,0,0,1,0,0,1],
    [1,1,1,1,1,1,1],
    [1,0,0,1,0,0,1],
    [0,1,0,1,0,1,0],
    [0,0,1,1,1,0,0],
  ],
  // Terminal
  [
    [1,1,1,1,1,1,1],
    [1,0,0,0,0,0,1],
    [1,0,1,1,0,0,1],
    [1,0,0,1,0,0,1],
    [1,0,0,0,0,0,1],
    [1,1,1,1,1,1,1],
    [0,0,1,1,1,0,0],
  ],
];

// Generate a pixel window texture with icon mural for a building face. `tintStructure`
// is passed in (bound to the active palette accent) so the facade base tracks the theme.
const createWindowTexture = (accentColor, width, height, seed, tintStructure) => {
  const canvas = document.createElement('canvas');
  const px = 8;
  const cols = 12;
  const rowCount = Math.max(16, Math.floor(height * 5));
  canvas.width = px * cols;
  canvas.height = px * rowCount;
  const ctx = canvas.getContext('2d');

  // Dark, but not black: facades need enough albedo for moon/neon bounce to
  // reveal them. The theme tint keeps the texture in-family.
  ctx.fillStyle = tintStructure('#24324f');
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Seeded random for consistent patterns
  const rand = seededRand(seed);

  // Draw random ambient windows (dimmer background pattern)
  for (let r = 1; r < rowCount - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      if (r % 3 === 0 || c % 3 === 0) continue;
      if (rand() > 0.5) {
        const bright = rand();
        if (bright > 0.85) {
          // Bright window - full accent
          ctx.fillStyle = accentColor + '70';
        } else if (bright > 0.6) {
          ctx.fillStyle = accentColor + '40';
        } else if (bright > 0.3) {
          ctx.fillStyle = accentColor + '20';
        } else {
          ctx.fillStyle = tintStructure('#1d2b4a');
        }
        ctx.fillRect(c * px + 1, r * px + 1, px - 2, px - 2);
      }
    }
  }

  // Thin horizontal floor-light rows. These make large faces read as stacked
  // occupied floors instead of a single blank slab, especially in night mode.
  for (let r = 2; r < rowCount - 1; r += 3) {
    const warmRow = rand() > 0.55;
    const rowAlpha = rand() > 0.7 ? 0.44 : 0.28;
    ctx.fillStyle = warmRow
      ? `rgba(234, 244, 255, ${rowAlpha})`
      : accentColor + (rowAlpha > 0.35 ? '70' : '45');

    for (let c = 1; c < cols - 1; c++) {
      if (rand() < 0.24) continue;
      ctx.fillRect(c * px + 1, r * px + 3, px - 2, 2);
    }
  }

  // Occasional brighter architectural bands, like stacked balcony/maintenance
  // strips, to echo the city-light reference without covering every floor.
  for (let r = 4 + (seed % 3); r < rowCount - 2; r += 8) {
    ctx.fillStyle = accentColor + '85';
    ctx.fillRect(0, r * px + 2, canvas.width, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(0, r * px + 1, canvas.width, 1);
  }

  // Draw pixel art icon mural centered on face
  const icon = PIXEL_ICONS[seed % PIXEL_ICONS.length];
  const iconRows = icon.length;
  const iconCols = icon[0].length;
  const startCol = Math.floor((cols - iconCols) / 2);
  const startRow = Math.floor((rowCount - iconRows) / 2);

  for (let r = 0; r < iconRows; r++) {
    for (let c = 0; c < iconCols; c++) {
      if (icon[r][c]) {
        // Bright accent pixel - solid, no frame gaps
        ctx.fillStyle = accentColor;
        ctx.fillRect((startCol + c) * px, (startRow + r) * px, px, px);
        // Slight inner highlight for pixel art depth
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.fillRect((startCol + c) * px + 1, (startRow + r) * px + 1, px - 3, px - 3);
      }
    }
  }

  // Draw vertical neon accent strips on edges of the face
  ctx.fillStyle = accentColor + '30';
  ctx.fillRect(0, 0, 2, canvas.height);
  ctx.fillRect(canvas.width - 2, 0, 2, canvas.height);

  // Horizontal accent line at top
  ctx.fillStyle = accentColor + '60';
  ctx.fillRect(0, 0, canvas.width, 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
};

// Rooftop antenna component
function RooftopAntenna({ height, color, accentColor, seed, width: _width, dimMul = 1 }) {
  const antennaRef = useRef();
  const blinkRef = useRef();
  const type = seed % 4;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (blinkRef.current) {
      // Blinking light on antenna tip
      blinkRef.current.material.opacity = ((Math.sin(t * 4 + seed) > 0.3) ? 0.9 : 0.1) * dimMul;
    }
    if (antennaRef.current && type === 2) {
      // Slow rotation for dish type
      antennaRef.current.rotation.y = t * 0.3 + seed;
    }
  });

  const antennaHeight = 0.6 + (seed % 30) / 30 * 0.8;

  return (
    <group position={[0, height, 0]}>
      {/* Main antenna mast */}
      <mesh position={[0, antennaHeight / 2, 0]}>
        <cylinderGeometry args={[0.015, 0.025, antennaHeight, 4]} />
        <meshBasicMaterial color={color} transparent opacity={0.7 * dimMul} />
      </mesh>

      {/* Blinking tip light */}
      <mesh ref={blinkRef} position={[0, antennaHeight + 0.05, 0]}>
        <sphereGeometry args={[0.04, 6, 6]} />
        <meshBasicMaterial
          color={seed % 2 === 0 ? '#ef4444' : accentColor}
          transparent
          opacity={0.9 * dimMul}
        />
      </mesh>
      <pointLight
        position={[0, antennaHeight + 0.05, 0]}
        color={seed % 2 === 0 ? '#ef4444' : accentColor}
        intensity={0.15 * dimMul}
        distance={3}
        decay={2}
      />

      {/* Type-specific details */}
      {type === 1 && (
        // Dish antenna
        <group ref={antennaRef} position={[0, antennaHeight * 0.7, 0]}>
          <mesh rotation={[0.3, 0, 0]}>
            <ringGeometry args={[0.05, 0.18, 8]} />
            <meshBasicMaterial color={accentColor} transparent opacity={0.4 * dimMul} side={THREE.DoubleSide} />
          </mesh>
        </group>
      )}
      {type === 2 && (
        // Array of small elements
        <group ref={antennaRef} position={[0, antennaHeight * 0.6, 0]}>
          {[0, 1, 2].map(i => (
            <mesh key={i} position={[0, i * 0.12, 0]} rotation={[Math.PI / 2, 0, (i * Math.PI) / 3]}>
              <planeGeometry args={[0.2, 0.03]} />
              <meshBasicMaterial color={accentColor} transparent opacity={0.5 * dimMul} side={THREE.DoubleSide} />
            </mesh>
          ))}
        </group>
      )}
      {type === 3 && (
        // Cross-bar antenna
        <>
          <mesh position={[0, antennaHeight * 0.75, 0]}>
            <boxGeometry args={[0.3, 0.015, 0.015]} />
            <meshBasicMaterial color={color} transparent opacity={0.6 * dimMul} />
          </mesh>
          <mesh position={[0, antennaHeight * 0.55, 0]}>
            <boxGeometry args={[0.2, 0.015, 0.015]} />
            <meshBasicMaterial color={color} transparent opacity={0.5 * dimMul} />
          </mesh>
        </>
      )}
    </group>
  );
}

// Vertical neon strip on building edge
function NeonEdgeStrip({ position, height, color, delay, dimMul = 1 }) {
  const ref = useRef();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    ref.current.material.opacity = (0.5 + Math.sin(t * 1.2 + delay) * 0.25) * dimMul;
  });

  return (
    <mesh ref={ref} position={position}>
      <boxGeometry args={[0.03, height, 0.03]} />
      <meshBasicMaterial color={color} transparent opacity={0.6 * dimMul} />
    </mesh>
  );
}

function FloorLightBands({ width, depth, height, color, accentColor, seed, dimMul = 1 }) {
  const bands = useMemo(() => {
    const rand = seededRand(seed + 97);
    const floorCount = Math.max(4, Math.min(14, Math.floor(height / 1.05)));
    const next = [];

    for (let i = 1; i <= floorCount; i++) {
      const y = (i / (floorCount + 1)) * height;
      const isCrown = i === floorCount || i === floorCount - 1;
      const show = isCrown || i % 3 === seed % 3 || rand() > 0.48;
      if (!show) continue;

      next.push({
        key: `${i}-${Math.round(y * 100)}`,
        y,
        color: rand() > 0.45 ? mixHex('#f8fbff', accentColor, 0.28) : color,
        opacity: isCrown ? 0.78 : 0.34 + rand() * 0.22,
        thickness: isCrown ? 0.055 : 0.032,
      });
    }

    return next;
  }, [accentColor, color, height, seed]);

  return (
    <group>
      {bands.map((band) => {
        const horizontalGeo = [width * 0.96, band.thickness, 0.035];
        const verticalGeo = [0.035, band.thickness, depth * 0.96];
        const faces = [
          { pos: [0, band.y, depth / 2 + 0.035], geo: horizontalGeo },
          { pos: [0, band.y, -(depth / 2 + 0.035)], geo: horizontalGeo },
          { pos: [width / 2 + 0.035, band.y, 0], geo: verticalGeo },
          { pos: [-(width / 2 + 0.035), band.y, 0], geo: verticalGeo },
        ];
        return (
          <group key={band.key}>
            {faces.map((face, i) => (
              <mesh key={i} position={face.pos}>
                <boxGeometry args={face.geo} />
                <meshBasicMaterial color={band.color} transparent opacity={band.opacity * dimMul} toneMapped={false} depthWrite={false} />
              </mesh>
            ))}
          </group>
        );
      })}
    </group>
  );
}

export default function Building({ app, position, agentCount, onClick, playSfx, neonBrightness = 1.2, isProximity = false, dimmed = false, dayMix = 0, playback = false, transitionState = null, onExited, rooftops = true, interiorWindows = false }) {
  const meshRef = useRef();
  const glowRef = useRef();
  const haloRef = useRef();
  const groupRef = useRef();
  const [hovered, setHovered] = useState(false);

  // Construction/teardown animation state (playback/scrubber only — issue #967).
  // In live mode buildings appear/disappear instantly as today; during playback a
  // newly-present building scales in from 0 (construction) and a departing one
  // scales out to 0 (teardown) before the cluster unmounts it.
  const exiting = transitionState === 'exiting';
  // Start small only when entering under playback; otherwise full size.
  const initialScale = playback && !exiting ? 0.001 : 1;
  const exitedFiredRef = useRef(false);
  // Smoothly-lerped status color so a status change recolors over a beat rather
  // than snapping. `displayed` is the current on-screen color; `target` is the
  // status color it eases toward. Both are persistent THREE.Color instances so
  // the per-frame lerp allocates nothing.
  const displayedColorRef = useRef(null);
  const targetColorRef = useRef(null);

  const { getBuildingColor, getAccentColor, tintStructure } = useCityPalette();
  const height = getBuildingHeight(app);
  const edgeColor = getBuildingColor(app.overallStatus, app.archived);
  const accentColor = getAccentColor(app);
  const isOnline = app.overallStatus === 'online' && !app.archived;
  const isStopped = app.overallStatus === 'stopped' && !app.archived;
  const { width, depth } = BUILDING_PARAMS;
  const dimMul = dimmed ? 0.25 : 1;

  // Daytime treatment: the building sheds its neon and reads as a sunlit solid. The
  // facade lerps from the dark cyber body toward a light, faintly status-tinted
  // wall; the dark window texture is dropped (it only reads at night) and the neon
  // edge softens to a plain architectural outline.
  // NOTE: dayMix is currently strictly 0 or 1 (the city renders only noon/sunset), so
  // the continuous lerps and the `daytime` hard-switches agree today. The lerps are
  // forward-looking — if an intermediate time-of-day is ever re-enabled, convert the
  // `!daytime`-gated mounts (halo/strips/glow/ground-lines) to opacity fades too so a
  // partial dayMix degrades gracefully instead of popping at 0.5.
  const daytime = dayMix > 0.5;
  // Mid-tone facade (not near-white) so strong daylight lands around a clean gray
  // rather than clipping to white; a touch of the status color keeps variety.
  const dayFacade = mixHex('#9aa0ac', edgeColor, 0.12);
  const nightFacade = mixHex(app.archived ? '#273247' : '#26375d', edgeColor, app.archived ? 0.12 : 0.2);
  const bodyColor = mixHex(nightFacade, dayFacade, dayMix);
  const edgeLineColor = daytime ? mixHex('#4a4f57', edgeColor, 0.15) : edgeColor;

  // Name hash for seeded randomness
  const seed = useMemo(() => {
    let h = 0;
    const n = app.name || app.id;
    for (let i = 0; i < n.length; i++) h = ((h << 5) - h) + n.charCodeAt(i);
    return Math.abs(h);
  }, [app.name, app.id]);

  const boxGeom = useMemo(() => new THREE.BoxGeometry(width, height, depth), [width, height, depth]);
  const edgesGeom = useMemo(() => new THREE.EdgesGeometry(boxGeom), [boxGeom]);

  // Window texture with pixel art icon
  const windowTexture = useMemo(
    () => createWindowTexture(accentColor, width, height, seed, tintStructure),
    [accentColor, width, height, seed, tintStructure]
  );

  // R3F does NOT dispose a CanvasTexture handed in via `map`/`emissiveMap` — it
  // only frees objects it owns on unmount. Since the city no longer remounts on
  // theme switch (issue-1064), each recolor recreates this texture and would
  // strand the previous one in VRAM per building. Dispose it on replace + unmount.
  useEffect(() => () => windowTexture.dispose(), [windowTexture]);

  // Format name for building face
  const displayName = useMemo(() => {
    return (app.name || '').replace(/[-_.]/g, ' ').toUpperCase();
  }, [app.name]);

  useFrame(({ clock }, delta) => {
    // Construction/teardown scale animation (playback only). damp() eases the
    // group scale toward 1 (entering) or 0 (exiting); reaching ~0 on exit fires
    // onExited so the cluster can drop the building from the tree.
    if (groupRef.current && playback) {
      const target = exiting ? 0 : 1;
      const cur = groupRef.current.scale.x;
      const next = THREE.MathUtils.damp(cur, target, 6, delta || 0.016);
      groupRef.current.scale.setScalar(next);
      if (exiting && next < 0.02 && !exitedFiredRef.current) {
        exitedFiredRef.current = true;
        onExited?.(app.id);
      }
    } else if (groupRef.current && groupRef.current.scale.x !== 1) {
      // Live mode (or after entering completes): ensure full size.
      groupRef.current.scale.setScalar(1);
    }

    if (!meshRef.current) return;
    const t = clock.getElapsedTime();

    // Status recolor: ease the body emissive toward the current status color so a
    // scrub that flips online→stopped fades cyan→red rather than snapping. Skip
    // the work entirely once the displayed color has converged (the common case,
    // including all of live mode) so it costs nothing per frame at rest.
    const mat = meshRef.current.material;
    if (mat?.emissive) {
      if (!displayedColorRef.current) displayedColorRef.current = new THREE.Color(edgeColor);
      if (!targetColorRef.current) targetColorRef.current = new THREE.Color();
      targetColorRef.current.set(edgeColor);
      const disp = displayedColorRef.current;
      const tgt = targetColorRef.current;
      if (Math.abs(disp.r - tgt.r) + Math.abs(disp.g - tgt.g) + Math.abs(disp.b - tgt.b) > 0.002) {
        disp.lerp(tgt, Math.min(1, (delta || 0.016) * 6));
        mat.emissive.copy(disp);
      } else if (!disp.equals(tgt)) {
        disp.copy(tgt);
        mat.emissive.copy(disp);
      }
    }

    const nb = neonBrightness;
    const baseIntensity = (isOnline ? 0.5 : isStopped ? 0.35 : 0.2) * nb;
    const pulse = isOnline
      ? Math.sin(t * 2 + seed) * 0.15 * nb
      : isStopped
        ? Math.sin(t * 3.5 + seed) * 0.2 * nb
        : 0;
    const hoverBoost = hovered ? 0.4 * nb : 0;
    // Neon self-glow fades out in daylight — the building is lit by the sun instead.
    meshRef.current.material.emissiveIntensity = (baseIntensity + pulse + hoverBoost) * dimMul * (1 - dayMix * 0.9);

    if (glowRef.current) {
      glowRef.current.material.opacity = (0.35 + (isOnline ? Math.sin(t * 1.5) * 0.12 : 0) + (hovered ? 0.25 : 0)) * dimMul;
    }

    // Glow halo wireframe pulse
    if (haloRef.current) {
      const haloBase = hovered
        ? 0.15 + Math.sin(t * 8) * 0.1
        : 0.05 + Math.sin(t * 1.5 + seed) * 0.03;
      haloRef.current.material.opacity = haloBase * dimMul;
    }
  });

  return (
    <group ref={groupRef} position={[position.x, 0, position.z]} scale={initialScale}>
      {/* Building body with window texture + pixel art icon */}
      <mesh
        ref={meshRef}
        position={[0, height / 2, 0]}
        onClick={() => { playSfx?.('buildingClick'); onClick?.(); }}
        onPointerEnter={() => { setHovered(true); playSfx?.('buildingHover'); }}
        onPointerLeave={() => setHovered(false)}
      >
        <boxGeometry args={[width, height, depth]} />
        <meshStandardMaterial
          color={daytime ? bodyColor : '#ffffff'}
          emissive={edgeColor}
          emissiveIntensity={0.7 * neonBrightness * dimMul * (1 - dayMix * 0.88)}
          map={daytime ? undefined : windowTexture}
          emissiveMap={daytime ? undefined : windowTexture}
          roughness={daytime ? 0.9 : 0.78}
          metalness={daytime ? 0.05 : 0.08}
          transparent
          opacity={(app.archived ? 0.78 : 1) * dimMul}
        />
      </mesh>

      {/* Interior-mapped window panes (InteriorMappingMaterial) — parallax fake-3D lit
          rooms on selected online towers. Night-only (by day the tower reads as a
          sunlit solid) and gated to the high quality preset by the caller. */}
      {!daytime && interiorWindows && buildingHasInteriorWindows(app, height) && (
        <BuildingWindows
          width={width}
          depth={depth}
          height={height}
          seed={seed}
          accentColor={accentColor}
          edgeColor={edgeColor}
          neonBrightness={neonBrightness}
          dimMul={dimMul}
        />
      )}

      {/* Building edges — bright neon by night, a plain architectural outline by day */}
      <lineSegments position={[0, height / 2, 0]} geometry={edgesGeom}>
        <lineBasicMaterial
          color={edgeLineColor}
          transparent
          opacity={((app.archived ? 0.5 : 0.9) - dayMix * 0.55) * dimMul}
        />
      </lineSegments>

      {/* Reflective glass roof cap on online buildings */}
      <mesh position={[0, height + 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width + 0.1, depth + 0.1]} />
        {isOnline ? (
          <meshPhysicalMaterial
            color={edgeColor}
            roughness={0.1}
            metalness={0.8}
            transparent
            opacity={0.7 * dimMul}
          />
        ) : (
          <meshBasicMaterial
            color={edgeColor}
            transparent
            opacity={(app.archived ? 0.2 : 0.5) * dimMul}
          />
        )}
      </mesh>

      {/* Rooftop fixtures — deterministic per app name; off on the low preset */}
      {rooftops && <RooftopKit name={app.name || app.id} width={width} y={height} />}

      {/* Glow halo wireframe - slightly larger than building (night only) */}
      {!app.archived && !daytime && (
        <lineSegments ref={haloRef} position={[0, height / 2, 0]}>
          <edgesGeometry args={[new THREE.BoxGeometry(width + 0.15, height + 0.15, depth + 0.15)]} />
          <lineBasicMaterial
            color={accentColor}
            transparent
            opacity={0.05 * dimMul}
          />
        </lineSegments>
      )}

      {/* Vertical neon edge strips on corners (night only) */}
      {!app.archived && !daytime && (
        <>
          <NeonEdgeStrip position={[width / 2, height / 2, depth / 2]} height={height} color={accentColor} delay={0} dimMul={dimMul} />
          <NeonEdgeStrip position={[-width / 2, height / 2, depth / 2]} height={height} color={accentColor} delay={1} dimMul={dimMul} />
          <NeonEdgeStrip position={[width / 2, height / 2, -depth / 2]} height={height} color={accentColor} delay={2} dimMul={dimMul} />
          <NeonEdgeStrip position={[-width / 2, height / 2, -depth / 2]} height={height} color={accentColor} delay={3} dimMul={dimMul} />
        </>
      )}

      {/* Lit floor bands stay on even for archived buildings so dark towers remain readable. */}
      {!daytime && (
        <FloorLightBands
          width={width}
          depth={depth}
          height={height}
          color={app.archived ? '#94a3b8' : edgeColor}
          accentColor={app.archived ? '#64748b' : accentColor}
          seed={seed}
          dimMul={dimMul * (app.archived ? 0.58 : 1)}
        />
      )}

      {/* Building name on front face - pixel font (dark ink + halo by day) */}
      <CityLabel
        position={[0, height * 0.88, depth / 2 + 0.02]}
        fontSize={0.2}
        color={edgeColor}
        dayMix={dayMix}
        fillOpacity={dimMul}
        anchorX="center"
        anchorY="middle"
        font={PIXEL_FONT_URL}
        maxWidth={width * 0.9}
      >
        {displayName}
      </CityLabel>

      {/* Building name on back face */}
      <CityLabel
        position={[0, height * 0.88, -(depth / 2 + 0.02)]}
        fontSize={0.2}
        color={edgeColor}
        dayMix={dayMix}
        fillOpacity={dimMul}
        anchorX="center"
        anchorY="middle"
        rotation={[0, Math.PI, 0]}
        font={PIXEL_FONT_URL}
        maxWidth={width * 0.9}
      >
        {displayName}
      </CityLabel>

      {/* Name on left side */}
      <CityLabel
        position={[-(width / 2 + 0.02), height * 0.88, 0]}
        fontSize={0.18}
        color={accentColor}
        dayMix={dayMix}
        fillOpacity={dimMul}
        anchorX="center"
        anchorY="middle"
        rotation={[0, -Math.PI / 2, 0]}
        font={PIXEL_FONT_URL}
        maxWidth={depth * 0.85}
      >
        {displayName}
      </CityLabel>

      {/* Base glow circle - wider and brighter (night only) */}
      {!daytime && (
        <mesh ref={glowRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
          <circleGeometry args={[1.8, 32]} />
          <meshBasicMaterial
            color={edgeColor}
            transparent
            opacity={0.25 * dimMul}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Neon ground line accents (night only) */}
      {!app.archived && !daytime && (
        <>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, depth / 2 + 0.3]}>
            <planeGeometry args={[width + 0.5, 0.05]} />
            <meshBasicMaterial color={accentColor} transparent opacity={0.5 * dimMul} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, -(depth / 2 + 0.3)]}>
            <planeGeometry args={[width + 0.5, 0.05]} />
            <meshBasicMaterial color={accentColor} transparent opacity={0.5 * dimMul} />
          </mesh>
        </>
      )}

      {/* Rooftop antenna */}
      {!app.archived && (
        <RooftopAntenna
          height={height}
          color={edgeColor}
          accentColor={accentColor}
          seed={seed}
          width={width}
          dimMul={dimMul}
        />
      )}

      {/* Floating hologram and label hide entirely when dimmed — they read as
          "this app isn't your focus right now". Major sub-meshes above already
          fade via dimMul; suppressing these keeps the dim effect unambiguous. */}
      {!dimmed && (
        <BuildingHologram
          position={[0, height + 0.8, 0]}
          color={accentColor}
          seed={seed}
        />
      )}

      {!dimmed && (hovered || isOnline || app.archived || isProximity) && (
        <HolographicPanel
          app={app}
          agentCount={agentCount}
          position={[0, height + 1.8, 0]}
          expanded={isProximity}
        />
      )}
    </group>
  );
}
