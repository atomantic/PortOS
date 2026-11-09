import { describe, expect, it } from 'vitest';
import { filmLookPreset } from './filmLook.js';
import {
  cameraFrameCss, cameraFrameWindow, documentFilmLookRuntime, hasMusicVideoFilmLook, musicVideoOverscan, shotFilmLook,
} from './musicVideoFilmLook.js';
import { musicVideoFrameModelInput } from './musicVideoShotPrompt.js';
import { applyCameraCutDefaults, sceneTransitionSections } from './musicVideoTransitions.js';
import { musicVideoProjectUpdateSchema } from './musicVideoValidation.js';
import { buildMusicVideoFfmpegArgs } from '../services/musicVideo/render.js';
import { applyProjectPatch, buildProjectRecord } from '../services/musicVideo/projectsLogic.js';

const vhs = filmLookPreset('vhs');
const film = filmLookPreset('16mm');
const clean = filmLookPreset('none');
const camera = { id: 'cam', name: 'Camcorder', kind: 'in-world', filmLook: film };
const project = {
  filmLook: vhs,
  concept: { style: 'harbor grainy 16mm, VHS-C tracking noise' },
  cameras: [camera],
};
const onCamera = { sceneId: 's1', startSec: 0, endSec: 2, framePrompt: 'harbor at dawn', shotSheet: { cameraId: 'cam' } };

const graphOf = (clips) => {
  const plan = buildMusicVideoFfmpegArgs(clips, null, 'out.mp4', {
    canvas: { width: 1920, height: 1080, fps: 24 }, frameGrid: true,
  });
  return plan.args[plan.args.indexOf('-filter_complex') + 1];
};

describe('camera film look', () => {
  // Catches a camera look losing to the video, or an explicit Clean falling through.
  it('uses the shot, then the camera, then the video', () => {
    expect(shotFilmLook(project, onCamera).preset).toBe('16mm');
    expect(shotFilmLook(project, { ...onCamera, filmLook: vhs }).preset).toBe('vhs');
    expect(shotFilmLook(project, { ...onCamera, filmLook: clean })).toBe(null);
    expect(shotFilmLook(project, { sceneId: 's2' }).preset).toBe('vhs');
    expect(shotFilmLook({ cameras: [camera] }, onCamera).preset).toBe('16mm');
    expect(hasMusicVideoFilmLook({ cameras: [camera] })).toBe(true);
    expect(hasMusicVideoFilmLook({ cameras: [{ ...camera, filmLook: clean }] })).toBe(false);
  });

  // Catches a camera look still following the live video slider.
  it('pins a shot whose camera has its own look', () => {
    const source = documentFilmLookRuntime({
      filmLook: vhs,
      cameras: [camera],
      scenes: [onCamera, { sceneId: 's2', startSec: 2, endSec: 4 }],
    });
    expect(source).toContain('"pinned":true');
    expect(source).toContain('"pinned":false');
    expect(source).toContain('scene.pinned ? scene.look : base');
  });
});

describe('camera frame and overscan', () => {
  // Catches a 4:3 camera failing to pillarbox inside 16:9, or a matching frame adding a matte.
  it('fits 4:3 and 3:2 inside 16:9 and leaves a matching frame alone', () => {
    expect(cameraFrameWindow(1920, 1080, '4:3')).toEqual({ w: 1440, h: 1080 });
    expect(cameraFrameWindow(1920, 1080, '3:2')).toEqual({ w: 1620, h: 1080 });
    expect(cameraFrameWindow(1920, 1080, '16:9')).toBe(null);
    expect(cameraFrameCss('4:3')).toEqual({ width: '75%', height: '100%' });
    expect(cameraFrameCss('16:9')).toBe(null);
    expect(musicVideoOverscan({ overscan: 4 })).toBe(4);
    expect(musicVideoOverscan({ overscan: 0 })).toBe(0);
  });

  // Catches the crop landing after the matte, or a default chain growing a color pad.
  it('crops overscan before the 4:3 matte and leaves a plain chain unchanged', () => {
    const framed = graphOf([{
      sceneId: 's1', layer: 'still', imagePath: 'frame.png', move: 'hold', inSec: 0, outSec: 1, duration: 1, sourceSec: 1,
      cameraFrame: { aspect: '4:3', matte: '#101010' }, overscan: 4,
    }]);
    expect(framed).toContain('crop=iw*0.92:ih*0.92');
    expect(framed).toContain('scale=1440:1080');
    expect(framed).toContain('pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x101010');
    const plain = graphOf([{
      sceneId: 's1', layer: 'still', imagePath: 'frame.png', move: 'hold', inSec: 0, outSec: 1, duration: 1, sourceSec: 1,
    }]);
    expect(plain).not.toContain('crop=iw*');
    expect(plain).not.toContain('pad=');
    const footage = graphOf([{
      sceneId: 's1', videoPath: 'c.mp4', width: 1920, height: 1080, fps: 24, duration: 1, sourceSec: 1, inSec: 0, outSec: 1, loop: false,
    }]);
    expect(footage).toContain('pad=1920:1080:(ow-iw)/2:(oh-ih)/2,');
    expect(footage).not.toContain('color=0x');
    const pillar = graphOf([{
      sceneId: 's1', videoPath: 'c.mp4', width: 1920, height: 1080, fps: 24, duration: 1, sourceSec: 1, inSec: 0, outSec: 1, loop: false,
      cameraFrame: { aspect: '4:3', matte: '#101010' },
    }]);
    expect(pillar).toContain('scale=1440:1080');
    expect(pillar).toContain('color=0x101010');
    const card = graphOf([{
      sceneId: 's1', layer: 'card', cardColor: '#112233', inSec: 0, outSec: 1,
      cameraFrame: { aspect: '4:3', matte: '#101010' }, overscan: 4,
    }]);
    expect(card).toContain('color=c=0x112233:s=1920x1080');
    expect(card).not.toContain('1440');
  });
});

describe('camera cut defaults', () => {
  const cameras = [{ id: 'cam', cuts: { transitionIn: 'camera-flash', transitionOut: null, glitches: [{ atSec: 0, style: 'vhs-glitch' }] } }];

  // Catches Off inheriting a camera cut, or a null camera field being copied on.
  it('fills only an absent cut and leaves an explicit Off alone', () => {
    const inherited = applyCameraCutDefaults({ shotSheet: { cameraId: 'cam' }, startSec: 0, endSec: 2, sceneId: 's1' }, cameras);
    expect(inherited.transitionIn).toBe('camera-flash');
    expect(inherited.transitionOut).toBeUndefined();
    expect(inherited.glitches).toEqual([{ atSec: 0, style: 'vhs-glitch' }]);
    const off = applyCameraCutDefaults({ shotSheet: { cameraId: 'cam' }, transitionIn: null, startSec: 0, endSec: 2, sceneId: 's1' }, cameras);
    expect(off.transitionIn).toBe(null);
    expect(sceneTransitionSections([inherited], 24)[0].transitionIn).toBe('camera-flash');
    expect(sceneTransitionSections([{ shotSheet: { cameraId: 'cam' }, startSec: 0, endSec: 2, sceneId: 's1' }], 24, { cameras })[0].transitionIn).toBe('camera-flash');
    expect(sceneTransitionSections([{ shotSheet: { cameraId: 'cam' }, transitionIn: null, startSec: 0, endSec: 2, sceneId: 's1' }], 24, { cameras })[0].transitionIn).toBeUndefined();
  });
});

describe('camera finish on save and in the frame prompt', () => {
  // Catches a strict camera schema rejecting the new fields, or a bad aspect or crop slipping through.
  it('accepts a camera finish and an overscan of 0 to 8', () => {
    const finished = {
      ...camera,
      frame: { aspect: '4:3', matte: '#101010' },
      cuts: { transitionIn: 'camera-flash', glitches: [{ atSec: 0, style: 'vhs-glitch' }] },
      osd: { record: true, date: '01 01 1990' },
    };
    expect(musicVideoProjectUpdateSchema.safeParse({ cameras: [finished], overscan: 4 }).success).toBe(true);
    expect(musicVideoProjectUpdateSchema.safeParse({ cameras: [{ id: 'cam', name: 'Camcorder', kind: 'in-world' }] }).success).toBe(true);
    expect(musicVideoProjectUpdateSchema.safeParse({ cameras: [{ ...camera, frame: { aspect: '9:16' } }] }).success).toBe(false);
    expect(musicVideoProjectUpdateSchema.safeParse({ overscan: 9 }).success).toBe(false);
  });

  // Catches a stored camera look or a zero crop changing shape.
  it('normalizes a camera look and stores overscan only when it crops', () => {
    const now = '2026-01-01T00:00:00.000Z';
    expect(buildProjectRecord({ name: 'Example' }, { id: 'p', now })).not.toHaveProperty('overscan');
    expect(buildProjectRecord({ name: 'Example', overscan: 4 }, { id: 'p', now }).overscan).toBe(4);
    expect(buildProjectRecord({ name: 'Example', overscan: 0 }, { id: 'p', now })).not.toHaveProperty('overscan');
    const bare = [{ id: 'cam', name: 'Camcorder', kind: 'in-world' }];
    expect(applyProjectPatch({ id: 'p', scenes: [] }, { cameras: bare }).cameras).toEqual(bare);
    expect(applyProjectPatch({ id: 'p', scenes: [] }, { overscan: 0 }).overscan).toBe(null);
    expect(applyProjectPatch({ id: 'p', scenes: [] }, { cameras: [camera] }).cameras[0].filmLook).toEqual(film);
  });

  // Catches a finishing look still asking the image model for grain, or a clean shot losing the style words.
  it('asks for a clean frame only while a finishing look is active', () => {
    const finished = musicVideoFrameModelInput(project, onCamera);
    const style = finished.promptAdditions.find((item) => item.id === 'project-style');
    expect(finished.promptAdditions.map((item) => item.id)).toContain('clean-frame');
    expect(style.text).toBe('harbor 16mm');
    expect(style.text).not.toMatch(/grain|vhs|tracking/i);
    expect(finished.prompt).toContain('harbor at dawn');
    expect(finished.prompt).toContain('Deliver a clean full-bleed photograph');
    const open = musicVideoFrameModelInput({ concept: { style: 'grainy 16mm' } }, { sceneId: 's1', framePrompt: 'harbor at dawn' });
    expect(open.prompt).toContain('harbor at dawn, grainy 16mm');
    expect(open.promptAdditions.map((item) => item.id)).not.toContain('clean-frame');
    const ownClean = musicVideoFrameModelInput(project, { ...onCamera, filmLook: clean });
    expect(ownClean.promptAdditions.find((item) => item.id === 'project-style').text).toMatch(/grainy/);
    expect(ownClean.promptAdditions.map((item) => item.id)).not.toContain('clean-frame');
    const refined = musicVideoFrameModelInput(project, onCamera, { refine: true });
    expect(refined.promptAdditions.map((item) => item.id)).not.toContain('clean-frame');
  });
});
