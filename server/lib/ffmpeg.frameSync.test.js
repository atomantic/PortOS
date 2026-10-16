import { describe, expect, it, vi } from 'vitest';

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('./childProcess.js', async original => ({
  ...await original(),
  execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: probe }),
}));
import { vfrSyncArgs } from './ffmpeg.js';

describe('VFR output synchronization capability', () => {
  it('uses the current per-output option, sharing one probe across concurrent callers', async () => {
    probe.mockResolvedValueOnce({ stdout: '-fps_mode[:stream_specifier]  set framerate mode\n-vsync  old sync option' });
    const before = probe.mock.calls.length;
    expect(await Promise.all([vfrSyncArgs('current'), vfrSyncArgs('current')]))
      .toEqual([['-fps_mode', 'vfr'], ['-fps_mode', 'vfr']]);
    expect(await vfrSyncArgs('current')).toEqual(['-fps_mode', 'vfr']);
    expect(probe.mock.calls.length - before).toBe(1);
    expect(probe.mock.calls.at(-1)[1]).toEqual(['-hide_banner', '-h', 'full']);
  });

  it('preserves older builds that advertise only the legacy VFR option', async () => {
    probe.mockResolvedValueOnce({ stdout: '  -vsync  video sync method' });
    expect(await vfrSyncArgs('legacy')).toEqual(['-vsync', 'vfr']);
    expect(await vfrSyncArgs('current')).toEqual(['-fps_mode', 'vfr']);
  });

  it.each(['failure', 'unrecognized help'])('does not cache an inconclusive %s as an old build', async kind => {
    if (kind === 'failure') probe.mockRejectedValueOnce(new Error('temporary probe failure'));
    else probe.mockResolvedValueOnce({ stdout: 'usage without an option listing' });
    expect(await vfrSyncArgs(kind)).toEqual(['-fps_mode', 'vfr']);
    probe.mockResolvedValueOnce({ stdout: '-vsync  video sync method' });
    expect(await vfrSyncArgs(kind)).toEqual(['-vsync', 'vfr']);
  });
});
