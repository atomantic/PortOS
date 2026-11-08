/**
 * Mouth-lead correction for a2v renders (#15409).
 *
 * The planner is pinned on synthetic signals with a known lag; the end-to-end
 * path runs real ffmpeg on tiny clips whose "mouth" (a box in the mouth-region
 * proxy) opens on an irregular schedule that a tone follows N frames later.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findFfmpeg, runFfmpegProcess, probeFrameCount, audioFingerprint } from './ffmpeg.js';
import { _planLipsyncShift as planLipsyncShift, alignLipsyncLead, LIPSYNC_MAX_LEAD_FRAMES } from './lipsyncAlign.js';

// Deterministic irregular 0/1 schedule (two incommensurate periods), so the
// cross-correlation has one unambiguous peak.
const gate = (k) => ((k % 17) < 4 || (k % 11) < 3 ? 1 : 0);

// motion[t] pairs with onset[t + lead]: a positive lead is mouth-first.
const signals = (lead, n = 96, noise = 0) => {
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const base = Array.from({ length: n + 20 }, (_, k) => gate(k));
  const motion = Array.from({ length: n }, (_, t) => base[t + 10] + noise * rand());
  const onset = Array.from({ length: n }, (_, t) => base[t + 10 - lead] + noise * rand());
  return { motion, onset };
};

describe('planLipsyncShift', () => {
  it.each([1, 2, LIPSYNC_MAX_LEAD_FRAMES])('holds the picture for a confident %i-frame mouth-first lead', (lead) => {
    expect(planLipsyncShift(signals(lead, 96, 0.3))).toMatchObject({ shiftFrames: lead, lag: lead, reason: 'mouth-lead' });
  });

  it('leaves an aligned clip and an audio-first clip alone', () => {
    expect(planLipsyncShift(signals(0))).toMatchObject({ shiftFrames: 0, lag: 0, reason: 'no-lead' });
    expect(planLipsyncShift(signals(-2))).toMatchObject({ shiftFrames: 0, lag: -2, reason: 'no-lead' });
  });

  it('refuses a lead beyond the correctable range rather than clamping it', () => {
    expect(planLipsyncShift(signals(LIPSYNC_MAX_LEAD_FRAMES + 1))).toMatchObject({ shiftFrames: 0, reason: 'low-confidence' });
  });

  it('refuses a weak peak, a short clip and a static signal', () => {
    let seed = 3;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const noise = { motion: Array.from({ length: 96 }, rand), onset: Array.from({ length: 96 }, rand) };
    const weak = planLipsyncShift(noise);
    expect(weak.shiftFrames).toBe(0);
    expect(['no-lead', 'low-confidence']).toContain(weak.reason);
    expect(planLipsyncShift(signals(2, 12))).toMatchObject({ shiftFrames: 0, reason: 'too-short' });
    expect(planLipsyncShift({ motion: Array(96).fill(1), onset: signals(2).onset })).toMatchObject({ shiftFrames: 0, reason: 'flat-signal' });
  });
});

// Resolved at collection time so a missing encoder skips visibly instead of
// letting the end-to-end cases pass without asserting anything.
const ffmpeg = await findFfmpeg({ requiredEncoder: 'libx264' }).catch(() => null);

describe.skipIf(!ffmpeg)('alignLipsyncLead (real ffmpeg)', () => {
  let tmpDir;
  beforeAll(() => { tmpDir = mkdtempSync(join(tmpdir(), 'portos-lipsync-')); });
  afterAll(() => {
    chmodSync(tmpDir, 0o700);
    for (const entry of readdirSync(tmpDir)) chmodSync(join(tmpDir, entry), 0o700);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const FRAMES = 96;
  const gateExpr = (k) => `gt(lt(mod(${k},17),4)+lt(mod(${k},11),3),0)`;
  // The box is on at frame n when gate(n + 170); the tone at frame f follows gate(f + 170 - lead).
  const makeClip = async (name, { lead, audio = true, dir = tmpDir }) => {
    const path = join(dir, name);
    const run = await runFfmpegProcess({
      bin: ffmpeg,
      args: [
        '-f', 'lavfi', '-i', `color=c=black:size=128x96:rate=24,drawbox=x=48:y=48:w=32:h=16:color=white:t=fill:enable='${gateExpr('n+170')}'`,
        ...(audio ? ['-f', 'lavfi', '-i', `aevalsrc='0.5*sin(2*PI*1000*t)*${gateExpr(`floor(t*24)+${170 - lead}`)}':s=48000:d=${FRAMES / 24}`] : []),
        '-frames:v', String(FRAMES), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        ...(audio ? ['-c:a', 'aac', '-shortest'] : ['-an']), '-y', path,
      ],
    });
    expect(run, 'fixture clip must encode').toEqual({ ok: true });
    return path;
  };

  it('holds the opening frame for a mouth-first lead, keeping the frame count and the soundtrack', async () => {
    const clip = await makeClip('lead.mp4', { lead: 2 });
    const frames = await probeFrameCount(clip);
    const soundtrack = await audioFingerprint(clip);

    const result = await alignLipsyncLead({ videoPath: clip });

    expect(result).toMatchObject({ shiftFrames: 2, lag: 2, reason: 'mouth-lead' });
    expect(result.peakScore).toBeGreaterThan(0.5);
    expect(await probeFrameCount(clip)).toBe(frames);
    expect(await audioFingerprint(clip)).toBe(soundtrack);
    // Re-measuring the delivered clip finds picture and sound back in step.
    expect(await alignLipsyncLead({ videoPath: clip })).toMatchObject({ shiftFrames: 0, lag: 0, reason: 'no-lead' });
  });

  it('leaves an in-sync clip byte-for-byte untouched', async () => {
    const clip = await makeClip('aligned.mp4', { lead: 0 });
    const before = readFileSync(clip);
    expect(await alignLipsyncLead({ videoPath: clip })).toMatchObject({ shiftFrames: 0, lag: 0, reason: 'no-lead' });
    expect(readFileSync(clip).equals(before)).toBe(true);
  });

  it('reports a silent render without touching it', async () => {
    const clip = await makeClip('silent.mp4', { lead: 2, audio: false });
    expect(await alignLipsyncLead({ videoPath: clip })).toEqual({ shiftFrames: 0, lag: null, peakScore: null, reason: 'no-audio' });
  });

  // A read-only directory makes the hold's encode fail; root ignores the mode bits.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('keeps the render untouched when the frame hold cannot be written', async () => {
    const dir = join(tmpDir, 'readonly');
    mkdirSync(dir);
    const clip = await makeClip('lead.mp4', { lead: 2, dir });
    const before = readFileSync(clip);
    chmodSync(dir, 0o500);

    expect(await alignLipsyncLead({ videoPath: clip })).toMatchObject({ shiftFrames: 0, lag: 2, reason: 'hold-failed' });
    expect(readFileSync(clip).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual(['lead.mp4']);
  });
});
