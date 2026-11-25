import { describe, expect, it, vi } from 'vitest';

const code = vi.hoisted(() => ({ encode: vi.fn(async () => {}) }));
vi.mock('./codeRender.js', async (load) => ({
  ...await load(),
  prepareCodeRender: vi.fn((_project, window = {}) => ({
    html: '<html></html>', song: { sections: [{ id: 'verse', startSec: 0, endSec: 8 }] },
    width: 1280, height: 720, fps: 30, durationSec: window.windowEnd != null ? window.windowEnd - window.windowStart : 8, sectionTimes: [0],
  })),
  encodeCodeComposition: code.encode,
}));

const { SEEKED_RENDERERS, seekedRendererFor } = await import('./seekedRenderers.js');
const { documentRenderInitScripts } = await import('./documentRender.js');
const { renderSeekedWindow } = await import('./excerptRender.js');

// A neutral look and no title card would make an empty list match trivially, so grade it and title it.
const graded = {
  id: 'mv-example', composition: { mode: 'code' }, scenes: [],
  filmLook: { preset: 'super8', grain: 0.6, halation: 0.4 },
  titleCard: { enabled: true, title: 'Example Song', artist: 'Example Artist', startSec: 0, endSec: 4, fadeSec: 0.5, position: 'lower-left', font: 'display', size: 100, color: '#f3ead7' },
};
const base = { prepared: null, project: graded, projectId: 'mv-example', jobId: 'job-1', audioPath: '/audio.wav', outputPath: '/out.mp4' };

describe('seeked renderer registry', () => {
  it('draws the film look and title card in a code excerpt exactly as in the code final', async () => {
    const renderer = SEEKED_RENDERERS.code;
    const prepared = await renderer.prepare(graded);
    code.encode.mockClear();
    await renderer.encode({ ...base, prepared });
    await renderer.encode({ ...base, prepared, window: { startSec: 2, endSec: 6 } });
    const [final, excerpt] = code.encode.mock.calls.map(([input]) => input);
    expect(final.initScripts.length).toBeGreaterThan(0);
    expect(final.initScripts).toEqual(documentRenderInitScripts(graded));
    expect(excerpt.initScripts).toEqual(final.initScripts);
    expect(excerpt.audioStartSec).toBe(2);
    expect(final.audioStartSec).toBe(0);
  });

  it('resolves a renderer per mode and none for footage', () => {
    for (const mode of ['blender', 'eidoverse', 'code', 'document']) {
      expect(seekedRendererFor({ composition: { mode } })).toBe(SEEKED_RENDERERS[mode]);
      expect(SEEKED_RENDERERS[mode].modelId).toMatch(/^music-video-/);
    }
    expect(seekedRendererFor({ composition: { mode: 'footage' } })).toBeNull();
  });

  it('declines a social cut for a fixed-frame Blender film and for footage', async () => {
    const window = { startSec: 0, endSec: 4, aspect: '9:16', outputPath: '/out.mp4' };
    expect(SEEKED_RENDERERS.blender.fixedFrame).toBe(true);
    expect(await renderSeekedWindow({ id: 'mv-b', composition: { mode: 'blender' } }, window)).toBeNull();
    expect(await renderSeekedWindow({ id: 'mv-f', composition: { mode: 'footage' } }, window)).toBeNull();
  });
});
