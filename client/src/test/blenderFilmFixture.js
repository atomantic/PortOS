// Invented Blender film state for the Music Video suites: the shape the server
// answers for a project's Blender film, small enough to read in one screen.

export const BLENDER_PROJECT_ID = 'mv-test';

const render = (file, extra = {}) => ({
  poster: file.replace('shot.mp4', 'poster.jpg'), staleReasons: [], width: 1920, height: 1080, fps: 24,
  file, frames: 108, complete: true, stale: false, finishedAt: '2026-10-01T10:05:00.000Z', durationMs: 42000, ...extra,
});

export const blenderShot = (id, start, end, extra = {}) => ({
  id, label: `Shot ${id}`, start, end, set: 'stage', summary: '', action: '', staging: '', camera: '', transition: 'Cut',
  frames: Math.round((end - start) * 24), sceneId: `scene-${id}`, ...extra,
});

/**
 * Three shots across twelve seconds: s010 has a preview and a final (plus a
 * still and a saved .blend), s020 has a preview that went stale when the
 * scripts changed, s030 has nothing. `overrides` replaces top-level keys.
 */
export function blenderFilmState(overrides = {}) {
  return {
    settings: {
      engine: 'BLENDER_EEVEE_NEXT', width: 1920, height: 1080, fps: 24, previewScale: 0.5,
      previewSamples: 16, finalSamples: 64, concurrency: 2, saveBlend: false, options: {},
    },
    tool: { ready: true, reason: '', executionMode: 'trusted-local', engine: 'BLENDER_EEVEE_NEXT', version: '5.2.3' },
    workspace: { exists: true, dir: `data/music-video/${BLENDER_PROJECT_ID}/blender`, path: `/srv/portos/data/music-video/${BLENDER_PROJECT_ID}/blender`, hasFilm: true, files: 3 },
    manifest: {
      title: 'Example Film',
      syncedAt: '2026-10-01T10:00:00.000Z',
      fps: 24,
      options: [],
      srcChanged: false,
      problems: [],
      shots: [
        blenderShot('s010', 0, 4.5, { label: 'Cold open', summary: 'The stage wakes up.', action: 'Lights rise on the empty stage.', camera: 'Slow push in.' }),
        blenderShot('s020', 4.5, 9, { label: 'First verse' }),
        blenderShot('s030', 9, 12, { label: 'Chorus' }),
      ],
    },
    renders: {
      s010: {
        preview: render('s010/preview/shot.mp4'),
        final: render('s010/final/shot.mp4', { finishedAt: '2026-10-01T10:20:00.000Z' }),
        stills: [{ file: 's010/stills/t000002250.png', timeSec: 2.25, createdAt: '2026-10-01T10:10:00.000Z', stale: false }],
        blend: 's010/shot.blend',
      },
      s020: { preview: render('s020/preview/shot.mp4', { stale: true, staleReasons: ['source'] }), stills: [] },
    },
    finalStale: null,
    cuts: [],
    jobs: [],
    notes: { s010: { text: 'Hold the last frame.', status: 'review', updatedAt: '2026-10-01T10:30:00.000Z' } },
    ...overrides,
  };
}

/** A project record in the Blender film render style, with a twelve-second analyzed song. */
export const blenderFilmProject = (overrides = {}) => ({
  id: BLENDER_PROJECT_ID,
  name: 'Example Song',
  uploadedAudioFilename: 'example-song.wav',
  audioAnalysis: {
    durationSec: 12,
    sections: [{ label: 'Intro', startSec: 0, endSec: 4.5, energy: 0.3 }, { label: 'Verse', startSec: 4.5, endSec: 12, energy: 0.6 }],
  },
  composition: { version: 1, mode: 'blender', textCues: [], style: { color: '#ffffff', font: 'sans' }, posterSec: null },
  scenes: [],
  ...overrides,
});
