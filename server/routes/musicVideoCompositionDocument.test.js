/**
 * Music Video composition documents, through the real router, the real
 * multipart parser, compositionDocument.js and the real file-backed project
 * store: zip / data-folder / template import, manifest, export, preview, the
 * file bridge, and the refusals (traversal, symlinks, reserved names).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { createZip } from '../lib/zipWriter.js';
import { readZipArchive } from '../lib/zipArchive.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-composition-document-route-test-');
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const { captureMusicVideoEvidence, musicVideoDependencyChanges } = await import('../lib/musicVideoDependencies.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);

const PAGE = '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><script src="portos-mv.js"></script><script src="app.js"></script></body></html>';
const FILES = { 'index.html': PAGE, 'app.js': 'globalThis.portosComposition = { durationSec: 1, fps: 12, width: 1280, height: 720, seek() {} };', 'style.css': 'body { background: url(bg.png); }', 'bg.png': Buffer.from([137, 80, 78, 71]) };

// A symlink member: the central directory carries a Unix S_IFLNK mode.
function withSymlinkMember(zip, name) {
  const buf = Buffer.from(zip);
  for (let at = 0; at < buf.length - 46; at++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) continue;
    const nameLen = buf.readUInt16LE(at + 28);
    if (buf.subarray(at + 46, at + 46 + nameLen).toString() !== name) continue;
    buf.writeUInt16LE((3 << 8) | 20, at + 4);
    buf.writeUInt32LE((0o120777 << 16) >>> 0, at + 38);
  }
  return buf;
}

async function uploadZip(projectId, zip, name = 'doc.zip') {
  const form = new FormData();
  form.append('file', new Blob([zip], { type: 'application/zip' }), name);
  const encoded = new Request('http://localhost/', { method: 'POST', body: form });
  return request(app).post(`/api/music-video/${projectId}/composition/document/zip`)
    .set('content-type', encoded.headers.get('content-type'))
    .send(Buffer.from(await encoded.arrayBuffer()));
}

async function fetchBytes(path) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), bytes: Buffer.from(await res.arrayBuffer()) };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

const versionsOf = (projectId) => {
  const dir = join(ROOT(), 'music-video', projectId, 'composition');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

let project;
beforeEach(async () => {
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  rmSync(join(ROOT(), 'music-video'), { recursive: true, force: true });
  rmSync(join(ROOT(), 'compositions'), { recursive: true, force: true });
  project = await projects.createProject({ name: 'Example Video' });
});
afterAll(cleanupTempDataRoots);

describe('music-video composition documents', () => {
  it('upgrades a recognized legacy engine without rewriting authored files or validating an old review', async () => {
    // Historical shipped bytes pin recognition independently of today's engine.
    const legacy = await readFile(new URL('./fixtures/musicVideoLayeredEngine.txt', import.meta.url));
    const authored = { ...FILES, 'engine.js': legacy, 'generated.js': 'window.PORTOS_MV_GENERATED = { sections: {} };' };
    const imported = await uploadZip(project.id, createZip(Object.entries(authored).map(([name, data]) => ({ name, data }))));
    const original = imported.body.document.directory;
    const dependencies = captureMusicVideoEvidence(imported.body.project);
    const clone = await projects.cloneProject(project.id);
    const upgrade = () => request(app).post(`/api/music-video/${project.id}/composition/document/engine/upgrade`).send({ directory: original });
    const attempts = await Promise.all([upgrade(), upgrade()]);
    expect(attempts.map(result => result.status).sort()).toEqual([200, 409]);
    const upgraded = attempts.find(result => result.status === 200);
    expect(upgraded.status).toBe(200);
    expect(upgraded.body.changed).toBe(true);
    expect(upgraded.body.document.directory).not.toBe(original);
    const selected = await projects.getProject(project.id);
    expect(musicVideoDependencyChanges(selected, dependencies).some(change => change.role === 'composition')).toBe(true);
    const exported = await fetchBytes(`/api/music-video/${project.id}/composition/document/export`);
    const files = Object.fromEntries(readZipArchive(exported.bytes).map(entry => [entry.name, entry.read()]));
    for (const [name, data] of Object.entries(authored)) {
      if (name !== 'engine.js') expect(files[name]).toEqual(Buffer.from(data));
    }
    const shipped = await readFile(new URL('../services/musicVideo/documentTemplates/layered/engine.js', import.meta.url));
    expect(files['engine.js']).toEqual(shipped);
    const retained = await request(app).get(`/api/music-video/${clone.id}/composition/document/file?path=engine.js`);
    expect(retained.text).toBe(legacy.toString());
    expect((await upgrade()).status).toBe(409);
    const again = await request(app).post(`/api/music-video/${project.id}/composition/document/engine/upgrade`).send({ directory: selected.composition.document.directory });
    expect(again.body).toMatchObject({ changed: false, document: selected.composition.document });
  });

  it('refuses customized engines, pending candidates and invalid upgrade pointers without changing the document', async () => {
    const legacy = await readFile(new URL('./fixtures/musicVideoLayeredEngine.txt', import.meta.url));
    const imported = await uploadZip(project.id, createZip([{ name: 'index.html', data: PAGE }, { name: 'engine.js', data: Buffer.concat([legacy, Buffer.from('\n// authored customization')]) }]));
    const directory = imported.body.document.directory;
    const path = `/api/music-video/${project.id}/composition/document/engine/upgrade`;
    const customized = await request(app).post(path).send({ directory });
    expect(customized.status).toBe(409);
    expect(customized.body.code).toBe('COMPOSITION_ENGINE_CUSTOM');
    expect((await request(app).post(path).send({ directory: '../../other' })).status).toBe(400);
    await projects.mutateProjectRecord(project.id, current => ({ project: { ...current, composition: { ...current.composition, documentDraft: current.composition.document } } }));
    expect((await request(app).post(path).send({ directory })).body.code).toBe('COMPOSITION_DRAFT_STALE');
    expect((await projects.getProject(project.id)).composition.document.directory).toBe(directory);
  });

  it('preserves source document bytes when a fork imports revised code, including after source removal', async () => {
    const zip = (files) => createZip(Object.entries(files).map(([name, data]) => ({ name, data })));
    const imported = await uploadZip(project.id, zip(FILES));
    expect(imported.status).toBe(201);
    const fork = await request(app).post(`/api/music-video/${project.id}/clone`).send({});
    expect(fork.status).toBe(201);
    const footage = await request(app).post(`/api/music-video/${project.id}/clone`).send({ variant: 'video-generation' });
    expect(footage.status).toBe(201);
    const revised = await uploadZip(fork.body.id, zip({ ...FILES, 'app.js': `${FILES['app.js']}\n// revised drawing` }));
    expect(revised.status).toBe(201);
    expect(revised.body.document.directory).not.toBe(imported.body.document.directory);
    const sourceFile = await request(app).get(`/api/music-video/${project.id}/composition/document/file?path=app.js`);
    expect(sourceFile.text).toBe(FILES['app.js']);
    await request(app).delete(`/api/music-video/${project.id}/composition/document`);
    // The footage variant still owns the immutable original pointer, so GC
    // must retain its bytes even though it currently renders in composed mode.
    const retained = await request(app).get(`/api/music-video/${footage.body.id}/composition/document/file?path=app.js`);
    expect(retained.status).toBe(200);
    expect(retained.text).toBe(FILES['app.js']);
  });

  it('persists validated narrative events and gain caps through the project route, and clears anchors on a song replacement', async () => {
    const event = { id: 'counter', name: 'Count rises', kind: 'counter-change', anchor: { kind: 'time', atSec: 0.51 }, durationSec: 1,
      narrativeFunction: 'Show progress', mediumRationale: 'Exact code counter', fromValue: 3, toValue: 8 };
    const composition = { mode: 'document', narrativeEvents: [event], reactiveSections: [{ sectionId: 'song', gain: 1, maxGain: 0.2 }] };
    const patched = await request(app).patch(`/api/music-video/${project.id}`).send({ composition });
    expect(patched.status).toBe(200);
    expect((await projects.getProject(project.id)).composition).toMatchObject(composition);
    const invalid = await request(app).patch(`/api/music-video/${project.id}`).send({ composition: { ...composition, reactiveSections: [{ sectionId: 'song', gain: 1, maxGain: 2 }] } });
    expect(invalid.status).toBe(400);
    const duplicate = await request(app).patch(`/api/music-video/${project.id}`).send({ composition: { ...composition, narrativeEvents: [event, event] } });
    expect(duplicate.status).toBe(400);
    const replaced = await request(app).patch(`/api/music-video/${project.id}`).send({ trackId: 'track-example' });
    expect(replaced.status).toBe(200);
    expect(replaced.body.composition.narrativeEvents).toEqual([{ ...event, anchor: null }]);
    const invalidRevision = await request(app).post(`/api/music-video/${project.id}/composition/document/events/revise`).send({ expectedDraft: '../../other' });
    expect(invalidRevision.status).toBe(400);
  });

  it('imports a zip (one top folder), switches the render style, lists, exports, previews and serves its files inert', async () => {
    const zip = createZip(Object.entries(FILES).map(([name, data]) => ({ name: `my-video/${name}`, data })), { compress: true });
    const created = await uploadZip(project.id, zip, 'my-video.zip');
    expect(created.status).toBe(201);
    const { document } = created.body;
    expect(document).toMatchObject({ entry: 'index.html', source: { kind: 'zip', name: 'my-video.zip' }, files: 4 });
    expect(document.directory).toMatch(new RegExp(`^music-video/${project.id}/composition/doc-`));
    expect(created.body.project.composition).toMatchObject({ mode: 'document', document });
    // Persisted, not just echoed.
    expect((await projects.getProject(project.id)).composition.document).toEqual(document);

    const manifest = await request(app).get(`/api/music-video/${project.id}/composition/document`);
    expect(manifest.body).toMatchObject({ available: true, totalBytes: expect.any(Number) });
    expect(manifest.body.files.map((f) => f.path)).toEqual(['app.js', 'bg.png', 'index.html', 'style.css']);

    const exported = await fetchBytes(`/api/music-video/${project.id}/composition/document/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toBe('application/zip');
    const round = Object.fromEntries(readZipArchive(exported.bytes).map((entry) => [entry.name, entry.read()]));
    expect(Object.keys(round).sort()).toEqual(Object.keys(FILES).sort());
    expect(round['app.js'].toString()).toBe(FILES['app.js']);

    const preview = await request(app).get(`/api/music-video/${project.id}/composition/document/preview`);
    expect(preview.status).toBe(200);
    // Self-contained: no network, the stylesheet/script/asset inlined, PORTOS_MV injected, portos-mv.js dropped.
    expect(preview.body.html).toContain("default-src 'none'");
    expect(preview.body.html).toContain('window.PORTOS_MV = ');
    expect(preview.body.html).toContain(FILES['app.js']);
    expect(preview.body.html).toContain('url("data:image/png;base64,');
    expect(preview.body.html).not.toContain('src="portos-mv.js"');
    expect(preview.body).toMatchObject({ width: 1920, height: 1080, fps: 24 });

    const file = await request(app).get(`/api/music-video/${project.id}/composition/document/file?path=app.js`);
    expect(file.status).toBe(200);
    expect(file.text).toBe(FILES['app.js']);
    expect(file.headers['content-security-policy']).toMatch(/^sandbox;/);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    const traversal = await request(app).get(`/api/music-video/${project.id}/composition/document/file?path=${encodeURIComponent('../../../music-video-projects.json')}`);
    expect(traversal.status).toBe(400);
  });

  it('refuses a zip member that climbs out of the document and writes nothing', async () => {
    const zip = createZip([{ name: 'index.html', data: PAGE }, { name: '../../escape.js', data: 'x' }]);
    const res = await uploadZip(project.id, zip);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('COMPOSITION_DOCUMENT_TRAVERSAL');
    expect(versionsOf(project.id)).toEqual([]);
    expect(existsSync(join(ROOT(), 'escape.js'))).toBe(false);
    expect((await projects.getProject(project.id)).composition).toBeNull();
  });

  it('refuses a zip symlink member', async () => {
    const zip = withSymlinkMember(createZip([{ name: 'index.html', data: PAGE }, { name: 'secrets.json', data: '../../music-video-projects.json' }]), 'secrets.json');
    const res = await uploadZip(project.id, zip);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('COMPOSITION_DOCUMENT_SYMLINK');
    expect(versionsOf(project.id)).toEqual([]);
  });

  it('copies a folder inside data, refusing symlinks, reserved names and paths outside data', async () => {
    const src = join(ROOT(), 'compositions', 'hand-built');
    await mkdir(join(src, 'assets'), { recursive: true });
    for (const [name, data] of Object.entries(FILES)) await writeFile(join(src, name), data);
    const ok = await request(app).post(`/api/music-video/${project.id}/composition/document/directory`).send({ directory: 'compositions/hand-built' });
    expect(ok.status).toBe(201);
    expect(ok.body.document.source).toEqual({ kind: 'directory', name: 'compositions/hand-built' });

    await symlink(join(ROOT(), 'music-video-projects.json'), join(src, 'assets', 'leak.json'));
    const linked = await request(app).post(`/api/music-video/${project.id}/composition/document/directory`).send({ directory: 'compositions/hand-built' });
    expect(linked.status).toBe(422);
    expect(linked.body.code).toBe('COMPOSITION_DOCUMENT_SYMLINK');
    rmSync(join(src, 'assets', 'leak.json'));

    await writeFile(join(src, 'portos-mv.js'), 'window.PORTOS_MV = {};');
    const reserved = await request(app).post(`/api/music-video/${project.id}/composition/document/directory`).send({ directory: 'compositions/hand-built' });
    expect(reserved.status).toBe(422);
    rmSync(join(src, 'portos-mv.js'));

    const outside = await request(app).post(`/api/music-video/${project.id}/composition/document/directory`).send({ directory: '../elsewhere' });
    expect(outside.status).toBe(400);
    // Only the first import produced a version.
    expect(versionsOf(project.id)).toHaveLength(1);
  });

  it('starts from the shipped layered template, and a re-import prunes the version nothing points at', async () => {
    const first = await request(app).post(`/api/music-video/${project.id}/composition/document/template`).send({});
    expect(first.status).toBe(201);
    const dir = join(ROOT(), first.body.document.directory);
    for (const name of ['index.html', 'engine.js', 'fonts/LICENSE-IBM-Plex.txt', 'fonts/LICENSE-Big-Shoulders.txt', 'fonts/big-shoulders-stencil-display-900.woff2']) {
      expect(existsSync(join(dir, name)), name).toBe(true);
    }
    const second = await uploadZip(project.id, createZip(Object.entries(FILES).map(([name, data]) => ({ name, data }))));
    expect(second.status).toBe(201);
    expect(versionsOf(project.id)).toEqual([second.body.document.directory.split('/').pop()]);

    // A PATCH that forges the pointer keeps the stored one.
    const patched = await request(app).patch(`/api/music-video/${project.id}`).send({
      composition: { ...second.body.project.composition, document: { ...second.body.document, directory: first.body.document.directory } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.composition.document).toEqual(second.body.document);

    const detached = await request(app).delete(`/api/music-video/${project.id}/composition/document`);
    expect(detached.status).toBe(200);
    expect(detached.body.project.composition).not.toHaveProperty('document');
    expect(versionsOf(project.id)).toEqual([]);
    const missing = await request(app).get(`/api/music-video/${project.id}/composition/document/export`);
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe('COMPOSITION_DOCUMENT_MISSING');
  });
});
