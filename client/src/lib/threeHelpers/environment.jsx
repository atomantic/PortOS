// Prefilters a bundled HDR panorama for image-based lighting and independently controls its background and intensity.
import { useLayoutEffect } from 'react';
import { useLoader, useThree } from '@react-three/fiber';
import { EquirectangularReflectionMapping, PMREMGenerator } from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

export function Environment({ files, background, backgroundBlurriness, environmentIntensity }) {
  const texture = useLoader(HDRLoader, files);
  const gl = useThree(state => state.gl);
  const scene = useThree(state => state.scene);
  useLayoutEffect(() => {
    texture.mapping = EquirectangularReflectionMapping;
    const generator = new PMREMGenerator(gl);
    const previous = scene.environment;
    let target;
    try {
      target = generator.fromEquirectangular(texture);
      scene.environment = target.texture;
    } finally {
      generator.dispose();
    }
    return () => {
      scene.environment = previous;
      target.dispose();
    };
  }, [gl, scene, texture]);
  useLayoutEffect(() => {
    const previous = scene.environmentIntensity;
    scene.environmentIntensity = environmentIntensity;
    return () => { scene.environmentIntensity = previous; };
  }, [scene, environmentIntensity]);
  useLayoutEffect(() => {
    if (!background) return;
    const previous = scene.background;
    const blur = scene.backgroundBlurriness;
    scene.background = texture;
    scene.backgroundBlurriness = backgroundBlurriness;
    return () => {
      scene.background = previous;
      scene.backgroundBlurriness = blur;
    };
  }, [background, backgroundBlurriness, scene, texture]);
  return null;
}
