import { useEffect, useMemo } from 'react';
import { useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { cityDayMix } from './cityConstants';

const GALAXY_TEXTURE_URL = '/sky/city-night-galaxy-sphere.png';

export default function CityGalaxySky({ settings }) {
  const dayMix = cityDayMix(settings);
  const nightOpacity = Math.max(0, Math.min(1, 1 - dayMix));
  const texture = useLoader(THREE.TextureLoader, GALAXY_TEXTURE_URL);

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

  // One material shared by the sphere backing and the inner horizon wall — both
  // sample the same galaxy map at the same opacity, so there's no reason to
  // allocate two. opacity/transparent track nightOpacity on each render (a
  // settings-rate change, not per-frame).
  const galaxyMaterial = useMemo(() => new THREE.MeshBasicMaterial({
    map: texture,
    color: '#ffffff',
    side: THREE.BackSide,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  }), [texture]);
  useEffect(() => () => galaxyMaterial.dispose(), [galaxyMaterial]);
  galaxyMaterial.opacity = nightOpacity;
  galaxyMaterial.transparent = nightOpacity < 0.99;

  if (nightOpacity <= 0.01) return null;

  return (
    <group rotation={[0, -Math.PI * 0.18, 0]}>
      {/* Distant full-sphere backing for free-look/orbit cameras. */}
      <mesh renderOrder={-1000} material={galaxyMaterial}>
        <sphereGeometry args={[1500, 64, 32]} />
      </mesh>
      {/* The default City camera points down across the horizon, so the
          equirectangular sphere can look like plain darkness. This inner
          horizon wall keeps the custom galaxy band visible behind the city. */}
      <mesh renderOrder={-999} position={[0, 220, 0]} material={galaxyMaterial}>
        <cylinderGeometry args={[1420, 1420, 960, 96, 1, true]} />
      </mesh>
    </group>
  );
}
