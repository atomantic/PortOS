import { useEffect } from 'react';
import { useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { cityDayMix } from './cityConstants';

const GALAXY_TEXTURE = '/sky/city-night-galaxy-sphere.png';

export default function CityGalaxySky({ settings }) {
  const dayMix = cityDayMix(settings);
  const nightOpacity = Math.max(0, Math.min(1, 1 - dayMix));
  const texture = useLoader(THREE.TextureLoader, GALAXY_TEXTURE);

  useEffect(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.mapping = THREE.UVMapping;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
  }, [texture]);

  if (nightOpacity <= 0.01) return null;

  return (
    <mesh renderOrder={-1000} rotation={[0, -Math.PI * 0.18, 0]}>
      {/* Sits just inside the CitySky dome (1600) and beyond the mountain ring
          (~1210) so the galaxy reads as the night backdrop behind the horizon. */}
      <sphereGeometry args={[1500, 64, 32]} />
      <meshBasicMaterial
        map={texture}
        color="#9bbcff"
        side={THREE.BackSide}
        transparent={nightOpacity < 0.99}
        opacity={nightOpacity}
        depthTest
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}
