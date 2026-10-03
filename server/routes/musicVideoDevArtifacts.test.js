/**
 * Music Video development artifacts ("ingredients"), through the real router,
 * the real multipart parser, devArtifactService.js / devArtifacts.js and the
 * real file-backed project store: import (new artifact and new version), list,
 * serve under a sandboxing CSP, notes, review, soft delete, and the guards on
 * file type and stored paths.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-dev-artifact-route-test-');
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);

const SHEET_V1 = '<!doctype html><title>Sheet</title><h1>Cast v1</h1><script>document.title = "x"</script>';
const SHEET_V2 = '<!doctype html><title>Sheet</title><h1>Cast v2</h1>';

async function upload(projectId, { name = 'sheet.html', body = SHEET_V1, type = 'text/html', fields = {} } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([body], { type }), name);
  const encoded = new Request('http://localhost/', { method: 'POST', body: form });
  return request(app).post(`/api/music-video/${projectId}/dev-artifacts`)
    .set('content-type', encoded.headers.get('content-type'))
    .send(Buffer.from(await encoded.arrayBuffer()));
}

const devDir = (projectId) => join(ROOT(), 'music-video', projectId, 'dev');

let project;
beforeEach(async () => {
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  rmSync(join(ROOT(), 'music-video'), { recursive: true, force: true });
  project = await projects.createProject({ name: 'Example Video' });
});
afterAll(cleanupTempDataRoots);

describe('music-video development artifacts', () => {
  it('imports a sheet with its review state, versions it, and serves each version sandboxed', async () => {
    const created = await upload(project.id, {
      fields: { kind: 'cast-sets', title: 'Cast & Sets — Example', status: 'approved', notes: JSON.stringify(['Shorter braid', { text: 'Wider framing on the quay', target: 'test:1' }]) },
    });
    expect(created.status).toBe(201);
    const { artifact } = created.body;
    expect(artifact).toMatchObject({ kind: 'cast-sets', title: 'Cast & Sets — Example', status: 'approved', version: 1, mimeType: 'text/html' });
    expect(artifact.notes.map((n) => [n.text, n.target])).toEqual([['Shorter braid', null], ['Wider framing on the quay', 'test:1']]);
    expect(artifact.file).toBe(`music-video/${project.id}/dev/${artifact.id}/v1.html`);

    // Listed, and persisted on the record (not just echoed).
    const listed = await request(app).get(`/api/music-video/${project.id}/dev-artifacts`);
    expect(listed.body.map((a) => a.id)).toEqual([artifact.id]);

    // A new version of the same artifact resets the review to pending.
    const v2 = await upload(project.id, { body: SHEET_V2, fields: { artifactId: artifact.id } });
    expect(v2.status).toBe(201);
    expect(v2.body.artifact).toMatchObject({ id: artifact.id, version: 2, status: 'pending' });
    expect(v2.body.artifact.versions.map((v) => v.version)).toEqual([1, 2]);

    const current = await request(app).get(`/api/music-video/${project.id}/dev-artifacts/${artifact.id}/file`);
    expect(current.status).toBe(200);
    expect(current.text).toBe(SHEET_V2);
    const csp = current.headers['content-security-policy'];
    // Its own inline script may run, but only in an opaque origin with no network.
    expect(csp).toMatch(/^sandbox allow-scripts;/);
    expect(csp).not.toMatch(/allow-same-origin/);
    expect(csp).toMatch(/default-src 'none'/);
    expect(current.headers['x-content-type-options']).toBe('nosniff');

    const first = await request(app).get(`/api/music-video/${project.id}/dev-artifacts/${artifact.id}/file?version=1`);
    expect(first.text).toBe(SHEET_V1);
    expect((await request(app).get(`/api/music-video/${project.id}/dev-artifacts/${artifact.id}/file?version=3`)).status).toBe(404);
  });

  it('adds and resolves notes, approves or requests changes, and soft-deletes', async () => {
    const { body: { artifact } } = await upload(project.id, { fields: { kind: 'storyboard', title: 'Board' } });
    const noted = await request(app).post(`/api/music-video/${project.id}/dev-artifacts/${artifact.id}/notes`).send({ text: 'Open on the harbor', target: 'set:harbor' });
    expect(noted.status).toBe(201);
    expect(noted.body.note).toMatchObject({ text: 'Open on the harbor', target: 'set:harbor', version: 1, resolvedAt: null });

    const resolved = await request(app).patch(`/api/music-video/${project.id}/dev-artifacts/${artifact.id}/notes/${noted.body.note.id}`).send({ resolved: true });
    expect(resolved.body.note.resolvedAt).toBeTruthy();

    const changes = await request(app).post(`/api/music-video/${project.id}/dev-artifacts/${artifact.id}/review`).send({ status: 'changes-requested', note: 'Warmer light' });
    expect(changes.body.artifact.status).toBe('changes-requested');
    expect(changes.body.artifact.notes.at(-1).text).toBe('Warmer light');
    const approved = await request(app).post(`/api/music-video/${project.id}/dev-artifacts/${artifact.id}/review`).send({ status: 'approved' });
    expect(approved.body.artifact.status).toBe('approved');
    expect((await projects.getProject(project.id)).devArtifacts[0].status).toBe('approved');

    const removed = await request(app).delete(`/api/music-video/${project.id}/dev-artifacts/${artifact.id}`);
    expect(removed.status).toBe(200);
    expect((await request(app).get(`/api/music-video/${project.id}/dev-artifacts`)).body).toEqual([]);
    expect((await request(app).get(`/api/music-video/${project.id}/dev-artifacts/${artifact.id}`)).status).toBe(404);
    // Soft delete: the bytes stay (a clone may still point at them).
    expect(existsSync(join(devDir(project.id), artifact.id, 'v1.html'))).toBe(true);
  });

  it('serves Markdown as plain text and media under a script-free sandbox', async () => {
    const { body: { artifact } } = await upload(project.id, { name: 'treatment.md', body: '# Treatment\n<b>x</b>', type: 'text/markdown', fields: { kind: 'treatment', title: 'Treatment' } });
    expect(artifact.mimeType).toBe('text/markdown');
    const served = await request(app).get(`/api/music-video/${project.id}/dev-artifacts/${artifact.id}/file`);
    expect(served.headers['content-type']).toMatch(/^text\/plain/);
    expect(served.headers['content-security-policy']).toMatch(/^sandbox;/);
  });

  it('keeps planning images out of a code-only project but accepts rendered frames as storyboard evidence', async () => {
    const codeOnly = await projects.createProject({ name: 'Code Only', mediaMode: 'code-only' });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const guide = await upload(codeOnly.id, { name: 'sheet.png', body: png, type: 'image/png', fields: { kind: 'cast-sets', title: 'Painted sheet' } });
    expect(guide.status).toBe(422);
    expect(guide.body.code).toBe('MUSIC_VIDEO_MEDIA_POLICY');
    const frames = await upload(codeOnly.id, { name: 'frames.png', body: png, type: 'image/png', fields: { kind: 'storyboard', title: 'Rendered frames' } });
    expect(frames.status).toBe(201);
    expect(frames.body.artifact.mimeType).toBe('image/png');
    // the HTML guide path is unchanged
    const html = await upload(codeOnly.id, { fields: { kind: 'cast-sets', title: 'Code-authored sheet' } });
    expect(html.status).toBe(201);
  });

  it('refuses an unsupported file type and a new artifact without a kind, storing nothing', async () => {
    const exe = await upload(project.id, { name: 'tool.exe', body: 'MZ', type: 'application/octet-stream', fields: { kind: 'other', title: 'x' } });
    expect(exe.status).toBe(400);
    const noKind = await upload(project.id, { fields: { title: 'x' } });
    expect(noKind.status).toBe(400);
    expect(existsSync(devDir(project.id)) ? readdirSync(devDir(project.id)) : []).toEqual([]);
    expect((await projects.getProject(project.id)).devArtifacts).toBeUndefined();
  });

  it('will not serve a stored path that escapes the music-video folder', async () => {
    const { body: { artifact } } = await upload(project.id, { fields: { kind: 'other', title: 'x' } });
    await projects.mutateProjectRecord(project.id, (current) => ({
      project: {
        ...current,
        devArtifacts: current.devArtifacts.map((a) => ({ ...a, file: '../music-video-projects.json', versions: a.versions.map((v) => ({ ...v, file: '../music-video-projects.json' })) })),
      },
    }));
    const res = await request(app).get(`/api/music-video/${project.id}/dev-artifacts/${artifact.id}/file`);
    expect(res.status).toBe(404);
  });
});
