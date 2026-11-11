import { describe, expect, it } from 'vitest';
import {
  blenderAgentBrief, blenderBulkPlan, blenderFilmSummary, blenderJobPercent, blenderOptionChanges, blenderOptionFields, blenderRenderBlocker,
  blenderSettingsProblems, blenderShotPlayable, blenderShotRenderBlocker, blenderShotRenderStatus, blenderShotStage, blenderShotThumbPath,
  blenderStaleReason, blenderStillPreviewItems, blenderSyncJob, changedBlenderSettings, mergeBlenderJob, sortBlenderJobs,
} from './musicVideoBlender.js';
import { blenderFilmState } from '../test/blenderFilmFixture.js';

const job = (extra) => ({ id: 'j1', kind: 'render', shotId: 's030', quality: 'preview', status: 'running', startedAt: '2026-10-01T11:00:00.000Z', ...extra });

describe('blenderShotRenderStatus', () => {
  // One row per way a shot's render can stand: a wrong reading here mislabels every chip, button and bulk count.
  it.each([
    ['nothing rendered', {}, 's030', 'preview', { status: 'none', text: 'none', tone: 'muted' }],
    ['a finished, current render', {}, 's010', 'final', { status: 'done', tone: 'success' }],
    ['a finished render whose scripts changed', {}, 's020', 'preview', { status: 'stale', tone: 'warning', detail: 'Out of date: its scripts changed.' }],
    ['a queued job', { jobs: [job({ status: 'queued' })] }, 's030', 'preview', { status: 'queued', text: 'queued' }],
    ['a running job with frames', { jobs: [job({ index: 18, total: 72 })] }, 's030', 'preview', { status: 'rendering', percent: 25, text: 'rendering 25%' }],
    ['a running job before its first frame', { jobs: [job()] }, 's030', 'preview', { status: 'rendering', percent: null, text: 'rendering' }],
    ['a job encoding its frames', { jobs: [job({ status: 'encoding' })] }, 's030', 'preview', { status: 'encoding' }],
    ['a job in flight over a stale render', { jobs: [job({ shotId: 's020', status: 'queued' })] }, 's020', 'preview', { status: 'queued' }],
    ['a failed job with nothing on disk', { jobs: [job({ status: 'error', error: 'film.py raised' })] }, 's030', 'preview', { status: 'failed', tone: 'error', detail: 'film.py raised' }],
    ['a job of the other quality', { jobs: [job({ quality: 'final' })] }, 's030', 'preview', { status: 'none' }],
  ])('reads %s', (_name, overrides, shotId, quality, expected) => {
    expect(blenderShotRenderStatus(blenderFilmState(overrides), shotId, quality)).toMatchObject(expected);
  });

  it('reports how far an interrupted render got instead of calling it done', () => {
    const state = blenderFilmState({ renders: { s030: { final: { file: 's030/final/shot.mp4', frames: 72, complete: false, stale: false, partialFrames: 30 }, stills: [] } } });
    expect(blenderShotRenderStatus(state, 's030', 'final')).toMatchObject({ status: 'partial', detail: '30 of 72 frames rendered.' });
  });
});

describe('blenderStaleReason', () => {
  it('names every cause the server gives, in its order, and stays honest when it gives none', () => {
    expect(blenderStaleReason({ staleReasons: ['settings'] })).toBe('the render settings changed');
    expect(blenderStaleReason({ staleReasons: ['source', 'options'] })).toBe('its scripts changed and a film option changed');
    expect(blenderStaleReason({ staleReasons: ['timing'] })).toBe('the shot moved on the song');
    expect(blenderStaleReason({ stale: true })).toBe('its scripts or settings changed');
  });
});

describe('blenderShotStage and blenderFilmSummary', () => {
  it('summarises each shot for the timeline and reads the Shots step the way the server does', () => {
    const state = blenderFilmState({ jobs: [job({ index: 1, total: 72 })] });
    expect(state.manifest.shots.map((shot) => blenderShotStage(state, shot.id))).toEqual(['final', 'stale', 'rendering']);
    // `total`, `finalReady` and `ready` are the server's `project.blenderShots`.
    expect(blenderFilmSummary(state)).toEqual({ total: 3, finalReady: 1, ready: false, finalStale: 0, finalMissing: 2, previewReady: 1 });
    const staleFinal = blenderFilmState();
    staleFinal.renders.s010.final.stale = true;
    expect(blenderFilmSummary(staleFinal)).toMatchObject({ finalReady: 0, finalStale: 1, finalMissing: 2 });
    expect(blenderFilmSummary(blenderFilmState({ manifest: null }))).toMatchObject({ total: 0, finalReady: 0, ready: false });
    const one = blenderFilmState();
    one.manifest.shots = one.manifest.shots.slice(0, 1);
    expect(blenderFilmSummary(one)).toMatchObject({ total: 1, finalReady: 1, ready: true });
  });
});

describe('blenderShotPlayable', () => {
  it('plays the most recently finished render and honours a picked quality only when it exists', () => {
    const state = blenderFilmState();
    expect(blenderShotPlayable(state, 's010')).toMatchObject({ quality: 'final', qualities: ['preview', 'final'] });
    expect(blenderShotPlayable(state, 's010', 'preview').render.file).toBe('s010/preview/shot.mp4');
    expect(blenderShotPlayable(state, 's020', 'final')).toMatchObject({ quality: 'preview', qualities: ['preview'] });
    expect(blenderShotPlayable(state, 's030')).toBeNull();
    state.renders.s010.preview.finishedAt = '2026-10-01T10:40:00.000Z';
    expect(blenderShotPlayable(state, 's010').quality).toBe('preview');
  });
});

describe('blenderShotThumbPath', () => {
  it('shows the poster the server made with the preview, then the newest still, then the final poster', () => {
    const state = blenderFilmState();
    expect(blenderShotThumbPath(state, state.manifest.shots[1])).toBe('s020/preview/poster.jpg');
    state.renders.s010.preview = undefined;
    // Stills arrive newest first.
    state.renders.s010.stills.unshift({ file: 's010/stills/t000004000.png', thumbnail: 's010/stills/t000004000.thumb.jpg', timeSec: 4, createdAt: '2026-10-01T10:40:00.000Z', stale: false });
    expect(blenderShotThumbPath(state, state.manifest.shots[0])).toBe('s010/stills/t000004000.thumb.jpg');
    delete state.renders.s010.stills[0].thumbnail;
    expect(blenderShotThumbPath(state, state.manifest.shots[0])).toBe('s010/final/poster.jpg');
    state.renders.s010.stills = [];
    expect(blenderShotThumbPath(state, state.manifest.shots[0])).toBe('s010/final/poster.jpg');
    // A render with no picture yet (interrupted before its first frame) has none to show.
    state.renders.s010.final = { file: null, complete: false, stale: false, partialFrames: 0 };
    expect(blenderShotThumbPath(state, state.manifest.shots[0])).toBeNull();
    expect(blenderShotThumbPath(state, state.manifest.shots[2])).toBeNull();
  });
});

describe('blenderBulkPlan', () => {
  it('counts the shots each scope renders by the server\'s own rule, and only forces when everything is asked for', () => {
    const state = blenderFilmState({ jobs: [job({ shotId: 's030', status: 'queued' })] });
    expect(blenderBulkPlan(state, 'preview', 'needed')).toEqual({ body: { quality: 'preview' }, shotIds: ['s020'] });
    expect(blenderBulkPlan(state, 'preview', 'stale')).toEqual({ body: { quality: 'preview', onlyStale: true }, shotIds: ['s020'] });
    // The shot already queued is not counted twice.
    expect(blenderBulkPlan(state, 'preview', 'all')).toEqual({ body: { quality: 'preview', force: true }, shotIds: ['s010', 's020'] });
    // "Missing or out of date" takes a shot that was never rendered; "out of date only" does not.
    expect(blenderBulkPlan(blenderFilmState(), 'final', 'needed').shotIds).toEqual(['s020', 's030']);
    expect(blenderBulkPlan(blenderFilmState(), 'final', 'stale').shotIds).toEqual([]);
    // An interrupted render whose scripts changed since is out of date too: the server re-renders it under either scope.
    const interrupted = blenderFilmState();
    interrupted.renders.s030 = { preview: { file: null, complete: false, stale: true, staleReasons: ['source'], partialFrames: 4 }, stills: [] };
    expect(blenderBulkPlan(interrupted, 'preview', 'stale').shotIds).toEqual(['s020', 's030']);
  });
});

describe('job helpers', () => {
  it('updates a known job in place, queues a new one last, and lists work before history', () => {
    const jobs = mergeBlenderJob([job({ id: 'a', status: 'queued' })], job({ id: 'b', status: 'queued' }));
    expect(jobs.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(mergeBlenderJob(jobs, { id: 'a', status: 'running', index: 3, total: 12 })[0]).toMatchObject({ id: 'a', status: 'running', shotId: 's030' });
    const sorted = sortBlenderJobs([
      job({ id: 'old', status: 'done', finishedAt: '2026-10-01T09:00:00.000Z' }),
      job({ id: 'queued', status: 'queued' }),
      job({ id: 'new', status: 'error', finishedAt: '2026-10-01T10:00:00.000Z' }),
      job({ id: 'running', status: 'running' }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(['running', 'queued', 'new', 'old']);
    expect(blenderJobPercent({ index: 36, total: 72 })).toBe(50);
    expect(blenderJobPercent({ status: 'queued' })).toBeNull();
  });
});

describe('settings form', () => {
  it('names each value the server would refuse', () => {
    expect(blenderSettingsProblems(blenderFilmState().settings)).toEqual({});
    expect(blenderSettingsProblems({ width: 1921, height: 100, fps: 23.976, previewScale: 0.1, concurrency: 5, finalSamples: Number.NaN })).toEqual({
      width: 'Width must be an even number.',
      height: 'Height must be between 180 and 4320.',
      fps: 'Frame rate must be a whole number.',
      previewScale: 'Preview scale must be between 0.25 and 1.',
      concurrency: 'Parallel renders must be between 1 and 4.',
      finalSamples: 'Final samples needs a number.',
    });
  });

  it('sends only what changed', () => {
    const saved = blenderFilmState().settings;
    expect(changedBlenderSettings(saved, { fps: 30, width: 1920, saveBlend: true })).toEqual({ fps: 30, saveBlend: true });
    expect(changedBlenderSettings(saved, {})).toEqual({});
  });

  it('shows each film option at its value in effect and sends only the changed ones, a return to the default as a clear', () => {
    const declared = [
      { key: 'palette', label: 'Palette', type: 'choice', choices: [{ value: 'dusk', label: 'Dusk' }, { value: 'neon', label: 'Neon' }], default: 'dusk' },
      { key: 'glow', label: 'Glow', type: 'number', min: 0, max: 1, default: 0.5 },
      { key: 'debug', label: 'Debug overlay', type: 'boolean', default: false },
    ];
    const saved = { palette: 'neon', gone: 'x' };
    expect(blenderOptionFields(declared, saved).map((field) => [field.key, field.value, field.dirty, field.isDefault]))
      .toEqual([['palette', 'neon', false, false], ['glow', 0.5, false, true], ['debug', false, false, true]]);
    const draft = { palette: 'dusk', glow: 0.8, debug: false };
    expect(blenderOptionChanges(declared, saved, draft)).toEqual({ palette: null, glow: 0.8 });
    // A value the film would refuse is named and never sent.
    expect(blenderOptionFields(declared, saved, { glow: 2 })[1].problem).toBe('Glow must be at most 1.');
    expect(blenderOptionChanges(declared, saved, { glow: 2 })).toEqual({});
    expect(blenderOptionFields(undefined, saved)).toEqual([]);
  });
});

describe('blenderShotRenderBlocker and blenderSyncJob', () => {
  it('holds renders, not syncs, when the frame rate moved off the one the shots were synced at', () => {
    const state = blenderFilmState();
    expect(blenderShotRenderBlocker(state, null)).toBeNull();
    const retimed = { ...state, settings: { ...state.settings, fps: 30 } };
    expect(blenderRenderBlocker(retimed)).toBeNull();
    expect(blenderShotRenderBlocker(retimed, null)).toEqual({ message: expect.stringContaining('frame rate changed from 24 to 30'), tab: 'settings' });
    const unsaved = { message: 'Save or discard the render settings first.', tab: 'settings' };
    expect(blenderShotRenderBlocker(retimed, unsaved)).toBe(unsaved);
  });

  it('reads the sync from the job list: the one at work, else the last that ended', () => {
    const sync = (extra) => ({ id: 'sync', kind: 'sync', status: 'done', ...extra });
    expect(blenderSyncJob(blenderFilmState())).toBeNull();
    expect(blenderSyncJob(blenderFilmState({ jobs: [sync({ id: 'a', status: 'error' }), job(), sync({ id: 'b' })] })).id).toBe('b');
    expect(blenderSyncJob(blenderFilmState({ jobs: [sync({ id: 'a', status: 'running' }), sync({ id: 'b', status: 'canceled' })] })).id).toBe('a');
  });
});

describe('blenderRenderBlocker', () => {
  it('puts Blender setup first, then anything unsaved a run would read, and names the tab that settles it', () => {
    const state = blenderFilmState();
    expect(blenderRenderBlocker(state)).toBeNull();
    expect(blenderRenderBlocker(null).message).toMatch(/Loading/);
    expect(blenderRenderBlocker({ ...state, tool: { ...state.tool, executionMode: 'contained' } })).toMatchObject({ message: expect.stringMatching(/Trusted local/), tab: 'settings' });
    expect(blenderRenderBlocker({ ...state, tool: { ready: false, reason: 'Blender has not been checked.', executionMode: 'trusted-local' } }).message).toBe('Blender has not been checked.');
    expect(blenderRenderBlocker(state, { settingsSaving: true }).message).toMatch(/Saving the render settings/);
    expect(blenderRenderBlocker(state, { settingsDirty: true })).toMatchObject({ message: expect.stringMatching(/Save or discard the render settings/), tab: 'settings' });
    // Blender setup outranks an unsaved file: fixing the file first would still leave renders off.
    expect(blenderRenderBlocker({ ...state, tool: { ...state.tool, ready: false } }, { unsavedFiles: ['film.py'] }).tab).toBe('settings');
    expect(blenderRenderBlocker(state, { unsavedFiles: ['film.py', 'kit/rig.py'] })).toEqual({ message: 'Save or discard your changes to src/film.py and 1 more first.', tab: 'files' });
  });
});

describe('blenderStillPreviewItems', () => {
  it('builds lightbox items that carry no gallery filename', () => {
    const items = blenderStillPreviewItems(blenderFilmState(), (path) => `/media/${path}`);
    expect(items).toEqual([expect.objectContaining({
      kind: 'image', key: 'blender-still:s010:s010/stills/t000002250.png', previewUrl: '/media/s010/stills/t000002250.png', prompt: 'Cold open · still at 0:02.25',
    })]);
    expect(items[0]).not.toHaveProperty('filename');
  });
});

describe('blenderAgentBrief', () => {
  it('hands an agent the project, the workspace, the skill, the contract and the routes', () => {
    const brief = blenderAgentBrief({ projectId: 'mv-test', state: blenderFilmState() });
    for (const needle of [
      'Project id: mv-test', 'Workspace on this machine: /srv/portos/data/music-video/mv-test/blender', 'Skill: portos-music-video-blender', 'describe(ctx)', 'build_shot(ctx, shot)',
      '/api/music-video/mv-test/blender', 'POST   /render', 'POST   /sync', '202 {"job"}', 'ctx.options', 'Film options: none declared.', 'POST /frames/clear',
      'music-video:blender', '3 shots synced', '1920x1080 at 24 fps, EEVEE', 'Only run source you trust',
    ]) expect(brief).toContain(needle);
    const withOptions = blenderFilmState();
    withOptions.manifest.options = [{ key: 'palette', label: 'Palette', type: 'choice', choices: [{ value: 'dusk', label: 'Dusk' }, { value: 'neon', label: 'Neon' }], default: 'dusk' }];
    withOptions.settings.options = { palette: 'neon' };
    expect(blenderAgentBrief({ projectId: 'mv-test', state: withOptions })).toContain('Film options now: palette="neon".');
    const empty = blenderAgentBrief({ projectId: 'mv-test', state: blenderFilmState({ manifest: null, workspace: { exists: false, dir: 'data/music-video/mv-test/blender', hasFilm: false, files: 0 } }) });
    expect(empty).toContain('No src/film.py yet');
  });
});
