import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';

const reader = vi.hoisted(() => ({ gate: null, paths: [], removed: [] }));
vi.mock('node:fs/promises', async (load) => {
  const actual = await load();
  return { ...actual, rm: async (file, options) => {
    if (String(file).includes('portos-shot-color-match-')) reader.removed.push(file);
    return actual.rm(file, options);
  } };
});
vi.mock('../../lib/ffmpeg.js', async (load) => ({ ...await load(),
  probeVideoDuration: async () => 1,
  runFfmpegProcess: async ({ args }) => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(args.at(-1), 'synthetic extracted frame');
    return { ok: true };
  },
}));
vi.mock('sharp', () => ({ default: (file) => {
  const image = {
    rotate: () => image, resize: () => image, removeAlpha: () => image, raw: () => image,
    toBuffer: async () => {
      reader.paths.push(file);
      await reader.gate;
      const { readFile } = await import('node:fs/promises');
      await readFile(file);
      return { data: Buffer.alloc(4 * 4 * 3, 100), info: { width: 4, height: 4, channels: 3 } };
    },
  };
  return image;
} }));

const { _collectColorMatchMeasurements } = await import('./shotColorMatch.js');

describe('video color measurement frame lifetime', () => {
  it('retains an extracted frame until the asynchronous image reader finishes, then removes every sample', async () => {
    let finishRead;
    reader.gate = new Promise((resolve) => { finishRead = resolve; });
    const project = { cameras: [{ id: 'camera' }], scenes: [{ sceneId: 'shot', videoHistoryId: 'clip',
      shotSheet: { cameraId: 'camera', location: 'Room', timeOfDay: 'Day' } }] };
    const pending = _collectColorMatchMeasurements(project, { resolveVideo: async () => '/example/clip.mp4', ffmpeg: 'ffmpeg' });
    try {
      await vi.waitFor(() => expect(reader.paths).toHaveLength(1));
      expect(reader.removed).toEqual([]);
      expect(existsSync(reader.paths[0])).toBe(true);
    } finally {
      finishRead();
    }
    const measured = await pending;
    expect(Object.values(measured.measurements)[0].lumaMean).toBeCloseTo(100 / 255, 5);
    expect(reader.paths).toHaveLength(3);
    expect(reader.removed).toHaveLength(3);
    expect(reader.paths.every((file) => !existsSync(file))).toBe(true);
  });
});
