import { useRef, useState, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { getBuildingColor, getBuildingHeight, getAccentColor, CITY_COLORS, BUILDING_PARAMS, PIXEL_FONT_URL } from './cityConstants';
import HolographicPanel from './HolographicPanel';

// Generate a pixel window texture for a building face
const createWindowTexture = (accentColor, width, height, seed) => {
  const canvas = document.createElement('canvas');
  const px = 8; // pixel grid size
  canvas.width = px * 8;
  canvas.height = px * Math.max(12, Math.floor(height * 4));
  const ctx = canvas.getContext('2d');

  // Dark base
  ctx.fillStyle = '#050510';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Seeded random for consistent patterns
  let s = seed;
  const rand = () => { s = (s * 16807 + 0) % 2147483647; return (s & 0x7fffffff) / 2147483647; };

  // Draw window grid
  const rows = Math.floor(canvas.height / px);
  const cols = Math.floor(canvas.width / px);

  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      if (r % 3 === 0 || c % 3 === 0) continue; // Window frame gaps
      const lit = rand() > 0.5;
      if (lit) {
        // Mix between accent and white-ish for warm window glow
        const bright = rand();
        if (bright > 0.7) {
          ctx.fillStyle = accentColor;
        } else if (bright > 0.3) {
          ctx.fillStyle = accentColor + '80'; // Semi-transparent accent
        } else {
          ctx.fillStyle = '#0f172a';
        }
        ctx.fillRect(c * px, r * px, px - 1, px - 1);
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
};

export default function Building({ app, position, agentCount, onClick }) {
  const meshRef = useRef();
  const glowRef = useRef();
  const nameRef = useRef();
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

  // Window texture for building faces
  const windowTexture = useMemo(
    () => createWindowTexture(accentColor, width, height, seed),
    [accentColor, width, height, seed]
  );

  // Format name for building face: replace separators with spaces, full name
  const displayName = useMemo(() => {
    return (app.name || '').replace(/[-_.]/g, ' ').toUpperCase();
  }, [app.name]);

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const t = clock.getElapsedTime();

    const baseIntensity = isOnline ? 0.2 : 0.05;
    const pulse = isOnline ? Math.sin(t * 2 + seed) * 0.08 : 0;
    const hoverBoost = hovered ? 0.25 : 0;
    meshRef.current.material.emissiveIntensity = baseIntensity + pulse + hoverBoost;

    if (glowRef.current) {
      glowRef.current.material.opacity = 0.2 + (isOnline ? Math.sin(t * 1.5) * 0.08 : 0) + (hovered ? 0.15 : 0);
    }
  });

  return (
    <group position={[position.x, 0, position.z]}>
      {/* Building body with window texture */}
      <mesh
        ref={meshRef}
        position={[0, height / 2, 0]}
        onClick={onClick}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <boxGeometry args={[width, height, depth]} />
        <meshStandardMaterial
          color={CITY_COLORS.buildingBody}
          emissive={edgeColor}
          emissiveIntensity={0.1}
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

      {/* Neon accent strip at building top */}
      <mesh position={[0, height + 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width + 0.1, depth + 0.1]} />
        <meshBasicMaterial
          color={edgeColor}
          transparent
          opacity={app.archived ? 0.2 : 0.4}
        />
      </mesh>

      {/* Building name on front face - pixel font */}
      <Text
        ref={nameRef}
        position={[0, height * 0.65, depth / 2 + 0.02]}
        fontSize={0.22}
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
        position={[0, height * 0.65, -(depth / 2 + 0.02)]}
        fontSize={0.22}
        color={edgeColor}
        anchorX="center"
        anchorY="middle"
        rotation={[0, Math.PI, 0]}
        font={PIXEL_FONT_URL}
        maxWidth={width * 0.9}
      >
        {displayName}
      </Text>

      {/* Vertical name on left side */}
      <Text
        position={[-(width / 2 + 0.02), height * 0.5, 0]}
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

      {/* Base glow circle */}
      <mesh ref={glowRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <circleGeometry args={[1.5, 32]} />
        <meshBasicMaterial
          color={edgeColor}
          transparent
          opacity={0.2}
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

      {/* Holographic label */}
      {(hovered || isOnline || app.archived) && (
        <HolographicPanel
          app={app}
          agentCount={agentCount}
          position={[0, height + 1.0, 0]}
        />
      )}
    </group>
  );
}
