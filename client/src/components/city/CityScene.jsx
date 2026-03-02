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
import PlayerController from './PlayerController';
import CameraTransition from './CameraTransition';

export default function CityScene({ apps, agentMap, onBuildingClick, cosStatus, productivityData, settings, playSfx, keysRef }) {
  const [positions, setPositions] = useState(null);
  const [proximityApp, setProximityApp] = useState(null);
  const [transitioning, setTransitioning] = useState(false);

  const explorationMode = settings?.explorationMode || false;

  const handlePositionsReady = useCallback((pos) => {
    setPositions(pos);
  }, []);

  const handleBuildingProximity = useCallback((app) => {
    setProximityApp(app);
  }, []);

  const handleTransitionComplete = useCallback(() => {
    setTransitioning(false);
  }, []);

  const stoppedCount = apps.filter(a => !a.archived && a.overallStatus !== 'online').length;
  const totalCount = apps.filter(a => !a.archived).length;

  const dpr = settings?.dpr || [1, 1.5];

  return (
    <Canvas
      camera={{ position: [0, 25, 45], fov: 50 }}
      dpr={dpr}
      shadows={false}
      style={{ background: '#030308', cursor: explorationMode ? 'crosshair' : 'auto' }}
      gl={{ antialias: true }}
    >
      <CitySky settings={settings} />
      <CityLights settings={settings} />
      <CityStarfield settings={settings} />
      <CityShootingStars playSfx={playSfx} settings={settings} />
      <CityCelestial settings={settings} />
      <CitySkyline />
      <CityGround settings={settings} />

      <BuildingCluster
        apps={apps}
        agentMap={agentMap}
        onBuildingClick={onBuildingClick}
        onPositionsReady={handlePositionsReady}
        playSfx={playSfx}
        settings={settings}
        proximityAppId={proximityApp?.id}
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
      {explorationMode && (
        <PlayerController
          keysRef={keysRef}
          positions={positions}
          onBuildingProximity={handleBuildingProximity}
          onBuildingClick={onBuildingClick}
          apps={apps}
          active={explorationMode}
        />
      )}
      {!explorationMode && !transitioning && (
        <OrbitControls
          maxPolarAngle={Math.PI / 2.2}
          minDistance={5}
          maxDistance={120}
          enableDamping
          dampingFactor={0.05}
        />
      )}
      <CameraTransition
        active={explorationMode}
        onTransitionComplete={handleTransitionComplete}
      />
    </Canvas>
  );
}
