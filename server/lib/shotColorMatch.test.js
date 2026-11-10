import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  COLOR_MATCH_IDENTITY,
  activeShotColorMatch,
  _applyColorMatchBuffer,
  _applyColorMatchPixel,
  _colorMatchFilterMarkup,
  colorMatchGroups,
  colorMatchGroupOf,
  colorMatchSvgParts,
  colorMatchVideoFilter,
  documentShotColorMatchRuntime,
  _effectiveColorMatch,
  hasMusicVideoColorMatch,
  measureRgbStats,
  _projectColorMatchEntries,
  segmentCacheName,
  segmentLookHashPayload,
  shotSkipsColorMatch,
  _solveColorMatch,
  solveProjectColorMatch,
} from './shotColorMatch.js';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

function solid(level, width = 8, height = 8) {
  const data = new Uint8ClampedArray(width * height * 3);
  const byte = Math.round(level * 255);
  for (let i = 0; i < data.length; i += 3) data[i] = data[i + 1] = data[i + 2] = byte;
  return data;
}

function ramp(scale, width = 32, height = 8) {
  const data = new Uint8ClampedArray(width * height * 3);
  const count = width * height;
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    const byte = Math.round((40 + t * 140) * scale);
    data[i * 3] = data[i * 3 + 1] = data[i * 3 + 2] = Math.max(0, Math.min(255, byte));
  }
  return data;
}

const lumaOf = (data, width, height) => measureRgbStats(data, width, height, 3).lumaMean;

describe('shot color match', () => {
  it('brings two exposures of one shot within a small tolerance', () => {
    const reference = measureRgbStats(ramp(1), 32, 8, 3);
    const source = measureRgbStats(ramp(1.2), 32, 8, 3);
    const { correction, outlier } = _solveColorMatch(source, reference);
    expect(outlier).toBe(false);
    const matched = _applyColorMatchBuffer(ramp(1.2), 32, 8, correction, 3);
    expect(Math.abs(lumaOf(matched, 32, 8) - lumaOf(ramp(1), 32, 8))).toBeLessThan(0.03);
    expect(Math.abs(measureRgbStats(matched, 32, 8, 3).lumaP5 - reference.lumaP5)).toBeLessThan(0.03);
    expect(Math.abs(measureRgbStats(matched, 32, 8, 3).lumaP95 - reference.lumaP95)).toBeLessThan(0.03);
  });

  it('matches a flat exposure change without inventing contrast', () => {
    const dark = measureRgbStats(solid(0.4), 8, 8, 3);
    const bright = measureRgbStats(solid(0.4 * 1.25), 8, 8, 3);
    const { correction, outlier } = _solveColorMatch(bright, dark);
    expect(outlier).toBe(false);
    expect(correction.gamma).toBe(1);
    expect(correction.black).toBe(0);
    const matched = _applyColorMatchBuffer(solid(0.4 * 1.25), 8, 8, correction, 3);
    expect(Math.abs(lumaOf(matched, 8, 8) - 0.4)).toBeLessThan(0.03);
  });

  it('pulls white balance toward the reference and leaves a neutral frame unsaturated', () => {
    const gray = new Uint8ClampedArray(12);
    gray.fill(100);
    const warm = new Uint8ClampedArray(gray);
    for (let i = 0; i < warm.length; i += 3) warm[i] = 120;
    const reference = measureRgbStats(gray, 4, 1, 3);
    const source = measureRgbStats(warm, 4, 1, 3);
    const { correction } = _solveColorMatch(source, reference);
    const [r, g, b] = _applyColorMatchPixel(120 / 255, 100 / 255, 100 / 255, correction);
    expect(Math.abs(r - g)).toBeLessThan(0.04);
    expect(Math.abs(b - g)).toBeLessThan(0.04);
    const neutral = _solveColorMatch(reference, reference);
    expect(neutral.correction.saturation).toBe(1);
    expect(neutral.outlier).toBe(false);
  });

  it('flags a correction past the clamp instead of forcing it', () => {
    const reference = measureRgbStats(solid(0.8), 4, 4, 3);
    const source = measureRgbStats(solid(0.2), 4, 4, 3);
    const { correction, outlier } = _solveColorMatch(source, reference);
    expect(outlier).toBe(true);
    expect(correction.white).toBe(1.45);
  });

  it('leaves a pixel that only its neighbors differ from local', () => {
    const data = solid(0.4, 4, 4);
    data[0] = data[1] = data[2] = 220;
    const { correction } = _solveColorMatch(measureRgbStats(data, 4, 4, 3), measureRgbStats(solid(0.45, 4, 4), 4, 4, 3));
    const matched = _applyColorMatchBuffer(data, 4, 4, correction, 3);
    const alone = _applyColorMatchPixel(0.4, 0.4, 0.4, correction).map((n) => Math.round(n * 255));
    expect([matched[3], matched[4], matched[5]]).toEqual(alone);
    expect(matched[0]).not.toBe(matched[3]);
  });

  it('is no filter and no change when matching is off or already identity', () => {
    expect(_effectiveColorMatch(null)).toBeNull();
    expect(_effectiveColorMatch({ enabled: false, correction: { ...COLOR_MATCH_IDENTITY, white: 1.2 } })).toBeNull();
    expect(_effectiveColorMatch({ strength: 0, correction: { ...COLOR_MATCH_IDENTITY, white: 1.2 } })).toBeNull();
    expect(_effectiveColorMatch({ correction: { ...COLOR_MATCH_IDENTITY } })).toBeNull();
    expect(colorMatchVideoFilter(null)).toBeNull();
    const half = _effectiveColorMatch({ strength: 0.5, correction: { ...COLOR_MATCH_IDENTITY, white: 1.2 } });
    expect(half.white).toBeCloseTo(1.1, 5);
    const filter = colorMatchVideoFilter(half);
    expect(filter.startsWith('format=rgb24,geq=')).toBe(true);
    expect(filter).toContain('\\,');
    expect(filter).not.toContain(',0,1');
  });

  it('skips flash stills, cameras marked do not match, and shots with no scene', () => {
    const camera = { id: 'cam', doNotMatch: true };
    const sheet = { cameraId: 'cam', location: 'Lawn', timeOfDay: 'Night' };
    expect(shotSkipsColorMatch({ imageEffect: 'flash-develop' }, null)).toBe(true);
    expect(shotSkipsColorMatch({ imageEffect: 'end-flash' }, null)).toBe(true);
    expect(shotSkipsColorMatch({ shotSheet: sheet }, camera)).toBe(true);
    expect(colorMatchGroupOf({ shotSheet: sheet }, [camera])).toBeNull();
    expect(colorMatchGroupOf({ shotSheet: { cameraId: 'cam', location: 'Lawn' } }, [])).toBeNull();
    expect(colorMatchGroupOf({ shotSheet: { ...sheet, location: ' lawn ' } }, [{ id: 'cam' }]).key)
      .toBe(colorMatchGroupOf({ shotSheet: { ...sheet, location: 'Lawn' } }, [{ id: 'cam' }]).key);
    expect(colorMatchGroupOf({ shotSheet: { ...sheet, timeOfDay: 'Dusk' } }, [{ id: 'cam' }]).key)
      .not.toBe(colorMatchGroupOf({ shotSheet: sheet }, [{ id: 'cam' }]).key);
  });

  it('matches a group to its median, or to the shot the user picked, and keeps an edited take', () => {
    const camera = { id: 'cam', name: 'Observer' };
    const sheet = { cameraId: 'cam', location: 'Fence', timeOfDay: 'Dusk' };
    const take = (id, level) => ({
      takeId: id,
      kind: 'image',
      assetId: `${id}.png`,
      colorMatch: { stats: measureRgbStats(solid(level), 4, 4, 3) },
    });
    const scene = (id, level, extra = {}) => ({
      sceneId: id, label: id, referenceImageId: `${id}.png`, shotSheet: sheet, takes: [take(id, level)], ...extra,
    });
    const project = { cameras: [camera], scenes: [scene('a', 0.4), scene('b', 0.5), scene('c', 0.45)] };
    const solved = solveProjectColorMatch(project, {}, '2026-01-01T00:00:00.000Z');
    const correction = (id) => solved.scenes.find((entry) => entry.sceneId === id).takes[0].colorMatch.correction;
    expect(correction('c').white).toBe(1);
    expect(correction('b').white).toBeLessThan(1);
    const picked = solveProjectColorMatch({ ...project, colorMatch: { references: [{ cameraId: 'cam', location: 'fence', timeOfDay: 'dusk', sceneId: 'a' }] } }, {}, '2026-01-01T00:00:00.000Z');
    expect(picked.scenes.find((entry) => entry.sceneId === 'a').takes[0].colorMatch.correction).toEqual(COLOR_MATCH_IDENTITY);
    expect(picked.scenes.find((entry) => entry.sceneId === 'b').takes[0].colorMatch.correction.white).toBeLessThan(correction('b').white);
    const edited = solveProjectColorMatch({
      ...project,
      scenes: [scene('a', 0.4, { takes: [{ ...take('a', 0.4), colorMatch: { ...take('a', 0.4).colorMatch, edited: true, correction: { ...COLOR_MATCH_IDENTITY, white: 1.1 }, enabled: false, strength: 0.4 } }] }), scene('b', 0.5), scene('c', 0.45)],
    }, { a: measureRgbStats(solid(0.42), 4, 4, 3) }, '2026-01-02T00:00:00.000Z');
    const kept = edited.scenes[0].takes[0].colorMatch;
    expect(kept.correction.white).toBe(1.1);
    expect(kept.enabled).toBe(false);
    expect(kept.strength).toBe(0.4);
    expect(kept.edited).toBe(true);
    expect(kept.stats.lumaMean).toBeCloseTo(0.42, 2);
  });

  it('shrinks a group\'s spread and names outliers for the board', () => {
    const camera = { id: 'cam', name: 'Observer' };
    const sheet = { cameraId: 'cam', location: 'Lawn', timeOfDay: 'Night' };
    const scene = (id, level) => ({
      sceneId: id, label: id, referenceImageId: `${id}.png`, shotSheet: sheet,
      takes: [{ takeId: id, kind: 'image', assetId: `${id}.png` }],
    });
    const project = { cameras: [camera], scenes: [scene('a', 0.4), scene('b', 0.5)] };
    const measurements = { a: measureRgbStats(solid(0.4), 4, 4, 3), b: measureRgbStats(solid(0.5), 4, 4, 3) };
    const solved = { ...project, ...solveProjectColorMatch(project, measurements, '2026-01-01T00:00:00.000Z') };
    const [group] = colorMatchGroups(solved);
    expect(group.lumaSpreadAfter).toBeLessThan(group.lumaSpreadBefore);
    expect(group.shots.map((shot) => shot.sceneId)).toEqual(['a', 'b']);
    const far = solveProjectColorMatch(
      { cameras: [camera], scenes: [scene('a', 0.2), scene('b', 0.85)] },
      { a: measureRgbStats(solid(0.2), 4, 4, 3), b: measureRgbStats(solid(0.85), 4, 4, 3) },
      '2026-01-01T00:00:00.000Z',
    );
    const flagged = colorMatchGroups({ cameras: [camera], ...far }).flatMap((entry) => entry.shots).filter((shot) => shot.outlier);
    expect(flagged.length).toBeGreaterThan(0);
  });

  it('keeps a segment cache key identical when matching is off', () => {
    const look = { preset: 'super8' };
    const payload = segmentLookHashPayload({ version: 1, baseKey: 'abc', look, startSec: 2, fps: 24 });
    expect(JSON.stringify(payload)).toBe(JSON.stringify({ v: 1, baseKey: 'abc', look, startSec: 2, fps: 24 }));
    const withMatch = segmentLookHashPayload({ version: 1, baseKey: 'abc', look, startSec: 2, fps: 24, matchKey: 'm' });
    expect(hash(withMatch)).not.toBe(hash(payload));
    expect(segmentCacheName({ baseKey: 'abc', lookKey: 'look' })).toBe('abc-look.mp4');
    expect(segmentCacheName({ baseKey: 'abc', matchKey: 'm' })).toBe('abc-match-m.mp4');
    expect(segmentCacheName({ baseKey: 'abc', lookKey: 'look', matchKey: 'm', prefix: 'outro-' })).toBe('outro-abc-look.mp4');
    expect(activeShotColorMatch({ cameras: [] }, { sceneId: 'a' })).toBeNull();
  });

  it('builds an animatic filter with the same gamma the pixel curve uses', () => {
    const correction = { ...COLOR_MATCH_IDENTITY, white: 1.2, gamma: 0.9, saturation: 0.8 };
    const parts = colorMatchSvgParts(correction);
    expect(parts.gamma).toBe(0.9);
    expect(parts.balance.split(' ')).toHaveLength(20);
    expect(parts.saturate.split(' ')).toHaveLength(20);
    expect(parts.balance.startsWith('1.2')).toBe(true);
  });

  it('builds document shot color match runtime only when active', () => {
    const camera = { id: 'cam1', name: 'Main' };
    const take = (enabled = true, strength = 1) => ({
      kind: 'image',
      assetId: 'img1',
      colorMatch: {
        enabled,
        strength,
        correction: { ...COLOR_MATCH_IDENTITY, white: 1.25, gamma: 0.95 },
      },
    });
    const matchedScene = {
      sceneId: 'sc1',
      referenceImageId: 'img1',
      shotSheet: { cameraId: 'cam1', location: 'Studio', timeOfDay: 'Day' },
      takes: [take(true)],
    };
    const skippedCameraScene = {
      sceneId: 'sc2',
      referenceImageId: 'img1',
      shotSheet: { cameraId: 'cam2', location: 'Studio', timeOfDay: 'Day' },
      takes: [take(true)],
    };
    const flashScene = {
      sceneId: 'sc3',
      imageEffect: 'flash-develop',
      referenceImageId: 'img1',
      shotSheet: { cameraId: 'cam1', location: 'Studio', timeOfDay: 'Day' },
      takes: [take(true)],
    };

    const projectOff = { cameras: [camera], scenes: [{ ...matchedScene, takes: [take(false)] }] };
    expect(hasMusicVideoColorMatch(projectOff)).toBe(false);
    expect(_projectColorMatchEntries(projectOff)).toEqual([]);
    expect(documentShotColorMatchRuntime(projectOff)).toBe('');

    const projectDoNotMatch = {
      cameras: [camera, { id: 'cam2', name: 'Raw', doNotMatch: true }],
      scenes: [skippedCameraScene, flashScene],
    };
    expect(hasMusicVideoColorMatch(projectDoNotMatch)).toBe(false);
    expect(_projectColorMatchEntries(projectDoNotMatch)).toEqual([]);
    expect(documentShotColorMatchRuntime(projectDoNotMatch)).toBe('');

    const projectOn = {
      cameras: [camera, { id: 'cam2', name: 'Raw', doNotMatch: true }],
      scenes: [matchedScene, skippedCameraScene, flashScene],
    };
    expect(hasMusicVideoColorMatch(projectOn)).toBe(true);
    const entries = _projectColorMatchEntries(projectOn);
    expect(entries).toHaveLength(1);
    expect(entries[0].sceneId).toBe('sc1');
    expect(entries[0].filterId).toBe('portos-color-match-sc1');

    const markup = _colorMatchFilterMarkup(entries[0].parts, entries[0].filterId);
    expect(markup).toContain('id="portos-color-match-sc1"');
    expect(markup).toContain('color-interpolation-filters="sRGB"');
    expect(markup).toContain('exponent="0.95"');

    const runtime = documentShotColorMatchRuntime(projectOn);
    expect(runtime).toContain('portos-color-match-sc1');
    expect(runtime).toContain('__portosColorMatch');
  });
});
