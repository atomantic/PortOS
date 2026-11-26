import { Quaternion } from 'three';
import { expect, it, vi } from 'vitest';
import { sceneFixture } from '../../test/threeFixture.jsx';
import { Billboard, Edges, Grid } from './primitives.jsx';

it('rebuilds and releases an editable mesh outline, draws the grid and faces labels toward the camera', async () => {
  const content = width => <>
    <mesh name="part"><boxGeometry args={[width, 1, 1]} /><Edges color="white" threshold={20} userData={{ helper: true }} /></mesh>
    <Grid args={[200,200]} cellSize={1} sectionSize={5} cellColor="red" sectionColor="blue" infiniteGrid fadeDistance={80} />
    <group rotation={[0,1,0]}><Billboard><group name="label" /></Billboard></group>
  </>;
  const fixture = await sceneFixture(content(1));
  const scene = fixture.state().scene;
  const line = scene.getObjectByName('part').children[0];
  expect(line.geometry.attributes.position.count).toBe(24);
  expect(line.userData.helper).toBe(true);
  const dispose = vi.spyOn(line.geometry, 'dispose');
  await fixture.render(content(2));
  expect(dispose).toHaveBeenCalledOnce();
  fixture.camera.rotation.set(.4, .2, .3);
  fixture.frame(1);
  expect(scene.getObjectByName('label').getWorldQuaternion(new Quaternion()).angleTo(fixture.camera.quaternion)).toBeCloseTo(0);
  expect(scene.children[1].material.uniforms.sectionSize.value).toBe(5);
  const finalDispose = vi.spyOn(line.geometry, 'dispose');
  await fixture.unmount();
  expect(finalDispose).toHaveBeenCalled();
});
