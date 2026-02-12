import { useState, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import CityGround from './CityGround';
import CityLights from './CityLights';
import CityParticles from './CityParticles';
import CityStarfield from './CityStarfield';
import CityCelestial from './CityCelestial';
import BuildingCluster from './BuildingCluster';
import CityDataStreams from './CityDataStreams';
import CityTraffic from './CityTraffic';
import CityRoads from './CityRoads';

export default function CityScene({ apps, agentMap, onBuildingClick }) {
  const [positions, setPositions] = useState(null);

  const handlePositionsReady = useCallback((pos) => {
    setPositions(pos);
  }, []);

  return (
    <Canvas
      camera={{ position: [0, 18, 30], fov: 50 }}
      dpr={[1, 1.5]}
      shadows={false}
      style={{ background: '#030308' }}
      gl={{ antialias: true }}
    >
      <CityLights />
      <CityStarfield />
      <CityCelestial />
      <CityGround />
      <CityRoads positions={positions} />
      <BuildingCluster
        apps={apps}
        agentMap={agentMap}
        onBuildingClick={onBuildingClick}
        onPositionsReady={handlePositionsReady}
      />
      <CityDataStreams positions={positions} />
      <CityTraffic positions={positions} />
      <CityParticles />
      <OrbitControls
        maxPolarAngle={Math.PI / 2.2}
        minDistance={5}
        maxDistance={60}
        enableDamping
        dampingFactor={0.05}
      />
    </Canvas>
  );
}
