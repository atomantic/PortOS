import { act, renderHook } from '@testing-library/react';
import { AnimationClip, Group, NumberKeyframeTrack } from 'three';
import { expect, it, vi } from 'vitest';
import { useLoader, useFrame } from '@react-three/fiber';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { useAnimations, useGLTF } from './gltf.js';

vi.mock('@react-three/fiber', () => ({
  useLoader: Object.assign(vi.fn(), { preload: vi.fn(), clear: vi.fn() }), useFrame: vi.fn(),
}));
it('shares loader, cache key and local decoders between preload, mount and retry', () => {
  const url = '/example.glb';
  useGLTF.preload(url);
  renderHook(() => useGLTF(url));
  const args = useLoader.mock.lastCall;
  expect(args.slice(0,2)).toEqual([GLTFLoader, url]);
  expect(useLoader.preload).toHaveBeenCalledWith(...args);
  const loader = new GLTFLoader();
  args[2](loader);
  expect(loader.meshoptDecoder.decodeGltfBufferAsync).toBeTypeOf('function');
  expect(loader.dracoLoader.decoderPaths.wasm).toContain('draco_decoder.wasm');
  expect(loader.dracoLoader.decoderPaths.wasm).not.toMatch(/gstatic|jsdelivr/);
  useGLTF.clear(url);
  expect(useLoader.clear).toHaveBeenCalledWith(GLTFLoader, url);
});
it('plays named clips against their own root and releases mixer bindings', () => {
  const root = new Group();
  const clips = [new AnimationClip('walk', 1, [new NumberKeyframeTrack('.position[x]', [0,1], [0,2])])];
  const { result, unmount } = renderHook(() => useAnimations(clips, root));
  const { names, actions, mixer } = result.current;
  expect(names).toEqual(['walk']);
  actions.walk.play();
  act(() => useFrame.mock.lastCall[0]({}, 0.5));
  expect(root.position.x).toBeCloseTo(1);
  unmount();
  expect(mixer.existingAction(clips[0], root)).toBe(null);
  expect(root.position.x).toBe(0);
});
