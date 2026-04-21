import { useEffect, useState } from 'react';
import { useGLTF } from '@react-three/drei';

const MODEL_URL = '/api/avatar/model.glb';

// Resolve whether a user-supplied rigged avatar is configured.
// HEAD probes the API once; the client only attempts to load the GLB when
// the server signals 200. Missing model is a first-class state, not an error.
export function useAvatarModel() {
  const [status, setStatus] = useState('probing');

  useEffect(() => {
    let cancelled = false;
    fetch(MODEL_URL, { method: 'HEAD' })
      .then((res) => {
        if (cancelled) return;
        setStatus(res.ok ? 'present' : 'missing');
      })
      .catch(() => {
        if (!cancelled) setStatus('missing');
      });
    return () => { cancelled = true; };
  }, []);

  return { status, url: MODEL_URL };
}

// Preload hint for drei's GLTF cache — safe to call speculatively after a
// HEAD 200 so the model starts downloading before the canvas mounts.
export function preloadAvatarModel() {
  useGLTF.preload(MODEL_URL);
}
