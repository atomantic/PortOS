import { useEffect } from 'react';
import { useThree, useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { cityDayMix } from './cityConstants';

const GALAXY_TEXTURE_URL = '/sky/city-night-galaxy-8k.jpg';
// Artistic yaw so the brightest stretch of the Milky Way band sits behind the city
// rather than dead-ahead. Applied to both the visible background and the IBL probe so
// reflections line up with what's on screen.
const GALAXY_ROTATION = new THREE.Euler(0, -Math.PI * 0.18, 0);

// Brightness knobs (multiplied by how deep into night we are). The panorama is a real,
// dark Milky Way, so the background gets a >1 lift to read clearly against the night sky;
// the IBL multiplier controls how strongly the galaxy tints the metallic facades.
const BACKGROUND_INTENSITY = 2.4;
const ENVIRONMENT_INTENSITY = 1.3;

// The night sky is the equirectangular galaxy panorama wired through three.js's
// environment system the way an HDRI is: the texture is mapped equirectangular, run
// through a PMREMGenerator, and assigned to BOTH scene.background (the 360° spheremap
// backdrop, visible in every camera direction) AND scene.environment (image-based
// lighting, so the galaxy tints reflections/lighting on the PBR building + ground
// materials). drei's <Environment files> can't load a .png panorama (its loader only
// recognises .hdr/.exr/cube), so we do the PMREM wiring directly — the canonical setup.
//
// Mounted only at night (CityScene gates on !showGradientBackground), so the 2.8MB
// panorama isn't fetched/decoded or PMREM-processed in daylight.
export default function CityGalaxySky({ settings }) {
  const { gl, scene } = useThree();
  const texture = useLoader(THREE.TextureLoader, GALAXY_TEXTURE_URL);
  const nightOpacity = Math.max(0, Math.min(1, 1 - cityDayMix(settings)));

  // Build the PMREM environment once per texture and bind it to the scene; restore the
  // previous background/environment (and free the GPU targets) when night ends / unmounts.
  useEffect(() => {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;

    const pmrem = new THREE.PMREMGenerator(gl);
    const envTarget = pmrem.fromEquirectangular(texture);

    const prevBackground = scene.background;
    const prevEnvironment = scene.environment;
    scene.background = texture;
    scene.environment = envTarget.texture;
    scene.backgroundRotation.copy(GALAXY_ROTATION);
    scene.environmentRotation.copy(GALAXY_ROTATION);

    return () => {
      scene.background = prevBackground;
      scene.environment = prevEnvironment;
      // Reset the intensities to three's defaults so the daytime color background (set by
      // CityScene once this unmounts) isn't left dimmed by the last night value.
      scene.backgroundIntensity = 1;
      scene.environmentIntensity = 1;
      envTarget.dispose();
      pmrem.dispose();
    };
  }, [gl, scene, texture]);

  // Cross-fade with daylight without rebuilding the PMREM map: scale the background and
  // the IBL by how deep into night we are. The panorama is mostly dark space, so the IBL
  // gets a >1 multiplier to read as a light source on metallic facades.
  useEffect(() => {
    scene.backgroundIntensity = nightOpacity * BACKGROUND_INTENSITY;
    scene.environmentIntensity = nightOpacity * ENVIRONMENT_INTENSITY;
  }, [scene, nightOpacity]);

  return null;
}
