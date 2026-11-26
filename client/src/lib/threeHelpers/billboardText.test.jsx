import { createRef } from 'react';
import { act } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { sceneFixture } from '../../test/threeFixture.jsx';
import { BillboardText } from './billboardText.jsx';

it('wraps and outlines the local-font label, exposes its fade material and frees old textures', async () => {
  const ctx = { measureText: line => ({ width: line.length * 32 }), strokeText: vi.fn(), fillText: vi.fn() };
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
  let loaded;
  const font = vi.fn(() => new Promise(resolve => { loaded = resolve; }));
  Object.defineProperty(document, 'fonts', { configurable: true, value: { load: font } });
  const ref = createRef();
  try {
    const fixture = await sceneFixture(<BillboardText ref={ref} color="white" outlineColor="black" outlineWidth={.1}
      fontSize={1} maxWidth={3} fontFamily="GeistPixelSquare" raycast={() => null}>first second</BillboardText>);
    const texture = ref.current.map;
    const dispose = vi.spyOn(texture, 'dispose');
    await act(async () => loaded([]));
    expect(font).toHaveBeenCalledWith('64px "GeistPixelSquare"');
    expect(ctx.font).toContain('GeistPixelSquare');
    expect(ctx.fillText.mock.calls.map(args => args[0])).toContain('second');
    expect(ctx.strokeText).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(ref.current.transparent).toBe(true);
    const label = fixture.state().scene.children[0];
    expect(label.position.y).toBeCloseTo(label.geometry.parameters.height / 2);
    const finalDispose = vi.spyOn(ref.current.map, 'dispose');
    await fixture.unmount();
    expect(finalDispose).toHaveBeenCalledOnce();
  } finally {
    context.mockRestore();
    delete document.fonts;
  }
});
