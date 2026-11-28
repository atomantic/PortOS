import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';

// Under frameloop='demand', state/speaking changes that only affect
// useFrame-driven properties need to invalidate the frame so one renders.
export default function CoSInvalidateOnStateChange({ state, speaking }) {
  const { invalidate } = useThree();
  useEffect(() => {
    invalidate();
  }, [state, speaking, invalidate]);
  return null;
}
