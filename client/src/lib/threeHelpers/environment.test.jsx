import { render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { Environment } from './environment.jsx';

const { scene, source, target, gl, generatorDispose } = vi.hoisted(() => ({
  scene: { environment: 'prior light', background: 'prior sky', environmentIntensity: 1, backgroundBlurriness: 0 },
  source: {}, target: { texture: {}, dispose: vi.fn() }, gl: {}, generatorDispose: vi.fn(),
}));
vi.mock('@react-three/fiber', () => ({ useLoader: () => source, useThree: select => select({ scene, gl }) }));
vi.mock('three', async importOriginal => ({
  ...await importOriginal(), PMREMGenerator: vi.fn(function () {
    return { fromEquirectangular: () => target, dispose: generatorDispose };
  }),
}));
it('retains the active exposure across background changes and frees only its PMREM target on unmount', () => {
  const props = { files: '/example.hdr', backgroundBlurriness: .2 };
  const view = render(<Environment {...props} background environmentIntensity={.6} />);
  expect(scene.environment).toBe(target.texture);
  expect(scene.background).toBe(source);
  expect(scene.backgroundBlurriness).toBe(.2);
  view.rerender(<Environment {...props} background={false} environmentIntensity={0} />);
  expect(scene.background).toBe('prior sky');
  expect(scene.environmentIntensity).toBe(0);
  view.rerender(<Environment {...props} background environmentIntensity={0} />);
  expect(scene.environmentIntensity).toBe(0);
  expect(target.dispose).not.toHaveBeenCalled();
  view.unmount();
  expect(scene).toMatchObject({ environment: 'prior light', background: 'prior sky', environmentIntensity: 1, backgroundBlurriness: 0 });
  expect(target.dispose).toHaveBeenCalledOnce();
  expect(generatorDispose).toHaveBeenCalledOnce();
});
