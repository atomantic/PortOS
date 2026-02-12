import { useRef, useState, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { getBuildingColor, getBuildingHeight, getAccentColor, CITY_COLORS, BUILDING_PARAMS, PIXEL_FONT_URL } from './cityConstants';
import HolographicPanel from './HolographicPanel';
import BuildingHologram from './BuildingHologram';

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

// Generate a pixel window texture with icon mural for a building face
const createWindowTexture = (accentColor, width, height, seed) => {
  const canvas = document.createElement('canvas');
  const px = 8;
  const cols = 12;
  const rowCount = Math.max(16, Math.floor(height * 5));
  canvas.width = px * cols;
  canvas.height = px * rowCount;
  const ctx = canvas.getContext('2d');

  // Dark base
  ctx.fillStyle = '#050510';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Seeded random for consistent patterns
  let s = seed;
  const rand = () => { s = (s * 16807 + 0) % 2147483647; return (s & 0x7fffffff) / 2147483647; };

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
          ctx.fillStyle = '#0a0f1e';
        }
        ctx.fillRect(c * px + 1, r * px + 1, px - 2, px - 2);
      }
    }
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
function RooftopAntenna({ height, color, accentColor, seed, width }) {
  const antennaRef = useRef();
  const blinkRef = useRef();
  const type = seed % 4;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (blinkRef.current) {
      // Blinking light on antenna tip
      blinkRef.current.material.opacity = (Math.sin(t * 4 + seed) > 0.3) ? 0.9 : 0.1;
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
        <meshBasicMaterial color={color} transparent opacity={0.7} />
      </mesh>

      {/* Blinking tip light */}
      <mesh ref={blinkRef} position={[0, antennaHeight + 0.05, 0]}>
        <sphereGeometry args={[0.04, 6, 6]} />
        <meshBasicMaterial
          color={seed % 2 === 0 ? '#ef4444' : accentColor}
          transparent
          opacity={0.9}
        />
      </mesh>
      <pointLight
        position={[0, antennaHeight + 0.05, 0]}
        color={seed % 2 === 0 ? '#ef4444' : accentColor}
        intensity={0.15}
        distance={3}
        decay={2}
      />

      {/* Type-specific details */}
      {type === 1 && (
        // Dish antenna
        <group ref={antennaRef} position={[0, antennaHeight * 0.7, 0]}>
          <mesh rotation={[0.3, 0, 0]}>
            <ringGeometry args={[0.05, 0.18, 8]} />
            <meshBasicMaterial color={accentColor} transparent opacity={0.4} side={THREE.DoubleSide} />
          </mesh>
        </group>
      )}
      {type === 2 && (
        // Array of small elements
        <group ref={antennaRef} position={[0, antennaHeight * 0.6, 0]}>
          {[0, 1, 2].map(i => (
            <mesh key={i} position={[0, i * 0.12, 0]} rotation={[Math.PI / 2, 0, (i * Math.PI) / 3]}>
              <planeGeometry args={[0.2, 0.03]} />
              <meshBasicMaterial color={accentColor} transparent opacity={0.5} side={THREE.DoubleSide} />
            </mesh>
          ))}
        </group>
      )}
      {type === 3 && (
        // Cross-bar antenna
        <>
          <mesh position={[0, antennaHeight * 0.75, 0]}>
            <boxGeometry args={[0.3, 0.015, 0.015]} />
            <meshBasicMaterial color={color} transparent opacity={0.6} />
          </mesh>
          <mesh position={[0, antennaHeight * 0.55, 0]}>
            <boxGeometry args={[0.2, 0.015, 0.015]} />
            <meshBasicMaterial color={color} transparent opacity={0.5} />
          </mesh>
        </>
      )}
    </group>
  );
}

// Vertical neon strip on building edge
function NeonEdgeStrip({ position, height, color, delay }) {
  const ref = useRef();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    ref.current.material.opacity = 0.3 + Math.sin(t * 1.2 + delay) * 0.2;
  });

  return (
    <mesh ref={ref} position={position}>
      <boxGeometry args={[0.03, height, 0.03]} />
      <meshBasicMaterial color={color} transparent opacity={0.4} />
    </mesh>
  );
}

export default function Building({ app, position, agentCount, onClick, playSfx }) {
  const meshRef = useRef();
  const glowRef = useRef();
  const haloRef = useRef();
  const [hovered, setHovered] = useState(false);

  const height = getBuildingHeight(app);
  const edgeColor = getBuildingColor(app.overallStatus, app.archived);
  const accentColor = getAccentColor(app);
  const isOnline = app.overallStatus === 'online' && !app.archived;
  const { width, depth } = BUILDING_PARAMS;

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
    () => createWindowTexture(accentColor, width, height, seed),
    [accentColor, width, height, seed]
  );

  // Format name for building face
  const displayName = useMemo(() => {
    return (app.name || '').replace(/[-_.]/g, ' ').toUpperCase();
  }, [app.name]);

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const t = clock.getElapsedTime();

    const baseIntensity = isOnline ? 0.25 : 0.08;
    const pulse = isOnline ? Math.sin(t * 2 + seed) * 0.1 : 0;
    const hoverBoost = hovered ? 0.3 : 0;
    meshRef.current.material.emissiveIntensity = baseIntensity + pulse + hoverBoost;

    if (glowRef.current) {
      glowRef.current.material.opacity = 0.25 + (isOnline ? Math.sin(t * 1.5) * 0.1 : 0) + (hovered ? 0.2 : 0);
    }

    // Glow halo wireframe pulse
    if (haloRef.current) {
      haloRef.current.material.opacity = hovered
        ? 0.15 + Math.sin(t * 8) * 0.1
        : 0.05 + Math.sin(t * 1.5 + seed) * 0.03;
    }
  });

  return (
    <group position={[position.x, 0, position.z]}>
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
          color={CITY_COLORS.buildingBody}
          emissive={edgeColor}
          emissiveIntensity={0.15}
          map={windowTexture}
          transparent
          opacity={app.archived ? 0.75 : 0.95}
        />
      </mesh>

      {/* Neon wireframe edges */}
      <lineSegments position={[0, height / 2, 0]} geometry={edgesGeom}>
        <lineBasicMaterial
          color={edgeColor}
          transparent
          opacity={app.archived ? 0.5 : 0.9}
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
            opacity={0.7}
          />
        ) : (
          <meshBasicMaterial
            color={edgeColor}
            transparent
            opacity={app.archived ? 0.2 : 0.5}
          />
        )}
      </mesh>

      {/* Glow halo wireframe - slightly larger than building */}
      {!app.archived && (
        <lineSegments ref={haloRef} position={[0, height / 2, 0]}>
          <edgesGeometry args={[new THREE.BoxGeometry(width + 0.15, height + 0.15, depth + 0.15)]} />
          <lineBasicMaterial
            color={accentColor}
            transparent
            opacity={0.05}
          />
        </lineSegments>
      )}

      {/* Vertical neon edge strips on corners */}
      {!app.archived && (
        <>
          <NeonEdgeStrip position={[width / 2, height / 2, depth / 2]} height={height} color={accentColor} delay={0} />
          <NeonEdgeStrip position={[-width / 2, height / 2, depth / 2]} height={height} color={accentColor} delay={1} />
          <NeonEdgeStrip position={[width / 2, height / 2, -depth / 2]} height={height} color={accentColor} delay={2} />
          <NeonEdgeStrip position={[-width / 2, height / 2, -depth / 2]} height={height} color={accentColor} delay={3} />
        </>
      )}

      {/* Building name on front face - pixel font */}
      <Text
        position={[0, height * 0.88, depth / 2 + 0.02]}
        fontSize={0.2}
        color={edgeColor}
        anchorX="center"
        anchorY="middle"
        font={PIXEL_FONT_URL}
        maxWidth={width * 0.9}
      >
        {displayName}
      </Text>

      {/* Building name on back face */}
      <Text
        position={[0, height * 0.88, -(depth / 2 + 0.02)]}
        fontSize={0.2}
        color={edgeColor}
        anchorX="center"
        anchorY="middle"
        rotation={[0, Math.PI, 0]}
        font={PIXEL_FONT_URL}
        maxWidth={width * 0.9}
      >
        {displayName}
      </Text>

      {/* Name on left side */}
      <Text
        position={[-(width / 2 + 0.02), height * 0.88, 0]}
        fontSize={0.18}
        color={accentColor}
        anchorX="center"
        anchorY="middle"
        rotation={[0, -Math.PI / 2, 0]}
        font={PIXEL_FONT_URL}
        maxWidth={depth * 0.85}
      >
        {displayName}
      </Text>

      {/* Base glow circle - wider and brighter */}
      <mesh ref={glowRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <circleGeometry args={[1.8, 32]} />
        <meshBasicMaterial
          color={edgeColor}
          transparent
          opacity={0.25}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Neon ground line accents */}
      {!app.archived && (
        <>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, depth / 2 + 0.3]}>
            <planeGeometry args={[width + 0.5, 0.05]} />
            <meshBasicMaterial color={accentColor} transparent opacity={0.5} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, -(depth / 2 + 0.3)]}>
            <planeGeometry args={[width + 0.5, 0.05]} />
            <meshBasicMaterial color={accentColor} transparent opacity={0.5} />
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
        />
      )}

      {/* Floating hologram above building */}
      <BuildingHologram
        position={[0, height + 0.8, 0]}
        color={accentColor}
        seed={seed}
      />

      {/* Holographic label */}
      {(hovered || isOnline || app.archived) && (
        <HolographicPanel
          app={app}
          agentCount={agentCount}
          position={[0, height + 1.8, 0]}
        />
      )}
    </group>
  );
}
