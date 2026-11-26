import { expect, it } from 'vitest';
import { sceneFixture } from '../../test/threeFixture.jsx';
import { Html } from './htmlOverlay.jsx';

it('projects nested scene positions into the supplied DOM portal and culls behind the camera', async () => {
  const portal = { current: document.createElement('div') };
  const fixture = await sceneFixture(<group position={[1,0,0]}><Html portal={portal} position={[-1,0,0]} center>Title</Html></group>);
  fixture.frame(1);
  const label = portal.current.firstElementChild;
  expect(label.textContent).toBe('Title');
  expect(label.style.transform).toContain('translate3d(200px,100px,0) translate(-50%, -50%)');
  fixture.camera.position.z = -1;
  fixture.frame(2);
  expect(label.style.display).toBe('none');
  await fixture.unmount();
  expect(portal.current.childElementCount).toBe(0);
});
