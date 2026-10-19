import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The real execFile carries util.promisify.custom, so promisify() resolves to
// `{ stdout, stderr }`; the double mirrors that.
const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('./childProcess.js', async () => {
  const { promisify } = await import('util');
  return { execFile: Object.assign(() => {}, { [promisify.custom]: mocks.execFile }) };
});

const LONG_GRAPH = 'x'.repeat(16 * 1024 + 1);

// The probe caches its answer per process, so each case loads a fresh module.
const flagFor = async (versionLine) => {
  vi.resetModules();
  mocks.execFile.mockResolvedValue({ stdout: `${versionLine}\nbuilt with gcc` });
  const { filterGraphViaFile } = await import('./ffmpegFilterGraph.js');
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-graph-test-'));
  try {
    const { args, file } = await filterGraphViaFile('ffmpeg', ['-i', 'a.mp4', '-filter_complex', LONG_GRAPH], join(dir, 'g.txt'));
    expect(file).toBe(join(dir, 'g.txt'));
    return args[2];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('filterGraphViaFile flag selection', () => {
  beforeEach(() => mocks.execFile.mockReset());

  it('keeps a short graph inline without probing ffmpeg', async () => {
    const { filterGraphViaFile } = await import('./ffmpegFilterGraph.js');
    const args = ['-filter_complex', 'null'];
    expect(await filterGraphViaFile('ffmpeg', args, 'unused')).toEqual({ args, file: null });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it.each([
    ['a release before 7', 'ffmpeg version 6.1.1 Copyright', '-filter_complex_script'],
    ['a date-stamped Windows build older than the 7.0 release', 'ffmpeg version 2021-02-13-git-d5d6751a55-essentials_build-www.gyan.dev', '-filter_complex_script'],
    ['a release of 7 or newer', 'ffmpeg version 7.1 Copyright', '-/filter_complex'],
    ['a date-stamped build after the 7.0 release', 'ffmpeg version 2025-01-02-git-abc123-essentials_build-www.gyan.dev', '-/filter_complex'],
    ['an N-numbered git build', 'ffmpeg version N-113456-gabcdef Copyright', '-/filter_complex'],
  ])('uses the file option an ffmpeg %s understands', async (_label, versionLine, expected) => {
    expect(await flagFor(versionLine)).toBe(expected);
  });
});
