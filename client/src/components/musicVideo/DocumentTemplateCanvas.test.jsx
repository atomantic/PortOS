import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createRef } from 'react';

// Pixels are the browser parity suite's; this pins which images load before their cut.
vi.mock('./documentTemplateDrawing.js', () => ({
  createDocumentTemplateDrawing: () => ({ state: (t) => ({ t }), scene: () => null, finish: () => {}, hud: () => {} }),
}));

import DocumentTemplateCanvas from './DocumentTemplateCanvas.jsx';

afterEach(() => { vi.restoreAllMocks(); delete document.fonts; });

describe('DocumentTemplateCanvas', () => {
  // Uniquely catches a shot's still first fetched at its cut, which a slow phone link shows as black.
  it('loads the next shots\' stills while the shot before them plays', () => {
    const noop = new Proxy({}, { get: (_, key) => (key === 'createImageData' ? () => ({}) : () => {}) });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(noop);
    // happy-dom has no FontFaceSet.
    Object.defineProperty(document, 'fonts', { value: { load: () => Promise.resolve([]) }, configurable: true });
    const requested = [];
    vi.spyOn(window.HTMLImageElement.prototype, 'src', 'set').mockImplementation((url) => { requested.push(url); });
    const scenes = Array.from({ length: 5 }, (_, i) => ({
      sceneId: `s${i}`, startSec: i * 2, endSec: (i + 1) * 2, visualLayer: 'still', referenceImageId: `still-${i}.png`,
      ...(i === 2 ? { endImageId: 'end-2.png' } : {}),
    }));
    const audio = document.createElement('audio');
    const audioRef = { current: audio };
    const figureRef = createRef();
    render(
      <figure ref={figureRef}>
        <DocumentTemplateCanvas project={{ id: 'p', scenes }} figureRef={figureRef} audioRef={audioRef} time={0}
          data={{ render: { width: 64, height: 36, fps: 24 }, scenes, song: { durationSec: 10 } }} />
      </figure>,
    );
    expect(requested).toEqual(expect.arrayContaining(['/data/images/still-1.png', '/data/images/still-2.png', '/data/images/end-2.png']));
    expect(requested).not.toContain('/data/images/still-3.png');
  });
});
