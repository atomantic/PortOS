import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  ARCHIPELAGO_ISLANDS,
  ARCHIPELAGO_LINKS,
  PARCELS,
  VILLAGE_GROUND,
  VILLAGE_ROUTES,
  WORLD,
  archipelagoLinkPoints,
  computeVillageAppLayout,
  isOnArchipelagoIsland,
  openWorldTerrainHeight,
} from '../../utils/openWorldPlan';
import { computeArtifacts } from '../../utils/openWorldArtifacts';
import { computeBackupVault } from '../../utils/openWorldBackupVault';
import { computeDataHarbor } from '../../utils/openWorldDataHarbor';
import { computeGoalMonuments } from '../../utils/openWorldGoalMonuments';
import { computeHealthTower } from '../../utils/openWorldHealthTower';
import { computeMemoryDistrict } from '../../utils/openWorldMemoryDistrict';
import { computeProductivityMonument } from '../../utils/openWorldProductivity';
import { computeTaskQueue } from '../../utils/openWorldTaskQueue';
import { computeVoiceMarker } from '../../utils/openWorldVoiceMarker';
import {
  PIXEL_FONT_URL,
  mixHex,
  openWorldDayMix,
  openWorldShowDetail,
  seededRand,
} from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';

const dummy = new THREE.Object3D();

const BIOME_COLORS = {
  port: ['#244c43', '#78a66f'],
  memory: ['#24483f', '#5b916c'],
  forge: ['#604c3b', '#a77955'],
  signal: ['#315866', '#6d9d96'],
  harbor: ['#31545b', '#66929a'],
  archive: ['#475448', '#82956f'],
  garden: ['#315c42', '#79a65f'],
  wellness: ['#37644e', '#82ad73'],
};

const VILLAGE_SITES = [
  { id: 'core', parcel: 'aiCore', label: 'PORTOS COMMON', wall: '#f3d6a6', roof: '#ec755d', accent: '#ffd166', special: 'core' },
  { id: 'memory', parcel: 'memory', label: 'MEMORY HOUSE', wall: '#d7c6ee', roof: '#7c5aa6', accent: '#cab6ff' },
  { id: 'backup', parcel: 'backupVault', label: 'BACKUP COTTAGE', wall: '#d9d0bf', roof: '#47645b', accent: '#91d2b5' },
  { id: 'tasks', parcel: 'taskQueue', label: 'TASK WORKSHOP', wall: '#f1c7a3', roof: '#b95f4d', accent: '#ffb86b' },
  { id: 'archive', parcel: 'warehouse', label: 'ARCHIVE LODGE', wall: '#d7d8c8', roof: '#5f6c59', accent: '#b8c99d' },
  { id: 'wellness', parcel: 'health', label: 'WELLNESS', wall: '#d9edc6', roof: '#4d8b67', accent: '#9ee493', special: 'greenhouse' },
  { id: 'focus', parcel: 'productivity', label: 'FOCUS FARM', wall: '#f2ddb4', roof: '#d18b47', accent: '#ffd166' },
  { id: 'sprint', parcel: 'jira', label: 'SPRINT STUDIO', wall: '#cadde4', roof: '#597c91', accent: '#93d8ef' },
  { id: 'quiet', parcel: 'easterEggs', label: 'QUIET CORNER', wall: '#dfd0e8', roof: '#7d678f', accent: '#d0b1e8' },
  { id: 'goals', parcel: 'goals', label: 'GOALS LODGE', wall: '#f2c7bd', roof: '#b74e66', accent: '#ff8fa3' },
  { id: 'voice', parcel: 'voice', label: 'VOICE RADIO', wall: '#c8dce8', roof: '#49778c', accent: '#85d8e8', special: 'radio' },
  { id: 'artifacts', parcel: 'artifacts', label: 'TROPHY HOUSE', wall: '#ecd9aa', roof: '#b98439', accent: '#ffe29a' },
  { id: 'harbor', parcel: 'dataHarbor', label: 'DATA PIER', wall: '#c7d8d3', roof: '#3f7180', accent: '#85d8e8', special: 'harbor' },
];

function islandOutline(island, count = 28) {
  const rand = seededRand(island.seed);
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2;
    const wobble = 0.9 + rand() * 0.14;
    return [
      island.center[0] + Math.cos(angle) * island.radiusX * wobble,
      island.center[1] + Math.sin(angle) * island.radiusZ * wobble,
    ];
  });
}

function createIslandGeometry(island) {
  const outline = islandOutline(island);
  const segments = outline.length;
  // Enough radial samples for the shared height field to read as rolling terrain, while
  // keeping a subtle low-poly character instead of giant pie-slice lighting facets.
  const rings = 14;
  const positions = [island.center[0], openWorldTerrainHeight(...island.center), island.center[1]];
  const topIndices = [];

  for (let ring = 1; ring <= rings; ring += 1) {
    const fraction = ring / rings;
    outline.forEach(([outerX, outerZ]) => {
      const x = island.center[0] + (outerX - island.center[0]) * fraction;
      const z = island.center[1] + (outerZ - island.center[1]) * fraction;
      positions.push(x, openWorldTerrainHeight(x, z), z);
    });
  }

  for (let segment = 0; segment < segments; segment += 1) {
    // XZ polygons wind clockwise when viewed from +Y; reverse the naïve outline order so
    // the playable top faces upward instead of being culled and exposing the ocean below.
    topIndices.push(0, 1 + ((segment + 1) % segments), 1 + segment);
  }
  for (let ring = 1; ring < rings; ring += 1) {
    const innerStart = 1 + (ring - 1) * segments;
    const outerStart = 1 + ring * segments;
    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments;
      const a = innerStart + segment;
      const b = outerStart + segment;
      const c = outerStart + next;
      const d = innerStart + next;
      topIndices.push(a, d, b, b, d, c);
    }
  }

  const sideIndices = [];
  const outerStart = 1 + (rings - 1) * segments;
  const sideStart = positions.length / 3;
  outline.forEach((_, segment) => {
    const source = (outerStart + segment) * 3;
    positions.push(positions[source], positions[source + 1], positions[source + 2]);
    positions.push(positions[source], WORLD.terrainY, positions[source + 2]);
  });
  for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments;
    const topA = sideStart + segment * 2;
    const bottomA = topA + 1;
    const topB = sideStart + next * 2;
    const bottomB = topB + 1;
    sideIndices.push(topA, bottomA, topB, bottomA, bottomB, topB);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex([...topIndices, ...sideIndices]);
  geometry.addGroup(0, topIndices.length, 0);
  geometry.addGroup(topIndices.length, sideIndices.length, 1);
  geometry.computeVertexNormals();
  return { geometry, outline };
}

function Island({ island, dayMix, detailed }) {
  const { surface } = useOpenWorldPalette();
  const { geometry, outline } = useMemo(() => createIslandGeometry(island), [island]);
  const rimGeometry = useMemo(() => {
    if (!detailed) return null;
    const curve = new THREE.CatmullRomCurve3(
      outline.map(([x, z]) => new THREE.Vector3(x, openWorldTerrainHeight(x, z) + 0.06, z)),
      true,
      'centripetal',
    );
    return new THREE.TubeGeometry(curve, outline.length * 2, 0.045, 4, true);
  }, [detailed, outline]);

  useEffect(() => () => {
    geometry.dispose();
    rimGeometry?.dispose();
  }, [geometry, rimGeometry]);

  const [nightColor, dayColor] = BIOME_COLORS[island.biome] || BIOME_COLORS.port;
  return (
    <group>
      <mesh geometry={geometry} receiveShadow>
        <meshStandardMaterial attach="material-0" {...surface} color={mixHex(nightColor, dayColor, dayMix)} roughness={0.98} metalness={0} flatShading />
        <meshStandardMaterial attach="material-1" {...surface} color={mixHex('#1d302a', '#5d6955', dayMix)} roughness={1} metalness={0} flatShading />
      </mesh>
      {rimGeometry && (
        <mesh geometry={rimGeometry}>
          <meshBasicMaterial color={mixHex('#7bb6a0', '#d8d6a7', dayMix)} transparent opacity={0.34} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

const routeCurve = (route) => new THREE.CatmullRomCurve3(
  route.points.map(([x, z]) => new THREE.Vector3(x, 0, z)),
  Boolean(route.closed),
  'centripetal',
);

function createRouteRibbon(route, width, yOffset) {
  const curve = routeCurve(route);
  const segments = Math.max(24, route.points.length * 16);
  const positions = [];
  const indices = [];
  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    const point = curve.getPointAt(t);
    const tangent = curve.getTangentAt(Math.min(0.9999, t)).normalize();
    const left = new THREE.Vector3(-tangent.z, 0, tangent.x).multiplyScalar(width / 2);
    const y = openWorldTerrainHeight(point.x, point.z) + yOffset;
    positions.push(point.x + left.x, y, point.z + left.z, point.x - left.x, y, point.z - left.z);
    if (index < segments) {
      const start = index * 2;
      indices.push(start, start + 2, start + 1, start + 2, start + 3, start + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return { curve, geometry };
}

function VillageRoutes({ dayMix, detailed }) {
  const routeMeshes = useMemo(() => VILLAGE_ROUTES.map((route) => ({
    ...route,
    shoulder: createRouteRibbon(route, route.width + 1.1, 0.045),
    lane: createRouteRibbon(route, route.width, 0.065),
  })), []);

  useEffect(() => () => routeMeshes.forEach((route) => {
    route.shoulder.geometry.dispose();
    route.lane.geometry.dispose();
  }), [routeMeshes]);

  return (
    <group>
      {routeMeshes.map((route) => (
        <group key={route.id}>
          <mesh geometry={route.shoulder.geometry} receiveShadow>
            <meshStandardMaterial color={mixHex('#4a4b40', '#e5d3a2', dayMix)} roughness={1} flatShading />
          </mesh>
          <mesh geometry={route.lane.geometry} receiveShadow>
            <meshStandardMaterial
              color={route.kind === 'path' ? mixHex('#6e5546', '#c89968', dayMix) : mixHex('#364749', '#7e8b7d', dayMix)}
              roughness={0.96}
              flatShading
            />
          </mesh>
          {detailed && route.kind === 'road' && Array.from({ length: route.closed ? 22 : 7 }, (_, index) => {
            const t = (index + 0.5) / (route.closed ? 22 : 7);
            const point = route.lane.curve.getPointAt(t);
            const tangent = route.lane.curve.getTangentAt(Math.min(0.999, t));
            return (
              <mesh
                key={`${route.id}-marker-${index}`}
                position={[point.x, openWorldTerrainHeight(point.x, point.z) + 0.09, point.z]}
                rotation={[-Math.PI / 2, 0, Math.atan2(tangent.z, tangent.x)]}
              >
                <planeGeometry args={[1.15, 0.12]} />
                <meshBasicMaterial color={mixHex('#79b9b2', '#f4e1a7', dayMix)} transparent opacity={0.66} toneMapped={false} />
              </mesh>
            );
          })}
        </group>
      ))}
    </group>
  );
}

function createCausewayGeometries() {
  return ARCHIPELAGO_LINKS.map((link) => createRouteRibbon(
    { points: archipelagoLinkPoints(link) },
    link.width + 0.7,
    0.02,
  ).geometry);
}

function VillageCauseways({ dayMix }) {
  const geometries = useMemo(() => createCausewayGeometries(), []);
  useEffect(() => () => geometries.forEach((geometry) => geometry.dispose()), [geometries]);
  return geometries.map((geometry, index) => (
    <mesh key={`causeway-${index}`} geometry={geometry} receiveShadow>
      <meshStandardMaterial color={mixHex('#40514b', '#b8a77f', dayMix)} roughness={1} flatShading />
    </mesh>
  ));
}

const distanceToSegment = (x, z, start, end) => {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq <= 1e-8 ? 0 : Math.max(0, Math.min(1, ((x - start[0]) * dx + (z - start[1]) * dz) / lengthSq));
  return Math.hypot(x - (start[0] + dx * t), z - (start[1] + dz * t));
};

const nearRoute = (x, z, padding = 0) => VILLAGE_ROUTES.some((route) => {
  for (let index = 1; index < route.points.length; index += 1) {
    if (distanceToSegment(x, z, route.points[index - 1], route.points[index]) < route.width / 2 + padding) return true;
  }
  if (route.closed && distanceToSegment(x, z, route.points.at(-1), route.points[0]) < route.width / 2 + padding) return true;
  return false;
});

const nearDoorstep = (x, z, radius = 7) => Object.values(PARCELS).some((parcel) => (
  Math.hypot(x - parcel.anchor[0], z - parcel.anchor[2]) < radius
));

function createDressing(detail) {
  const rand = seededRand(4079);
  const trees = [];
  const grass = [];
  const flowers = [];
  const rocks = [];
  const addCandidate = (list, total, options = {}) => {
    let attempts = 0;
    while (list.length < total && attempts < total * 18) {
      attempts += 1;
      const x = -66 + rand() * 132;
      const z = -82 + rand() * 142;
      if (!isOnArchipelagoIsland(x, z, options.inset || 2)) continue;
      if (nearRoute(x, z, options.routePadding || 0.8)) continue;
      if (nearDoorstep(x, z, options.doorstep || 6.5)) continue;
      const marketRadius = Math.hypot(x, z);
      if (options.clearMarket && marketRadius > 10.4 && marketRadius < 19.4) continue;
      list.push({ x, z, yaw: rand() * Math.PI * 2, scale: (options.minScale || 0.65) + rand() * (options.scaleRange || 0.7), variant: Math.floor(rand() * 4) });
    }
  };
  addCandidate(trees, Math.round(205 * detail), { routePadding: 1.7, doorstep: 8.5, minScale: 0.72, scaleRange: 0.85, inset: 3, clearMarket: true });
  addCandidate(grass, Math.round(980 * detail), { routePadding: 0.5, doorstep: 5, minScale: 0.65, scaleRange: 0.85, inset: 1.5 });
  addCandidate(flowers, Math.round(185 * detail), { routePadding: 0.36, doorstep: 4.5, minScale: 0.7, scaleRange: 0.76, inset: 2 });
  addCandidate(rocks, Math.round(38 * detail), { routePadding: 1, doorstep: 7, minScale: 0.35, scaleRange: 0.75, inset: 2.5, clearMarket: true });
  return { trees, grass, flowers, rocks };
}

function VillageDressing({ settings, dayMix }) {
  const { surface } = useOpenWorldPalette();
  const detail = settings?.effectiveTier === 'low' ? 0.34 : settings?.effectiveTier === 'medium' ? 0.68 : settings?.effectiveTier === 'ultra' ? 1.2 : 1;
  const { trees, grass, flowers, rocks } = useMemo(() => createDressing(detail), [detail]);
  const trunkRef = useRef();
  const canopyRefs = useRef([]);
  const grassRef = useRef();
  const flowerRef = useRef();
  const rockRef = useRef();

  useLayoutEffect(() => {
    trees.forEach((tree, index) => {
      const y = openWorldTerrainHeight(tree.x, tree.z);
      dummy.position.set(tree.x, y + 0.85 * tree.scale, tree.z);
      dummy.rotation.set(0, tree.yaw, 0);
      dummy.scale.set(tree.scale, tree.scale, tree.scale);
      dummy.updateMatrix();
      trunkRef.current?.setMatrixAt(index, dummy.matrix);
      [[-0.5, 2.15, 0.05, 1], [0.5, 2.15, 0.12, 0.92], [0, 2.62, -0.08, 0.95]].forEach(([ox, oy, oz, size], canopyIndex) => {
        dummy.position.set(tree.x + ox * tree.scale, y + oy * tree.scale, tree.z + oz * tree.scale);
        dummy.rotation.set(tree.yaw * 0.13, tree.yaw + canopyIndex * 0.5, tree.yaw * 0.08);
        dummy.scale.setScalar(tree.scale * size);
        dummy.updateMatrix();
        canopyRefs.current[canopyIndex]?.setMatrixAt(index, dummy.matrix);
      });
    });
    grass.forEach((item, index) => {
      dummy.position.set(item.x, openWorldTerrainHeight(item.x, item.z) + 0.23 * item.scale, item.z);
      dummy.rotation.set(0, item.yaw, (item.variant - 1.5) * 0.035);
      dummy.scale.set(item.scale, item.scale, item.scale);
      dummy.updateMatrix();
      grassRef.current?.setMatrixAt(index, dummy.matrix);
    });
    flowers.forEach((item, index) => {
      dummy.position.set(item.x, openWorldTerrainHeight(item.x, item.z) + 0.2 * item.scale, item.z);
      dummy.rotation.set(0, item.yaw, 0);
      dummy.scale.setScalar(item.scale);
      dummy.updateMatrix();
      flowerRef.current?.setMatrixAt(index, dummy.matrix);
    });
    rocks.forEach((item, index) => {
      dummy.position.set(item.x, openWorldTerrainHeight(item.x, item.z) + 0.2 * item.scale, item.z);
      dummy.rotation.set(item.yaw * 0.1, item.yaw, item.yaw * 0.08);
      dummy.scale.set(item.scale * 1.2, item.scale * 0.72, item.scale);
      dummy.updateMatrix();
      rockRef.current?.setMatrixAt(index, dummy.matrix);
    });
    [trunkRef.current, ...canopyRefs.current, grassRef.current, flowerRef.current, rockRef.current].forEach((mesh) => {
      if (!mesh) return;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere?.();
    });
  }, [flowers, grass, rocks, trees]);

  const leafColors = [
    mixHex('#315f48', '#6ea35f', dayMix),
    mixHex('#3a5c4b', '#8aad66', dayMix),
    mixHex('#5f4a4e', '#d78b82', dayMix),
  ];
  return (
    <group>
      <instancedMesh ref={trunkRef} args={[undefined, undefined, trees.length]} castShadow receiveShadow>
        <cylinderGeometry args={[0.14, 0.26, 1.7, 7]} />
        <meshStandardMaterial {...surface} color={mixHex('#2d372f', '#75553c', dayMix)} roughness={1} flatShading />
      </instancedMesh>
      {leafColors.map((color, index) => (
        <instancedMesh key={color} ref={(node) => { canopyRefs.current[index] = node; }} args={[undefined, undefined, trees.length]} castShadow>
          <dodecahedronGeometry args={[0.95, 0]} />
          <meshStandardMaterial {...surface} color={color} roughness={1} flatShading />
        </instancedMesh>
      ))}
      <instancedMesh ref={grassRef} args={[undefined, undefined, grass.length]} receiveShadow>
        <coneGeometry args={[0.24, 0.7, 4]} />
        <meshStandardMaterial color={mixHex('#29533f', '#86a94f', dayMix)} roughness={1} flatShading />
      </instancedMesh>
      <instancedMesh ref={flowerRef} args={[undefined, undefined, flowers.length]}>
        <octahedronGeometry args={[0.16, 0]} />
        <meshStandardMaterial color={mixHex('#bd76b4', '#ffd166', dayMix * 0.38)} emissive="#c46fad" emissiveIntensity={0.16} roughness={0.9} flatShading />
      </instancedMesh>
      <instancedMesh ref={rockRef} args={[undefined, undefined, rocks.length]} castShadow receiveShadow>
        <dodecahedronGeometry args={[0.62, 0]} />
        <meshStandardMaterial {...surface} color={mixHex('#33434a', '#85877b', dayMix)} roughness={1} flatShading />
      </instancedMesh>
    </group>
  );
}

function WarmWindow({ position, scale = [0.8, 0.74, 0.06], color }) {
  return (
    <mesh position={position}>
      <boxGeometry args={scale} />
      <meshStandardMaterial color="#3b5361" emissive={color} emissiveIntensity={0.42} roughness={0.52} />
    </mesh>
  );
}

function Cottage({ site, dayMix, metric }) {
  const parcel = PARCELS[site.parcel];
  const x = parcel.anchor[0];
  const z = parcel.anchor[2];
  const y = openWorldTerrainHeight(x, z);
  const width = site.special === 'harbor' ? 6.8 : 5.2;
  const depth = site.special === 'harbor' ? 4.2 : 4.6;
  const roofColor = mixHex(site.roof, '#5c5047', 1 - dayMix);
  const labelSize = site.label.length > 13 ? 0.235 : site.label.length > 10 ? 0.265 : 0.3;

  return (
    <group position={[x, y, z]}>
      {site.special === 'harbor' && (
        <mesh position={[0, 0.08, 2.8]} receiveShadow>
          <boxGeometry args={[11, 0.22, 7.5]} />
          <meshStandardMaterial color={mixHex('#32433f', '#9a7651', dayMix)} roughness={1} />
        </mesh>
      )}
      <mesh position={[0, 1.55, 0]} castShadow receiveShadow>
        <boxGeometry args={[width, 3.1, depth]} />
        <meshStandardMaterial color={site.wall} roughness={0.96} flatShading />
      </mesh>
      <mesh position={[0, 3.55, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[width * 0.73, 1.65, 4]} />
        <meshStandardMaterial color={roofColor} roughness={0.95} flatShading />
      </mesh>
      <mesh position={[0, 0.95, depth / 2 + 0.07]}>
        <boxGeometry args={[1.05, 1.9, 0.13]} />
        <meshStandardMaterial color={mixHex('#263a3b', '#755742', dayMix)} roughness={0.9} />
      </mesh>
      <WarmWindow position={[-1.55, 1.75, depth / 2 + 0.08]} color={site.accent} />
      <WarmWindow position={[1.55, 1.75, depth / 2 + 0.08]} color={site.accent} />
      {/* The plaque sits below and in front of the roofline. Its old y-position was exactly
          level with the roof's lower edge, so the eave hid every destination name. */}
      <mesh position={[0, 2.4, depth / 2 + 0.28]} castShadow>
        <boxGeometry args={[3.65, metric ? 0.82 : 0.62, 0.16]} />
        <meshStandardMaterial color={mixHex('#263c3a', '#fff1cc', dayMix * 0.16)} roughness={0.88} />
      </mesh>
      <Text position={[0, metric ? 2.55 : 2.4, depth / 2 + 0.39]} font={PIXEL_FONT_URL} fontSize={labelSize} color={mixHex(site.accent, '#fff0cf', dayMix * 0.72)} anchorX="center" anchorY="middle" letterSpacing={0.045}>
        {site.label}
      </Text>
      {metric && (
        <Text position={[0, 2.25, depth / 2 + 0.395]} font={PIXEL_FONT_URL} fontSize={0.145} color={mixHex(metric.color || site.accent, '#f7dfae', 0.46)} anchorX="center" anchorY="middle" letterSpacing={0.035}>
          {metric.label}
        </Text>
      )}
      <mesh position={[0, 0.17, depth / 2 + 1.15]} receiveShadow>
        <boxGeometry args={[2.7, 0.22, 1.6]} />
        <meshStandardMaterial color={mixHex('#3b4e45', '#c2a16d', dayMix)} roughness={1} />
      </mesh>
      {site.special === 'greenhouse' && (
        <mesh position={[0, 4.75, 0]}>
          <sphereGeometry args={[1.4, 16, 9, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshStandardMaterial color="#b7ead3" transparent opacity={0.5} roughness={0.18} metalness={0.08} />
        </mesh>
      )}
      {site.special === 'radio' && (
        <group position={[0, 5.4, 0]}>
          <mesh rotation={[0, 0, -0.18]}><cylinderGeometry args={[0.05, 0.05, 3.1, 7]} /><meshStandardMaterial color="#38545d" roughness={0.65} metalness={0.25} /></mesh>
          <mesh position={[0.25, 1.25, 0]} rotation={[0, 0, 0.38]}><coneGeometry args={[0.7, 0.34, 14, 1, true]} /><meshStandardMaterial color={site.accent} emissive={site.accent} emissiveIntensity={0.28} side={THREE.DoubleSide} /></mesh>
        </group>
      )}
      {[[-width / 2 - 0.8, depth / 2 + 0.3], [width / 2 + 0.8, depth / 2 + 0.3]].map(([px, pz], index) => (
        <group key={`${site.id}-planter-${index}`} position={[px, 0, pz]}>
          <mesh position={[0, 0.24, 0]}><cylinderGeometry args={[0.48, 0.38, 0.48, 8]} /><meshStandardMaterial color={mixHex('#4a3b35', '#b97856', dayMix)} roughness={1} /></mesh>
          <mesh position={[0, 0.72, 0]}><dodecahedronGeometry args={[0.48, 0]} /><meshStandardMaterial color={mixHex('#2d5a42', '#71a55f', dayMix)} roughness={1} flatShading /></mesh>
        </group>
      ))}
    </group>
  );
}

function CorePavilion({ site, dayMix }) {
  const [x, , z] = PARCELS.aiCore.anchor;
  const y = openWorldTerrainHeight(x, z);
  const orbRef = useRef();
  useFrame(({ clock }) => {
    if (!orbRef.current) return;
    const t = clock.getElapsedTime();
    orbRef.current.position.y = 2.45 + Math.sin(t * 1.4) * 0.12;
    orbRef.current.rotation.y = t * 0.45;
  });
  return (
    <group position={[x, y, z]}>
      <mesh receiveShadow position={[0, 0.08, 0]}><cylinderGeometry args={[7.2, 7.8, 0.34, 24]} /><meshStandardMaterial color={mixHex('#3f554e', '#d7c593', dayMix)} roughness={1} flatShading /></mesh>
      {Array.from({ length: 8 }, (_, index) => {
        const angle = (index / 8) * Math.PI * 2;
        return (
          <mesh key={`core-seat-${index}`} position={[Math.cos(angle) * 5.3, 0.34, Math.sin(angle) * 5.3]} rotation={[0, -angle, 0]} castShadow>
            <boxGeometry args={[2.2, 0.32, 0.78]} />
            <meshStandardMaterial color={mixHex('#31433d', '#ad7c52', dayMix)} roughness={1} />
          </mesh>
        );
      })}
      {[0, 1, 2].map((index) => {
        const angle = (index / 3) * Math.PI * 2;
        return (
          <mesh key={`core-arch-${index}`} position={[Math.cos(angle) * 3.6, 2.5, Math.sin(angle) * 3.6]} rotation={[0, -angle, 0]} castShadow>
            <boxGeometry args={[0.56, 5, 0.72]} />
            <meshStandardMaterial color={mixHex('#334d48', site.wall, dayMix * 0.72)} roughness={0.92} flatShading />
          </mesh>
        );
      })}
      <group ref={orbRef} position={[0, 2.45, 0]}>
        <mesh castShadow><dodecahedronGeometry args={[1.42, 0]} /><meshStandardMaterial color={site.accent} emissive={site.accent} emissiveIntensity={0.66} roughness={0.4} flatShading toneMapped={false} /></mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[2.1, 0.07, 8, 42]} /><meshBasicMaterial color="#fff1bb" transparent opacity={0.78} toneMapped={false} /></mesh>
      </group>
      <mesh position={[0, 0.52, 5.4]}><boxGeometry args={[3.8, 0.72, 0.18]} /><meshStandardMaterial color={mixHex('#263b39', '#f2ddb4', dayMix * 0.15)} roughness={0.9} /></mesh>
      <Text position={[0, 0.52, 5.52]} font={PIXEL_FONT_URL} fontSize={0.38} color={mixHex(site.accent, '#fff0cf', dayMix * 0.72)} anchorX="center" anchorY="middle" letterSpacing={0.08}>PORTOS COMMON</Text>
    </group>
  );
}

function VillageSites({ dayMix, metrics, jiraEnabled }) {
  return VILLAGE_SITES.filter((site) => site.id !== 'sprint' || jiraEnabled).map((site) => (
    site.special === 'core'
      ? <CorePavilion key={site.id} site={site} dayMix={dayMix} />
      : <Cottage key={site.id} site={site} dayMix={dayMix} metric={metrics?.[site.id]} />
  ));
}

const APP_STATUS_COLOR = {
  online: '#67c77b',
  stopped: '#ef6b63',
  not_started: '#e5b85c',
  unknown: '#91a0a3',
  not_found: '#91a0a3',
};

const appDisplayName = (app) => {
  const name = String(app?.name || app?.id || 'APP').trim().toUpperCase();
  return name.length > 17 ? `${name.slice(0, 15)}…` : name;
};

const activeAgentsForApp = (agentMap, appId) => {
  const agents = agentMap?.get?.(appId)?.agents;
  if (!Array.isArray(agents)) return 0;
  return agents.filter((agent) => ['running', 'coding', 'thinking', 'investigating'].includes(agent?.status || agent?.state)).length;
};

function AppKiosk({ app, position, agentMap, dayMix, onBuildingClick }) {
  const statusColor = APP_STATUS_COLOR[app.overallStatus] || APP_STATUS_COLOR.unknown;
  const activeAgents = Math.min(3, activeAgentsForApp(agentMap, app.id));
  const label = appDisplayName(app);
  const y = openWorldTerrainHeight(position.x, position.z);
  const labelSize = label.length > 13 ? 0.19 : 0.225;

  return (
    <group
      position={[position.x, y, position.z]}
      rotation={[0, position.yaw, 0]}
      onClick={(event) => {
        event.stopPropagation();
        onBuildingClick?.(app);
      }}
    >
      <mesh position={[0, 0.08, 0]} receiveShadow>
        <boxGeometry args={[2.55, 0.16, 1.85]} />
        <meshStandardMaterial color={mixHex('#3c4a42', '#c5a16b', dayMix)} roughness={1} />
      </mesh>
      <mesh position={[0, 0.93, -0.34]} castShadow receiveShadow>
        <boxGeometry args={[2.28, 1.7, 0.56]} />
        <meshStandardMaterial color={mixHex('#4b5660', '#eee0be', dayMix)} roughness={0.94} />
      </mesh>
      <mesh position={[0, 1.86, -0.08]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[1.52, 0.72, 4]} />
        <meshStandardMaterial color={mixHex('#38595a', statusColor, dayMix * 0.55)} roughness={0.96} flatShading />
      </mesh>
      <mesh position={[0, 0.78, 0.63]} castShadow>
        <boxGeometry args={[2.22, 0.2, 0.55]} />
        <meshStandardMaterial color={mixHex('#31443e', '#8b6446', dayMix)} roughness={1} />
      </mesh>
      <mesh position={[0, 1.28, 0.34]}>
        <boxGeometry args={[2.08, 0.5, 0.12]} />
        <meshStandardMaterial color={mixHex('#263b39', '#fff1cf', dayMix * 0.14)} roughness={0.9} />
      </mesh>
      <Text position={[0, 1.29, 0.415]} font={PIXEL_FONT_URL} fontSize={labelSize} color={mixHex(statusColor, '#fff0cf', dayMix * 0.58)} anchorX="center" anchorY="middle" letterSpacing={0.035}>
        {label}
      </Text>
      <mesh position={[0.92, 2.38, -0.08]} castShadow>
        <sphereGeometry args={[0.16, 8, 6]} />
        <meshStandardMaterial color={statusColor} emissive={statusColor} emissiveIntensity={app.overallStatus === 'online' ? 0.72 : 0.3} roughness={0.5} />
      </mesh>
      {Array.from({ length: activeAgents }, (_, index) => (
        <mesh key={`agent-${index}`} position={[-0.42 + index * 0.42, 1.02, 0.58]}>
          <dodecahedronGeometry args={[0.105, 0]} />
          <meshBasicMaterial color="#fff0a6" toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

function VillageAppMarket({ apps, appPositions, agentMap, dayMix, onBuildingClick }) {
  const managedApps = (Array.isArray(apps) ? apps : []).filter((app) => app?.id && !app.archived);
  const visibleApps = managedApps.filter((app) => appPositions?.has?.(app.id));
  const activeCount = managedApps.filter((app) => app.overallStatus === 'online').length;
  const totalManaged = managedApps.length;
  const overflow = Math.max(0, totalManaged - visibleApps.length);
  const banner = totalManaged === 0
    ? 'MANAGED APPS · READY FOR ARRIVALS'
    : `MANAGED APPS · ${activeCount}/${totalManaged} ONLINE${overflow ? ` · +${overflow} MORE` : ''}`;

  return (
    <group>
      <group position={[-5.8, openWorldTerrainHeight(-5.8, 10.5), 10.5]} rotation={[0, 0.18, 0]}>
        <mesh position={[-2.5, 1.22, 0]} castShadow><boxGeometry args={[0.12, 2.45, 0.14]} /><meshStandardMaterial color="#76553d" roughness={1} /></mesh>
        <mesh position={[2.5, 1.22, 0]} castShadow><boxGeometry args={[0.12, 2.45, 0.14]} /><meshStandardMaterial color="#76553d" roughness={1} /></mesh>
        <mesh position={[0, 2.1, 0]} castShadow><boxGeometry args={[5.2, 0.68, 0.15]} /><meshStandardMaterial color={mixHex('#29413d', '#f4dfad', dayMix * 0.15)} roughness={0.92} /></mesh>
        <Text position={[0, 2.1, 0.09]} font={PIXEL_FONT_URL} fontSize={0.185} color={mixHex('#80d5b0', '#fff0cf', dayMix * 0.72)} anchorX="center" anchorY="middle" letterSpacing={0.035}>{banner}</Text>
      </group>
      {visibleApps.map((app) => (
        <AppKiosk key={app.id} app={app} position={appPositions.get(app.id)} agentMap={agentMap} dayMix={dayMix} onBuildingClick={onBuildingClick} />
      ))}
    </group>
  );
}

function MemoryGrove({ district, inboxDepth, dayMix }) {
  return (
    <group>
      {district.clusters.slice(0, 7).map((cluster) => {
        const [x, , z] = cluster.position;
        const y = openWorldTerrainHeight(x, z);
        return (
          <group key={cluster.category} position={[x, y, z]}>
            <mesh position={[0, 0.65, 0]} castShadow><cylinderGeometry args={[0.09, 0.16, 1.3, 7]} /><meshStandardMaterial color="#71533f" roughness={1} /></mesh>
            {[[-0.32, 1.38], [0.32, 1.42], [0, 1.76]].map(([offset, height], blossomIndex) => (
              <mesh key={blossomIndex} position={[offset, height, (blossomIndex - 1) * 0.08]} castShadow>
                <dodecahedronGeometry args={[0.48 + Math.min(0.18, cluster.count * 0.015), 0]} />
                <meshStandardMaterial color={cluster.color} emissive={cluster.color} emissiveIntensity={0.16 + Math.min(0.32, cluster.importance * 0.025)} roughness={0.78} flatShading />
              </mesh>
            ))}
            <Text position={[0, 0.28, 0.52]} font={PIXEL_FONT_URL} fontSize={0.14} color={mixHex(cluster.color, '#4b4037', dayMix * 0.65)} anchorX="center" anchorY="middle">{cluster.count}</Text>
          </group>
        );
      })}
      {inboxDepth > 0 && (
        <group position={[-38, openWorldTerrainHeight(-38, -25), -25]}>
          <mesh position={[0, 0.3, 0]}><cylinderGeometry args={[0.72, 0.9, 0.6, 12]} /><meshStandardMaterial color="#46544d" roughness={1} /></mesh>
          <mesh position={[0, 0.57, 0]} rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[0.56, 18]} /><meshBasicMaterial color="#cab6ff" transparent opacity={0.82} toneMapped={false} /></mesh>
          <Text position={[0, 1.12, 0]} font={PIXEL_FONT_URL} fontSize={0.14} color="#cab6ff" anchorX="center" anchorY="middle">{`${inboxDepth} TO SORT`}</Text>
        </group>
      )}
    </group>
  );
}

function TaskYard({ queue, dayMix }) {
  const [x, , z] = PARCELS.taskQueue.anchor;
  return (
    <group position={[x + 4.2, openWorldTerrainHeight(x + 4.2, z), z - 0.5]}>
      {queue.crates.map((crate, index) => {
        const column = index % 2;
        const row = Math.floor(index / 2);
        return (
          <mesh key={crate.index} position={[(column - 0.5) * 1.12, 0.46 + row * 0.86, 0]} castShadow receiveShadow>
            <boxGeometry args={[0.98, 0.78, 0.92]} />
            <meshStandardMaterial color={mixHex('#5d493d', queue.color, dayMix * 0.34)} emissive={queue.color} emissiveIntensity={queue.active ? 0.13 : 0.03} roughness={0.95} />
          </mesh>
        );
      })}
      {queue.hasBlocked && <mesh position={[0, 4.15, 0]} rotation={[0, 0, Math.PI / 4]}><octahedronGeometry args={[0.42, 0]} /><meshBasicMaterial color={queue.color} toneMapped={false} /></mesh>}
    </group>
  );
}

function BackupPost({ vault }) {
  const [x, , z] = PARCELS.backupVault.anchor;
  const px = x - 4.2;
  const pz = z + 0.3;
  const pulse = vault.running || vault.alerting ? 0.78 : 0.38;
  return (
    <group position={[px, openWorldTerrainHeight(px, pz), pz]}>
      <mesh position={[0, 1.05, 0]} castShadow><cylinderGeometry args={[0.08, 0.12, 2.1, 7]} /><meshStandardMaterial color="#644b3a" roughness={1} /></mesh>
      <mesh position={[0, 2.08, 0]} castShadow><dodecahedronGeometry args={[0.48, 0]} /><meshStandardMaterial color={vault.color} emissive={vault.color} emissiveIntensity={pulse} roughness={0.62} /></mesh>
      <Text position={[0, 2.82, 0]} font={PIXEL_FONT_URL} fontSize={0.15} color={vault.color} anchorX="center" anchorY="middle">{vault.statusLabel}</Text>
    </group>
  );
}

function DataCargo({ harbor, dayMix }) {
  if (harbor.empty) return null;
  const count = Math.min(8, harbor.silos.length + harbor.racks.length);
  const [x, , z] = PARCELS.dataHarbor.anchor;
  return (
    <group>
      {Array.from({ length: count }, (_, index) => {
        const side = index % 2 === 0 ? -1 : 1;
        const row = Math.floor(index / 2);
        const px = x + side * (4.4 + row * 0.9);
        const pz = z + 0.4 - row * 0.55;
        return (
          <mesh key={`data-cargo-${index}`} position={[px, openWorldTerrainHeight(px, pz) + 0.48, pz]} castShadow receiveShadow>
            <boxGeometry args={[1.25, 0.92, 0.92]} />
            <meshStandardMaterial color={mixHex('#375158', index % 3 === 0 ? '#77c2b1' : '#d29b62', dayMix * 0.62)} roughness={0.9} metalness={0.04} />
          </mesh>
        );
      })}
    </group>
  );
}

function GoalFlags({ goals, dayMix }) {
  const [x, , z] = PARCELS.goals.anchor;
  return (
    <group>
      {goals.monuments.slice(0, 6).map((goal, index) => {
        const px = x - 5 + index * 1.65;
        const pz = z + 4.2;
        return (
          <group key={goal.id} position={[px, openWorldTerrainHeight(px, pz), pz]}>
            <mesh position={[0, 1.15, 0]}><cylinderGeometry args={[0.035, 0.05, 2.3, 6]} /><meshStandardMaterial color="#654d3c" roughness={1} /></mesh>
            <mesh position={[0.32, 1.82, 0]} rotation={[0, 0, -0.12]}><coneGeometry args={[0.33, 0.68, 3]} /><meshStandardMaterial color={mixHex(goal.color, '#f0c97b', dayMix * 0.16)} emissive={goal.color} emissiveIntensity={goal.built ? 0.28 : 0.08} roughness={0.86} /></mesh>
          </group>
        );
      })}
    </group>
  );
}

function VillagePortosLife({
  apps,
  appPositions,
  agentMap,
  backupStatus,
  cosTasks,
  healthMetrics,
  productivityData,
  goals,
  character,
  memoryGraph,
  inboxDepth,
  jiraTickets,
  jiraEnabled,
  introspection,
  voiceState,
  dayMix,
  onBuildingClick,
}) {
  const memory = useMemo(() => computeMemoryDistrict(memoryGraph), [memoryGraph]);
  const queue = useMemo(() => computeTaskQueue(cosTasks), [cosTasks]);
  const vault = useMemo(() => computeBackupVault(backupStatus), [backupStatus]);
  const harbor = useMemo(() => computeDataHarbor(introspection), [introspection]);
  const goalData = useMemo(() => computeGoalMonuments(Array.isArray(goals) ? goals : goals?.goals), [goals]);
  const artifacts = useMemo(() => computeArtifacts({ character, goals }), [character, goals]);
  const health = useMemo(() => computeHealthTower(healthMetrics), [healthMetrics]);
  const productivity = useMemo(() => computeProductivityMonument(productivityData), [productivityData]);
  const voice = useMemo(() => computeVoiceMarker(voiceState), [voiceState]);
  const archivedCount = (Array.isArray(apps) ? apps : []).filter((app) => app?.archived).length;
  const dataCount = harbor.empty ? 0 : harbor.silos.length + harbor.racks.length;
  const metrics = {
    memory: { label: `${memory.totalMemories} MEMORIES${inboxDepth > 0 ? ` · ${inboxDepth} TO SORT` : ''}`, color: '#8c6fd1' },
    backup: { label: vault.statusLabel, color: vault.color },
    tasks: { label: queue.total ? `${queue.total} OPEN · ${queue.state.toUpperCase()}` : 'QUEUE CLEAR', color: queue.color },
    archive: { label: `${archivedCount} ARCHIVED APP${archivedCount === 1 ? '' : 'S'}`, color: '#71806c' },
    wellness: { label: `${health.presentCount}/4 VITALS REPORTING`, color: health.hasData ? '#4d9b67' : '#71806c' },
    focus: { label: productivity.throughputLabel, color: productivity.color },
    sprint: { label: `${Array.isArray(jiraTickets) ? jiraTickets.length : 0} SPRINT TICKETS`, color: '#4f8ea9' },
    quiet: { label: 'SECRETS LIVE HERE', color: '#9477a5' },
    goals: { label: `${goalData.completedCount}/${goalData.total} GOALS COMPLETE`, color: '#b74e66' },
    voice: { label: voice.label, color: voice.color },
    artifacts: { label: `${artifacts.total} TROPH${artifacts.total === 1 ? 'Y' : 'IES'} EARNED`, color: '#b98439' },
    harbor: { label: `${dataCount} DATA DOMAINS`, color: harbor.dbDown ? '#c46b62' : '#4f8e91' },
  };

  return (
    <group>
      <VillageSites dayMix={dayMix} metrics={metrics} jiraEnabled={jiraEnabled} />
      <VillageAppMarket apps={apps} appPositions={appPositions} agentMap={agentMap} dayMix={dayMix} onBuildingClick={onBuildingClick} />
      <MemoryGrove district={memory} inboxDepth={inboxDepth} dayMix={dayMix} />
      <TaskYard queue={queue} dayMix={dayMix} />
      <BackupPost vault={vault} />
      <DataCargo harbor={harbor} dayMix={dayMix} />
      <GoalFlags goals={goalData} dayMix={dayMix} />
    </group>
  );
}

function Bench({ position, rotation = 0, dayMix }) {
  return (
    <group position={[position[0], openWorldTerrainHeight(position[0], position[1]), position[1]]} rotation={[0, rotation, 0]}>
      <mesh position={[0, 0.55, 0]} castShadow><boxGeometry args={[2.4, 0.22, 0.55]} /><meshStandardMaterial color={mixHex('#3a443d', '#bb8052', dayMix)} roughness={1} /></mesh>
      <mesh position={[0, 1.04, 0.22]} rotation={[-0.12, 0, 0]} castShadow><boxGeometry args={[2.4, 0.82, 0.18]} /><meshStandardMaterial color={mixHex('#3a443d', '#bb8052', dayMix)} roughness={1} /></mesh>
      {[-0.82, 0.82].map((x) => <mesh key={x} position={[x, 0.24, 0]}><boxGeometry args={[0.18, 0.48, 0.42]} /><meshStandardMaterial color="#34423f" roughness={0.8} /></mesh>)}
    </group>
  );
}

function VillageProps({ dayMix }) {
  const lanterns = [[-12, 32], [12, 32], [-27, 11], [28, 3], [-16, -18], [17, -18], [0, -37], [0, -53]];
  return (
    <group>
      <group position={[0, openWorldTerrainHeight(0, 41), 41]}>
        {[-3.3, 3.3].map((x) => <mesh key={x} position={[x, 3, 0]} castShadow><boxGeometry args={[0.52, 6, 0.65]} /><meshStandardMaterial color={mixHex('#354943', '#b98554', dayMix)} roughness={1} /></mesh>)}
        <mesh position={[0, 5.7, 0]} castShadow><boxGeometry args={[7.15, 0.65, 0.72]} /><meshStandardMaterial color={mixHex('#354943', '#b98554', dayMix)} roughness={1} /></mesh>
        <mesh position={[0, 5.08, 0.38]}><boxGeometry args={[3.8, 0.95, 0.18]} /><meshStandardMaterial color={mixHex('#293d39', '#f0ddb2', dayMix * 0.18)} roughness={0.9} /></mesh>
        <Text position={[0, 5.08, 0.5]} font={PIXEL_FONT_URL} fontSize={0.38} color={mixHex('#94d7bf', '#fff0cf', dayMix * 0.78)} anchorX="center" anchorY="middle" letterSpacing={0.08}>PORTOS VILLAGE</Text>
      </group>
      {lanterns.map(([x, z], index) => (
        <group key={`lantern-${index}`} position={[x, openWorldTerrainHeight(x, z), z]}>
          <mesh position={[0, 1.2, 0]} castShadow><cylinderGeometry args={[0.07, 0.11, 2.4, 7]} /><meshStandardMaterial color="#344746" roughness={0.75} metalness={0.12} /></mesh>
          <mesh position={[0, 2.25, 0]} castShadow><boxGeometry args={[0.52, 0.68, 0.52]} /><meshStandardMaterial color="#355058" emissive="#ffd27a" emissiveIntensity={0.58} roughness={0.48} /></mesh>
          <mesh position={[0, 2.67, 0]} rotation={[0, Math.PI / 4, 0]}><coneGeometry args={[0.5, 0.35, 4]} /><meshStandardMaterial color="#a85749" roughness={1} /></mesh>
        </group>
      ))}
      <Bench position={[-8, 9]} rotation={0.58} dayMix={dayMix} />
      <Bench position={[10, 10]} rotation={-0.6} dayMix={dayMix} />
      <Bench position={[-7, -30]} rotation={2.7} dayMix={dayMix} />
      {Array.from({ length: 20 }, (_, index) => {
        const row = Math.floor(index / 5);
        const column = index % 5;
        const x = -40 + column * 1.15;
        const z = 19 + row * 1.1;
        return (
          <group key={`crop-${index}`} position={[x, openWorldTerrainHeight(x, z), z]}>
            <mesh position={[0, 0.1, 0]}><boxGeometry args={[0.9, 0.16, 0.78]} /><meshStandardMaterial color="#74533c" roughness={1} /></mesh>
            <mesh position={[0, 0.47, 0]}><dodecahedronGeometry args={[0.34, 0]} /><meshStandardMaterial color={index % 3 === 0 ? '#e7b84b' : '#69a45b'} roughness={1} flatShading /></mesh>
          </group>
        );
      })}
      <mesh position={[8, openWorldTerrainHeight(8, 17) + 0.035, 17]} rotation={[-Math.PI / 2, 0, -0.18]}>
        <circleGeometry args={[4.7, 32]} />
        <meshStandardMaterial color={mixHex('#224f5c', '#69b4aa', dayMix)} emissive="#4e9d9b" emissiveIntensity={0.12} roughness={0.28} metalness={0.08} transparent opacity={0.92} />
      </mesh>
    </group>
  );
}

function Fireflies({ dayMix }) {
  const refs = useRef([]);
  const particles = useMemo(() => Array.from({ length: 24 }, (_, index) => ({ x: -24 + ((index * 17) % 49), z: -26 + ((index * 29) % 59), phase: index * 0.83 })), []);
  useFrame(({ clock }) => {
    const time = clock.getElapsedTime();
    refs.current.forEach((mesh, index) => {
      if (!mesh) return;
      const point = particles[index];
      mesh.position.set(point.x + Math.sin(time * 0.43 + point.phase) * 1.4, openWorldTerrainHeight(point.x, point.z) + 1.3 + Math.sin(time * 1.2 + point.phase) * 0.55, point.z + Math.cos(time * 0.37 + point.phase) * 1.1);
    });
  });
  return (
    <group>
      {particles.map((particle, index) => (
        <mesh key={particle.phase} ref={(node) => { refs.current[index] = node; }}><sphereGeometry args={[0.075, 6, 5]} /><meshBasicMaterial color={mixHex('#7ee4d5', '#fff0a6', dayMix)} transparent opacity={0.84} toneMapped={false} /></mesh>
      ))}
    </group>
  );
}

export default function OpenWorldArchipelago({
  settings,
  explorationMode = false,
  apps = [],
  appPositions = null,
  agentMap = null,
  backupStatus = null,
  cosTasks = [],
  healthMetrics = null,
  productivityData = null,
  goals = null,
  character = null,
  memoryGraph = null,
  inboxDepth = 0,
  jiraTickets = [],
  jiraEnabled = true,
  introspection = null,
  voiceState = null,
  onBuildingClick,
}) {
  const naturalDayMix = openWorldDayMix(settings);
  // Keep the village colorful through evening hours. Night is expressed by warm windows,
  // lanterns, and the sky—not by turning the entire playable ground into near-black ink.
  const dayMix = explorationMode ? Math.max(0.74, naturalDayMix) : naturalDayMix;
  const detailed = openWorldShowDetail(settings);
  const resolvedAppPositions = useMemo(
    () => appPositions || computeVillageAppLayout(apps),
    [appPositions, apps],
  );
  return (
    <group>
      {explorationMode
        ? <Island island={VILLAGE_GROUND} dayMix={dayMix} detailed={detailed} />
        : ARCHIPELAGO_ISLANDS.map((island) => <Island key={island.id} island={island} dayMix={dayMix} detailed={detailed} />)}
      {!explorationMode && <VillageCauseways dayMix={dayMix} />}
      <VillageRoutes dayMix={dayMix} detailed={detailed} />
      <VillageDressing settings={settings} dayMix={dayMix} />
      {explorationMode && (
        <>
          <VillagePortosLife
            apps={apps}
            appPositions={resolvedAppPositions}
            agentMap={agentMap}
            backupStatus={backupStatus}
            cosTasks={cosTasks}
            healthMetrics={healthMetrics}
            productivityData={productivityData}
            goals={goals}
            character={character}
            memoryGraph={memoryGraph}
            inboxDepth={inboxDepth}
            jiraTickets={jiraTickets}
            jiraEnabled={jiraEnabled}
            introspection={introspection}
            voiceState={voiceState}
            dayMix={dayMix}
            onBuildingClick={onBuildingClick}
          />
          <VillageProps dayMix={dayMix} />
          {detailed && <Fireflies dayMix={dayMix} />}
        </>
      )}
    </group>
  );
}
