import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
const ROOT = () => lazyTempDataRoot('festival-packet-test-');
vi.mock('../lib/paths.js', async actual => makePathsProxy(await actual(), { dataRoot: ROOT }));
vi.mock('../lib/fileUtils.js', async actual => makePathsProxy(await actual(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', async () => {
  const { EventEmitter } = await import('node:events');
  return { getSettings: vi.fn(async () => ({})), settingsEvents: new EventEmitter() };
});
vi.mock('../services/videoGen/history.js', () => ({ getHistoryItem: vi.fn(async () => ({ filename: 'festival-master.mp4' })) }));
vi.mock('../lib/ffmpeg.js', async actual => ({ ...await actual(), probeVideoGeometry: vi.fn(async () => ({ width: 1920, height: 1080, durationSec: 123.5 })) }));
const { default: router } = await import('./musicVideoFestivalPacket.js');
const projects = await import('../services/musicVideo/projects.js');
const { PATHS } = await import('../lib/fileUtils.js');
const { probeVideoGeometry } = await import('../lib/ffmpeg.js');
const { sanitizeRecordForWire } = await import('../lib/syncWire.js');
function call(method, id, body, suffix = '') {
  return new Promise((resolve, reject) => {
    const route = router.stack.find(layer => layer.route?.path === `/:id/festival-packet${suffix}` && layer.route.methods[method]);
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { if (this.statusCode >= 400) reject(new Error(value.error?.message || value.error || 'Request rejected')); else resolve(value); } };
    route.route.stack[0].handle({ params: { id }, body, app: { get: () => null }, method, url: '/festival-packet' }, res, reject);
  });
}
afterAll(cleanupTempDataRoots);

describe('festival packet routes and persisted project workflow', () => {
  it('saves a legacy project, reopens manual edits after ordinary updates and kit rebuilds, and exports only selected material', async () => {
    const project = await projects.createProject({ name: 'Example Film' });
    const initial = await call('get', project.id);
    expect(initial.packet).toMatchObject({ version: 1, fields: {}, rights: 'unknown', include: [] });
    expect(initial.suggestions).toContainEqual({ field: 'title', value: 'Example Film', source: 'Project title' });
    const packet = { ...initial.packet, fields: { title: 'My festival title', director: 'Example Director', shortSynopsis: 'A voyage.', screener: 'https://example.com/film' }, include: ['title', 'screener', 'rights', 'language'], festivals: [{ name: 'Example Festival', questions: 'Q: Genre? A: Music video', include: true }] };
    const saved = await call('put', project.id, packet);
    await projects.updateProject(project.id, { name: 'Renamed project' });
    await projects.mutateProjectRecord(project.id, current => ({ project: { ...current, publishKit: { builtAt: '2026-01-01', copy: {} } } }));
    expect((await call('get', project.id)).packet).toEqual(saved.packet);
    const preview = await call('post', project.id, saved.packet, '/preview');
    expect(preview.text).toContain('My festival title');
    expect(preview.text).toContain('https://example.com/film');
    expect(preview.text).toContain('unknown (user declaration)');
    expect(preview.text).toContain('Language:\nUnknown');
    expect(preview.text).toContain('Q: Genre?');
    expect(preview.text).not.toContain('Example Director');
    expect(preview.text).not.toContain('A voyage.');
    const wire = sanitizeRecordForWire('musicVideoProject', await projects.getProject(project.id));
    expect(wire.festivalPacket).toEqual(saved.packet);
    expect(sanitizeRecordForWire('musicVideoProject', { ...wire, festivalPacket: { ...saved.packet, fields: { title: 'password: hidden' } } }).festivalPacket).toBeUndefined();
    const { festivalPacket: _packet, ...legacy } = wire;
    await projects.mergeProjectsFromSync([{ ...legacy, name: 'Legacy peer edit', updatedAt: '2099-01-01T00:00:00.000Z' }]);
    expect((await projects.getProject(project.id)).festivalPacket).toEqual(saved.packet);
  });

  it('measures only a present current master and refuses stale or missing measurements', async () => {
    const project = await projects.createProject({ name: 'Measured film' });
    await mkdir(PATHS.videos, { recursive: true });
    await writeFile(join(PATHS.videos, 'festival-master.mp4'), 'synthetic fixture');
    await projects.updateProject(project.id, { renderHistoryId: 'render-a' });
    expect((await call('post', project.id, { version: 1, fields: {}, include: ['measurements'] }, '/preview')).measurements).toEqual({ status: 'current', width: 1920, height: 1080, durationSec: 123.5 });
    probeVideoGeometry.mockImplementationOnce(async () => {
      await projects.updateProject(project.id, { renderHistoryId: 'render-b' });
      return { width: 1920, height: 1080, durationSec: 123.5 };
    });
    const packet = { version: 1, fields: {}, include: ['measurements'] };
    expect((await call('post', project.id, packet, '/preview')).text).toContain('Unknown — current final render unavailable');
    await unlink(join(PATHS.videos, 'festival-master.mp4'));
    expect((await call('post', project.id, packet, '/preview')).measurements.status).toBe('unavailable');
  });

  it.each(['password: hidden', 'https://example.com/film?token=hidden', 'https://studio.ts.net/film', '/Users/example/private.mp4', 'C:\\private\\film.mp4', 'http://192.168.1.2/film', 'https://name:secret@example.com/film'])('rejects unsafe packet text before persistence and export: %s', async value => {
    const project = await projects.createProject({ name: 'Privacy fixture' });
    const packet = { version: 1, fields: { shortSynopsis: value }, include: ['shortSynopsis'] };
    await expect(call('put', project.id, packet)).rejects.toThrow();
    await expect(call('post', project.id, packet, '/preview')).rejects.toThrow();
    expect((await projects.getProject(project.id)).festivalPacket).toBeUndefined();
  });
});
