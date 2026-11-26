import { Box3, BoxGeometry, Mesh, Vector3 } from 'three';
import { expect, it } from 'vitest';
import { sceneFixture } from '../../test/threeFixture.jsx';
import { Bounds, useBounds } from './bounds.jsx';
import { OrbitControls } from './controls.jsx';

it('frames an explicit box or object with the selected margin and clip range', async () => {
  let bounds;
  function Probe() { bounds = useBounds(); return null; }
  const fixture = await sceneFixture(<><OrbitControls makeDefault /><Bounds margin={1.5}><Probe /></Bounds></>);
  const mesh = new Mesh(new BoxGeometry(3, 4, 5));
  mesh.position.set(2, 3, -1);
  const box = new Box3().setFromObject(mesh);
  let time = 0;
  for (const source of [box, mesh]) {
    expect(bounds.refresh(source).clip().fit()).toBe(bounds);
    for (let i = 0; i < 14; i++) fixture.frame(time += .1);
    const center = box.getCenter(new Vector3());
    const distance = 1.5 * 5 / (2 * Math.atan(fixture.camera.fov * Math.PI / 360));
    expect(fixture.camera.near).toBeCloseTo(distance / 100);
    expect(fixture.camera.far).toBeCloseTo(distance * 100);
    expect(fixture.camera.position.distanceTo(center)).toBeCloseTo(distance);
    expect(fixture.state().controls.target.distanceTo(center)).toBeCloseTo(0);
  }
  await fixture.unmount();
});
