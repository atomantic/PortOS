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
import CityVolumetricLights from './CityVolumetricLights';
import CitySkyline from './CitySkyline';
import CityDataRain from './CityDataRain';
import CityNeonSigns from './CityNeonSigns';
import CityEmbers from './CityEmbers';
import CityEffects from './CityEffects';
import CitySky from './CitySky';

export default function CityScene({ apps, agentMap, onBuildingClick, cosStatus, productivityData, settings, playSfx }) {
  const [positions, setPositions] = useState(null);

  const handlePositionsReady = useCallback((pos) => {
    setPositions(pos);
  }, []);

  const stoppedCount = apps.filter(a => !a.archived && a.overallStatus !== 'online').length;
  const totalCount = apps.filter(a => !a.archived).length;

  const dpr = settings?.dpr || [1, 1.5];

  return (
    <Canvas
      camera={{ position: [0, 25, 45], fov: 50 }}
      dpr={dpr}
      shadows={false}
      style={{ background: '#030308' }}
      gl={{ antialias: true }}
    >
      <CitySky settings={settings} />
      <CityLights settings={settings} />
      <CityStarfield />
      <CityShootingStars playSfx={playSfx} />
      <CityCelestial />
      <CitySkyline />
      <CityGround settings={settings} />
      <CityRoads positions={positions} />
      <BuildingCluster
        apps={apps}
        agentMap={agentMap}
        onBuildingClick={onBuildingClick}
        onPositionsReady={handlePositionsReady}
        playSfx={playSfx}
        settings={settings}
      />
      <CityDataStreams positions={positions} />
      <CityTraffic positions={positions} />
      <CityBillboards
        positions={positions}
        apps={apps}
        cosStatus={cosStatus}
        productivityData={productivityData}
      />
      <CityVolumetricLights positions={positions} />
      <CityNeonSigns positions={positions} />
      <CityWeather stoppedCount={stoppedCount} totalCount={totalCount} playSfx={playSfx} />
      <CityDataRain />
      <CityEmbers />
      <CityParticles settings={settings} />
      <CityEffects settings={settings} />
      <OrbitControls
        maxPolarAngle={Math.PI / 2.2}
        minDistance={5}
        maxDistance={120}
        enableDamping
        dampingFactor={0.05}
      />
    </Canvas>
  );
}
