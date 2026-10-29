/** Optional real-tool integration: set PORTOS_DCP_TEST_TOOLS to a DCP-o-matic 2.18 CLI directory. */
import { describe, it, expect, vi, afterAll } from 'vitest';
import express from 'express';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('mv-dcp-') }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const toolDir = process.env.PORTOS_DCP_TEST_TOOLS;
const originalPath = process.env.PATH;
const originalTmp = process.env.TMPDIR;
const realToolTest = toolDir ? describe : describe.skip;
realToolTest('cinema package real-tool integration', () => {
  it('preserves the master, creates and verifies Flat 24fps DCP with left/right audio, and rejects corruption', async () => {
    process.env.PATH = `${toolDir}:${process.env.PATH}`;
    const { PATHS } = await import('../lib/paths.js');
    const toolTmp = join(PATHS.data, 'dcp-tool-temp');
    await mkdir(toolTmp, { recursive: true });
    process.env.TMPDIR = toolTmp;
    const projects = await import('../services/musicVideo/projects.js');
    const dcp = await import('../services/musicVideo/dcp.js');
    const ffmpeg = await import('../lib/ffmpeg.js');
    const { saveHistory } = await import('../services/videoGen/history.js');
    const { default: router } = await import('./musicVideo.js');
    const app = express(); app.use(express.json()); app.use('/api/music-video', router); app.use(errorMiddleware);
    await mkdir(PATHS.videos, { recursive: true });
    const raw = join(PATHS.videos, 'raw.mp4');
    const master = join(PATHS.videos, 'master.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-filter_complex', '[1:a][2:a]amerge=inputs=2[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', raw]);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', raw, '-c', 'copy', '-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1', master]);
    const before = createHash('sha256').update(await readFile(master)).digest('hex');
    const project = await projects.createProject({ name: 'Fixture' });
    await saveHistory([{ id: 'dcp-fixture', filename: 'master.mp4', durationSec: 2 }]);
    await projects.mutateProjectRecord(project.id, p => ({ project: { ...p, renderHistoryId: 'dcp-fixture' } }));
    const ready = await request(app).post(`/api/music-video/${project.id}/dcp/readiness`);
    expect(ready.status).toBe(200);
    expect(ready.body.problems).toEqual([]);
    expect(Object.values(ready.body.tools)).toEqual([true, true, true, true]);
    const started = await request(app).post(`/api/music-video/${project.id}/dcp/build`).send({ grade: 'rec709', renderHistoryId: 'dcp-fixture', sourceSha256: before });
    expect(started.status).toBe(200);
    let result;
    await vi.waitFor(async () => {
      result = await projects.getProject(project.id);
      expect(result.dcpExports?.length).toBe(1);
    }, { timeout: 180000, interval: 1000 });
    const artifact = result.dcpExports[0];
    expect(artifact).toMatchObject({ sourceRenderId: 'dcp-fixture', sourceSha256: before, status: 'verified', container: { width: 1998, height: 1080 } });
    expect(createHash('sha256').update(await readFile(master)).digest('hex')).toBe(before);
    const dir = join(PATHS.videos, artifact.id, 'package');
    const names = await readdir(dir);
    const picture = join(dir, names.find(name => name.startsWith('j2c_') && name.endsWith('.mxf')));
    const sound = join(dir, names.find(name => name.startsWith('pcm_') && name.endsWith('.mxf')));
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', picture], { encoding: 'utf8' }));
    expect(info.streams[0]).toMatchObject({ width: 1998, height: 1080, r_frame_rate: '24/1', duration_ts: 48 });
    const report = await readFile(join(PATHS.videos, artifact.id, 'verification.txt'), 'utf8');
    expect(report).toContain('1920x1080');
    const audio = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', sound, '-f', 'f32le', '-acodec', 'pcm_f32le', '-'], { maxBuffer: 4 * 1024 * 1024 });
    const crossings = [0, 0]; const energy = Array(6).fill(0); const previous = [0, 0];
    for (let offset = 0; offset + 24 <= audio.length; offset += 24) for (let channel = 0; channel < 6; channel++) {
      const value = audio.readFloatLE(offset + channel * 4); energy[channel] += value * value;
      if (channel < 2) { if (previous[channel] < 0 && value >= 0) crossings[channel]++; previous[channel] = value; }
    }
    expect(crossings[0]).toBeGreaterThan(850); expect(crossings[0]).toBeLessThan(910);
    expect(crossings[1]).toBeGreaterThan(1700); expect(crossings[1]).toBeLessThan(1820);
    expect(energy.slice(2).every(value => value === 0)).toBe(true);
    const invalid = join(PATHS.videos, 'invalid-dcp'); await cp(dir, invalid, { recursive: true });
    const damaged = join(invalid, names.find(name => name.startsWith('j2c_') && name.endsWith('.mxf')));
    const file = await open(damaged, 'r+'); const byte = Buffer.alloc(1); await file.read(byte, 0, 1, 50000); byte[0] ^= 1; await file.write(byte, 0, 1, 50000); await file.close();
    expect(() => execFileSync(join(toolDir, 'dcpomatic2_verify_cli'), ['-q', invalid], { stdio: 'pipe' })).toThrow();
    // Cancellation belongs only to this job and preserves the verified output.
    const second = await request(app).post(`/api/music-video/${project.id}/dcp/build`).send({ grade: 'rec709', renderHistoryId: 'dcp-fixture', sourceSha256: before });
    expect(second.status).toBe(200);
    const cancelled = await request(app).post(`/api/music-video/dcp/${second.body.jobId}/cancel`);
    expect(cancelled.body.ok).toBe(true);
    await vi.waitFor(() => expect(dcp.isDcpActive(project.id)).toBe(false), { timeout: 30000, interval: 100 });
    expect((await projects.getProject(project.id)).dcpExports).toHaveLength(1);
    expect(createHash('sha256').update(await readFile(master)).digest('hex')).toBe(before);
    expect(await readdir(dir)).toEqual(names);

    // A verifier failure must be persisted as failed, with its report, while
    // keeping the preceding verified package intact.
    const realRun = ffmpeg.runFfmpegProcess;
    const spy = vi.spyOn(ffmpeg, 'runFfmpegProcess').mockImplementation(async options => {
      if (options.bin.endsWith('dcpomatic2_verify_cli')) {
        await writeFile(options.args[2], 'verification failed');
        return { ok: false, reason: 'fixture verifier failure' };
      }
      return realRun(options);
    });
    try {
      const third = await request(app).post(`/api/music-video/${project.id}/dcp/build`).send({ grade: 'rec709', renderHistoryId: 'dcp-fixture', sourceSha256: before });
      expect(third.status).toBe(200);
      await vi.waitFor(async () => expect((await projects.getProject(project.id)).dcpExports).toHaveLength(2), { timeout: 180000, interval: 1000 });
      const failed = (await projects.getProject(project.id)).dcpExports[1];
      expect(failed.status).toBe('verification-failed');
      expect(await readFile(join(PATHS.videos, failed.id, 'verification.txt'), 'utf8')).toBe('verification failed');
      expect(await readdir(dir)).toEqual(names);
    } finally { spy.mockRestore(); }
    // Untagged source is rejected without touching either prior package.
    await saveHistory([{ id: 'dcp-fixture', filename: 'master.mp4', durationSec: 2 }, { id: 'untagged', filename: 'raw.mp4', durationSec: 2 }]);
    await projects.mutateProjectRecord(project.id, p => ({ project: { ...p, renderHistoryId: 'untagged' } }));
    const untaggedReadiness = await request(app).post(`/api/music-video/${project.id}/dcp/readiness`);
    const unsupported = await request(app).post(`/api/music-video/${project.id}/dcp/build`).send({ grade: 'rec709', renderHistoryId: 'untagged', sourceSha256: untaggedReadiness.body.sourceSha256 });
    expect(unsupported.status).toBe(200);
    const events = await request(app).get(`/api/music-video/dcp/${unsupported.body.jobId}/events`);
    expect(events.text).toContain('explicit BT.709');
    expect((await projects.getProject(project.id)).dcpExports).toHaveLength(2);
    expect(await readdir(dir)).toEqual(names);
  }, 240000);
});
afterAll(async () => { process.env.PATH = originalPath; process.env.TMPDIR = originalTmp; await cleanupTempDataRoots(); });
