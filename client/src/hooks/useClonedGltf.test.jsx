import { renderHook } from '@testing-library/react';
import {
  Bone,
  BufferGeometry,
  Group,
  MeshBasicMaterial,
  Skeleton,
  SkinnedMesh,
} from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import useClonedGltf, { GltfPrimitive } from './useClonedGltf.jsx';

const mocks = vi.hoisted(() => ({
  useAnimations: vi.fn(),
  useGLTF: vi.fn(),
}));

vi.mock('@react-three/drei', () => ({
  useAnimations: mocks.useAnimations,
  useGLTF: mocks.useGLTF,
}));

// A minimal rigged GLTF scene: Group > SkinnedMesh > Bone("Root") > Bone("Spine").
// SkeletonUtils.clone is the only thing that rebinds a clone's skeleton to the
// CLONED bones; a plain Object3D.clone leaves the copy driven by the cached
// original's skeleton, which is the "second mount renders blank" failure the
// hook exists to avoid.
const buildRiggedScene = () => {
  const root = new Group();
  root.name = 'source';
  const rootBone = new Bone();
  rootBone.name = 'Root';
  const spineBone = new Bone();
  spineBone.name = 'Spine';
  rootBone.add(spineBone);
  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial());
  mesh.name = 'Body';
  mesh.add(rootBone);
  mesh.bind(new Skeleton([rootBone, spineBone]));
  root.add(mesh);
  return root;
};

const findSkinnedMesh = (scene) => {
  let found = null;
  scene.traverse((node) => {
    if (node.isSkinnedMesh) found = node;
  });
  return found;
};

describe('useClonedGltf', () => {
  beforeEach(() => {
    mocks.useAnimations.mockReset();
    mocks.useGLTF.mockReset();
  });

  it('clones the cached scene and binds transformed animations to the clone', () => {
    const sourceScene = buildRiggedScene();
    const sourceAnimations = [{ name: 'Walk' }];
    const transformedAnimations = [{ name: 'Walk-in-place' }];
    const transformAnimations = vi.fn(() => transformedAnimations);
    const animationState = {
      actions: { 'Walk-in-place': {} },
      mixer: {},
      names: ['Walk-in-place'],
    };
    mocks.useGLTF.mockReturnValue({ scene: sourceScene, animations: sourceAnimations });
    mocks.useAnimations.mockReturnValue(animationState);

    const { result, rerender } = renderHook(() => (
      useClonedGltf('/example.glb', transformAnimations)
    ));

    const { scene } = result.current;
    // A real clone, not the drei-cached scene handed straight back.
    expect(scene).not.toBe(sourceScene);
    expect(scene.name).toBe('source');

    // The rig survived, and every bone the clone is skinned to belongs to the
    // clone's own hierarchy — never the source's.
    const sourceMesh = findSkinnedMesh(sourceScene);
    const clonedMesh = findSkinnedMesh(scene);
    expect(clonedMesh).not.toBe(sourceMesh);
    expect(clonedMesh.skeleton).not.toBe(sourceMesh.skeleton);
    expect(clonedMesh.skeleton.bones.map((bone) => bone.name)).toEqual(['Root', 'Spine']);
    for (const bone of clonedMesh.skeleton.bones) {
      expect(sourceMesh.skeleton.bones).not.toContain(bone);
      expect(scene.getObjectById(bone.id)).toBe(bone);
    }

    expect(transformAnimations).toHaveBeenCalledWith(sourceAnimations);
    expect(mocks.useAnimations).toHaveBeenCalledWith(transformedAnimations, scene);
    expect(result.current).toEqual({
      scene,
      animations: transformedAnimations,
      ...animationState,
    });

    // Memoized on the cached scene: a rerender must not re-clone, or every
    // render would rebuild the rig and drop the running animation actions.
    rerender();
    expect(result.current.scene).toBe(scene);
    expect(transformAnimations).toHaveBeenCalledTimes(1);
  });

  it('renders shared GLTF resources with disposal disabled', () => {
    const object = {};
    const element = GltfPrimitive({ object, dispose: true, name: 'avatar' });

    expect(element.props).toMatchObject({
      object,
      dispose: null,
      name: 'avatar',
    });
  });
});
