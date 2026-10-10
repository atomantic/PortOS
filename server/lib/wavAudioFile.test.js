import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// ffmpeg double: like the real binary it opens its output path and writes
// THROUGH a symlink there; the last argument is the output file.
vi.mock('./ffmpeg.js', () => ({
  findFfmpeg: vi.fn().mockResolvedValue('/fake/ffmpeg'),
  runFfmpegProcess: vi.fn(async ({ args }) => {
    await writeFile(args.at(-1), 'encoded-ogg');
    return { ok: true };
  }),
}));

const { measureWavAudio, wavDurationMs, writeWavAudioFile } = await import('./wavAudioFile.js');

const tmpRoots = [];
afterAll(async () => {
  await Promise.all(tmpRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

// Minimal RIFF/WAVE writer: `samples` is interleaved, already in [-1, 1].
function wav({ samples, channels = 2, sampleRate = 48000, format = 'int16', extensible = false, leadingChunk = false }) {
  const spec = {
    int16: { tag: 1, bits: 16, write: (b, v, at) => b.writeInt16LE(Math.round(v * 32767), at) },
    int24: { tag: 1, bits: 24, write: (b, v, at) => b.writeIntLE(Math.round(v * 8388607), at, 3) },
    float32: { tag: 3, bits: 32, write: (b, v, at) => b.writeFloatLE(v, at) },
    uint8: { tag: 1, bits: 8, write: (b, v, at) => b.writeUInt8(Math.round(v * 127) + 128, at) },
  }[format];
  const bytes = spec.bits / 8;
  const fmt = Buffer.alloc(extensible ? 40 : 16);
  fmt.writeUInt16LE(extensible ? 0xfffe : spec.tag, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * channels * bytes, 8);
  fmt.writeUInt16LE(channels * bytes, 12);
  fmt.writeUInt16LE(spec.bits, 14);
  if (extensible) { fmt.writeUInt16LE(22, 16); fmt.writeUInt16LE(spec.tag, 24); }
  const data = Buffer.alloc(samples.length * bytes);
  samples.forEach((v, i) => spec.write(data, v, i * bytes));
  const chunk = (id, body) => Buffer.concat([Buffer.from(id, 'ascii'), Buffer.from(Uint32Array.of(body.length).buffer), body]);
  const body = Buffer.concat([
    Buffer.from('WAVE', 'ascii'),
    ...(leadingChunk ? [chunk('LIST', Buffer.from('info'))] : []),
    chunk('fmt ', fmt),
    chunk('data', data),
  ]);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from(Uint32Array.of(body.length).buffer), body]);
}

const stereoTone = (frames, amplitude) => Array.from({ length: frames * 2 }, (_, i) => amplitude * Math.sin(i / 7));

describe('measureWavAudio', () => {
  it('decodes integer PCM into format, duration and level', () => {
    const measured = measureWavAudio(wav({ samples: stereoTone(4800, 0.5), leadingChunk: true }));
    expect(measured).toMatchObject({ channels: 2, sampleRate: 48000, bitsPerSample: 16, float: false, frames: 4800, durationMs: 100, nonFinite: 0 });
    expect(measured.peak).toBeGreaterThan(0.45);
    expect(measured.peak).toBeLessThanOrEqual(0.5);
    expect(measured.rms).toBeGreaterThan(0.3);
    // wavDurationMs reads the same chunk scan.
    expect(wavDurationMs(wav({ samples: stereoTone(4800, 0.5), leadingChunk: true }))).toBe(100);
  });

  it('reads EXTENSIBLE 24-bit and counts non-finite float samples', () => {
    expect(measureWavAudio(wav({ samples: stereoTone(480, 0.25), format: 'int24', extensible: true })))
      .toMatchObject({ bitsPerSample: 24, frames: 480, durationMs: 10 });
    const float = measureWavAudio(wav({ samples: [0.5, NaN, -0.75, Infinity], format: 'float32' }));
    expect(float).toMatchObject({ float: true, frames: 2, nonFinite: 2, peak: 0.75 });
  });

  it('reports silence as zero level and rejects what it cannot decode', () => {
    expect(measureWavAudio(wav({ samples: new Array(960).fill(0) }))).toMatchObject({ peak: 0, rms: 0 });
    expect(measureWavAudio(wav({ samples: [0.1, 0.2], format: 'uint8' }))).toBeNull();
    expect(measureWavAudio(Buffer.from('not a wav file at all'))).toBeNull();
    expect(measureWavAudio(null)).toBeNull();
  });
});

describe('writeWavAudioFile OGG staging (#10894)', () => {
  it('replaces a leaf symlink at the OGG destination instead of encoding through it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wav-ogg-'));
    tmpRoots.push(root);
    const dir = join(root, 'out');
    await mkdir(dir);
    const victim = join(root, 'victim.ogg');
    await writeFile(victim, 'victim-bytes');
    await symlink(victim, join(dir, 'loop.ogg'));

    const name = await writeWavAudioFile(wav({ samples: stereoTone(480, 0.25) }), dir, 'loop');

    expect(name).toBe('loop.ogg');
    expect(await readFile(victim, 'utf8')).toBe('victim-bytes');
    expect((await lstat(join(dir, 'loop.ogg'))).isFile()).toBe(true);
    expect(await readFile(join(dir, 'loop.ogg'), 'utf8')).toBe('encoded-ogg');
    expect(await readdir(dir)).toEqual(['loop.ogg']); // no staged temp or WAV left behind
  });
});
