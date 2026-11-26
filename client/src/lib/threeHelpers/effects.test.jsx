import { expect, it } from 'vitest';
import { sceneFixture } from '../../test/threeFixture.jsx';
import { Float, MeshDistortMaterial, Sparkles, Stars } from './effects.jsx';

it('advances floating avatars, displacement and both point fields with the scene clock', async () => {
  const fixture = await sceneFixture(<>
    <Float speed={1} floatIntensity={1} rotationIntensity={1}><mesh><MeshDistortMaterial speed={2} distort={.3} /></mesh></Float>
    <Sparkles count={12} scale={3} size={2} speed={2} color="red" />
    <Stars count={20} speed={1} radius={100} depth={50} factor={4} saturation={0} fade />
  </>);
  const [group, sparkles, stars] = fixture.state().scene.children;
  const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>' };
  group.children[0].material.onBeforeCompile(shader);
  fixture.frame(1);
  const start = group.position.y;
  fixture.frame(2);
  expect(group.position.y).not.toBe(start);
  expect(shader.vertexShader).toContain('displacement(position');
  expect(shader.uniforms.distortion.value).toBe(.3);
  expect(shader.uniforms.phase.value).toBeCloseTo(.4);
  expect(sparkles.geometry.attributes.position.count).toBe(12);
  expect(sparkles.material.uniforms.time.value).toBe(4);
  for (const attr of ['position', 'size', 'color']) expect(stars.geometry.attributes[attr].count).toBe(20);
  expect(stars.material.uniforms.time.value).toBe(2);
  await fixture.unmount();
});
