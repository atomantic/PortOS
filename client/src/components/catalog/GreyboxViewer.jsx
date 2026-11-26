import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useGLTF } from '../../lib/threeHelpers/gltf.js';
import useClonedGltf, { GltfPrimitive } from '../../hooks/useClonedGltf';
import GreyboxSceneViewer from './GreyboxSceneViewer.jsx';

// Preserve Blender's meter scale and origin: fitting/centering would move saved
// cameras and anchors. Only the cloned scene's material references are replaced.
export function GreyboxModel({ src, onReady }) {
  const { scene } = useClonedGltf(src);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8a8f98', roughness: 1, metalness: 0, side: THREE.DoubleSide }), []);
  useEffect(() => {
    scene.traverse((object) => { if (object.isMesh) object.material = material; });
    onReady(src);
    return () => { onReady(null); material.dispose(); };
  }, [scene, material, src, onReady]);
  return <GltfPrimitive object={scene} />;
}

// The interactive viewer can load and retry a model. The standalone capture
// bundle imports the same scene directly and only renders primitive layouts.
export default function GreyboxViewer(props) {
  return <GreyboxSceneViewer {...props} Model={GreyboxModel} clearModel={useGLTF.clear} />;
}
