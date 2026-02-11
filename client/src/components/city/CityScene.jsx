import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import CityGround from './CityGround';
import CityLights from './CityLights';
import CityParticles from './CityParticles';
import BuildingCluster from './BuildingCluster';

export default function CityScene({ apps, agentMap, onBuildingClick }) {
  return (
    <Canvas
      camera={{ position: [0, 15, 25], fov: 50 }}
      dpr={[1, 1.5]}
      shadows={false}
      style={{ background: '#0a0a0f' }}
      gl={{ antialias: true }}
    >
      <CityLights />
      <CityGround />
      <BuildingCluster
        apps={apps}
        agentMap={agentMap}
        onBuildingClick={onBuildingClick}
      />
      <CityParticles />
      <OrbitControls
        maxPolarAngle={Math.PI / 2.2}
        minDistance={5}
        maxDistance={50}
        enableDamping
        dampingFactor={0.05}
      />
    </Canvas>
  );
}
