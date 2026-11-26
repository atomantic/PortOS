import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { glitchFrameParams } from '../../../../server/lib/musicVideo/musicVideoTransitions.js';

const painted = vi.fn();
vi.mock('../../../../server/lib/musicVideo/musicVideoGlitchCanvas.js', () => ({ createMusicVideoGlitchPainter: () => (...args) => painted(...args) }));
const { default: EffectThumb } = await import('./EffectThumb.jsx');

afterEach(() => vi.restoreAllMocks());

describe('EffectThumb', () => {
  // Uniquely catches a tile painting a different effect than its style, or a frame the render never shows.
  it('paints its style\'s strongest frame with the render\'s painter, over a stand-in picture without a shot', () => {
    const ctx = { fillRect: vi.fn(), drawImage: vi.fn(), createLinearGradient: () => ({ addColorStop() {} }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    painted.mockClear();
    render(<EffectThumb style="vhs-glitch" />);
    expect(ctx.fillRect).toHaveBeenCalled();
    expect(painted).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), glitchFrameParams({ style: 'vhs-glitch', index: 1 }), 1);
  });
});
