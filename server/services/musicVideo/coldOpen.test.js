/**
 * The cold open's sound and the plain-footage join, against real ffmpeg on
 * tiny generated clips: every shot is exactly its length whatever sound it has,
 * and the cut it is put in front of keeps its own audio after it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-cold-open-test-');
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../tracks/index.js', () => ({ getTrack: vi.fn(async () => null) }));

const { coldOpenAudioShots, ensureColdOpenAudio, prependColdOpen } = await import('./coldOpen.js');
afterAll(cleanupTempDataRoots);

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const run = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
const duration = (path, stream) => Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_entries', 'stream=duration', '-of', 'default=nw=1:nk=1', path]).toString().trim());

describe.skipIf(!hasFfmpeg)('ensureColdOpenAudio', () => {
  it('mixes each shot to exactly its length, back to back, and keeps one mix per sound', async () => {
    const dir = join(ROOT(), 'mix');
    mkdirSync(dir, { recursive: true });
    const clip = join(dir, 'booth.mp4');
    run(['-f', 'lavfi', '-i', 'color=black:s=64x36:r=24:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', clip]);
    const noise = 'anoisesrc=color=white:amplitude=0.05:r=48000,aformat=channel_layouts=stereo';
    const shots = [
      // A layer past the shot's end is left out; one inside it stops at the end.
      { durationSec: 1.25, clip: null, layers: [{ source: noise, atSec: 0.75, durationSec: null, volume: 1 }, { source: noise, atSec: 3, volume: 1 }] },
      // A sped-up clip shorter than its shot loops its sound.
      { durationSec: 0.75, clip: { path: clip, sourceInSec: 0.5, rate: 3, leadSec: 0, loop: true, reverse: false, volume: 0.8 }, layers: [] },
    ];
    const first = await ensureColdOpenAudio(shots, dir);
    expect(duration(first, 'a:0')).toBeCloseTo(2, 2);
    expect(await ensureColdOpenAudio(shots, dir)).toBe(first);
    const second = await ensureColdOpenAudio([{ durationSec: 0.5, clip: null, layers: [] }], dir);
    expect(duration(second, 'a:0')).toBeCloseTo(0.5, 2);
    expect(existsSync(first)).toBe(false);
    // A mix an overlapping request finished after this one started is the client's newer one: kept.
    const newer = join(dir, `cold-open-${'a'.repeat(32)}.wav`);
    writeFileSync(newer, '');
    const later = new Date(Date.now() + 60_000);
    utimesSync(newer, later, later);
    await ensureColdOpenAudio([{ durationSec: 0.25, clip: null, layers: [] }], dir);
    expect(existsSync(newer)).toBe(true);
    expect(existsSync(second)).toBe(false);
  });
});

describe.skipIf(!hasFfmpeg)('prependColdOpen', () => {
  let media;
  beforeAll(() => {
    media = join(ROOT(), 'media');
    mkdirSync(media, { recursive: true });
    run(['-f', 'lavfi', '-i', 'testsrc=s=320x180:r=24', '-f', 'lavfi', '-i', 'sine=frequency=3000', '-t', '2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', join(media, 'booth.mp4')]);
    run(['-f', 'lavfi', '-i', 'smptebars=s=640x360:r=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', join(media, 'cut.mp4')]);
  });

  it('puts the shots before the song in front of the cut, on its frame, with their own sound', async () => {
    const project = { id: 'mv-example', scenes: [{ sceneId: 'booth', order: 0, preMusic: { durationSec: 1.5, clipVolume: 1, layers: [{ effect: 'play-button', atSec: 1 }] } }] };
    const clip = { sceneId: 'booth', videoPath: join(media, 'booth.mp4'), width: 320, height: 180, fps: 24, duration: 1.5, sourceSec: 2, inSec: 0, outSec: 1.5, loop: false, frameFit: 'fill' };
    const lead = await prependColdOpen({ project, coldOpen: { clips: [clip] }, path: join(media, 'cut.mp4'), ffmpeg: 'ffmpeg', jobId: 'job-example' });
    expect(lead).toBe(1.5);
    const out = join(media, 'cut.mp4');
    expect(duration(out, 'v:0')).toBeCloseTo(3.5, 1);
    expect(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out]).toString().trim()).toBe('640,360');
    const level = (start, filter) => Number(/mean_volume: (-?[0-9.]+) dB/.exec(spawnSync('ffmpeg', ['-hide_banner', '-ss', String(start), '-t', '0.8', '-i', out,
      '-af', `${filter}volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr)?.[1]);
    const high = 'highpass=f=1500,highpass=f=1500,highpass=f=1500,';
    const low = 'lowpass=f=900,lowpass=f=900,lowpass=f=900,';
    expect(level(0.1, high)).toBeGreaterThan(level(0.1, low) + 20);
    expect(level(2.2, low)).toBeGreaterThan(level(2.2, high) + 20);
  }, 60000);

  it('refuses a sound layer whose library track is gone, naming the shot', async () => {
    const project = { id: 'mv-example', scenes: [{ sceneId: 'booth', order: 0, preMusic: { durationSec: 1, layers: [{ trackId: 'gone' }] } }] };
    await expect(coldOpenAudioShots(project, [{ sceneId: 'booth', clip: null, durationSec: 1 }]))
      .rejects.toMatchObject({ code: 'PRE_MUSIC_SOUND_MISSING', message: expect.stringContaining('Cold open shot 1') });
  });
});
