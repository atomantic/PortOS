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
import CityWeather from './CityWeather';
import CityBillboards from './CityBillboards';
import CityShootingStars from './CityShootingStars';

export default function CityScene({ apps, agentMap, onBuildingClick, cosStatus, productivityData }) {
  const [positions, setPositions] = useState(null);

  const handlePositionsReady = useCallback((pos) => {
    setPositions(pos);
  }, []);

  const stoppedCount = apps.filter(a => !a.archived && a.overallStatus !== 'online').length;
  const totalCount = apps.filter(a => !a.archived).length;

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
      <CityShootingStars />
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
      <CityBillboards
        positions={positions}
        apps={apps}
        cosStatus={cosStatus}
        productivityData={productivityData}
      />
      <CityWeather stoppedCount={stoppedCount} totalCount={totalCount} />
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
