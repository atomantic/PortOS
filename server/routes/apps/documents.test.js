/**
 * Documents route — the browsable set is a rule (every root markdown file plus
 * the whole `docs/` tree), not the old six-name allowlist (#5773). These run
 * against a real temp repo so the directory walk, the extension filter, and the
 * nested-path guards are exercised end to end; only the apps service and the
 * git commit plumbing are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from '../../lib/testHelper.js';
import { pathExists } from './shared.js';

vi.mock('../../services/apps.js', () => ({ getAppById: vi.fn() }));
vi.mock('../../services/git.js', () => ({
  stageFiles: vi.fn().mockResolvedValue(undefined),
  getStatus: vi.fn().mockResolvedValue({ clean: false }),
  commit: vi.fn().mockResolvedValue({ hash: 'abc1234' })
}));

import * as appsService from '../../services/apps.js';
import * as git from '../../services/git.js';
import documentRoutes from './documents.js';

describe('Apps Document Routes', () => {
  let app;
  let repoPath;

  beforeEach(async () => {
    vi.clearAllMocks();
    repoPath = await mkdtemp(join(tmpdir(), 'portos-docs-'));

    // Root: two markdown files a fixed allowlist would never have named, plus a
    // non-markdown file that must stay out of the listing.
    await writeFile(join(repoPath, 'README.md'), '# Readme');
    await writeFile(join(repoPath, 'ARCHITECTURE.md'), '# Architecture');
    await writeFile(join(repoPath, 'package.json'), '{}');

    await mkdir(join(repoPath, 'docs', 'decisions'), { recursive: true });
    await writeFile(join(repoPath, 'docs', 'API.md'), '# API');
    await writeFile(join(repoPath, 'docs', 'diagram.png'), 'not-markdown');
    await writeFile(join(repoPath, 'docs', 'decisions', '2026-01-01-choice.md'), '# Choice');

    appsService.getAppById.mockResolvedValue({ id: 'app-1', name: 'App', repoPath });

    app = express();
    app.use(express.json());
    app.use('/api/apps', documentRoutes);
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('lists every root markdown file plus the docs/ tree, skipping non-markdown', async () => {
    const res = await request(app).get('/api/apps/app-1/documents');

    expect(res.status).toBe(200);
    const existing = res.body.documents.filter(d => d.exists).map(d => d.filename);
    expect(existing).toEqual(['ARCHITECTURE.md', 'README.md']);
    expect(existing).not.toContain('package.json');

    // Conventional docs the repo lacks are still offered for creation.
    const missing = res.body.documents.filter(d => !d.exists).map(d => d.filename);
    expect(missing).toContain('AGENTS.md');

    expect(res.body.docs).toEqual(['docs/API.md', 'docs/decisions/2026-01-01-choice.md']);
  });

  it('omits docs when the app has no docs/ directory', async () => {
    await rm(join(repoPath, 'docs'), { recursive: true, force: true });

    const res = await request(app).get('/api/apps/app-1/documents');

    expect(res.status).toBe(200);
    expect(res.body.docs).toEqual([]);
  });

  it('reads a nested docs/ file', async () => {
    const res = await request(app).get('/api/apps/app-1/documents/docs/decisions/2026-01-01-choice.md');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ filename: 'docs/decisions/2026-01-01-choice.md', content: '# Choice' });
  });

  it('reads a root file that was never in the old allowlist', async () => {
    const res = await request(app).get('/api/apps/app-1/documents/ARCHITECTURE.md');

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('# Architecture');
  });

  it('404s a markdown path that does not exist', async () => {
    const res = await request(app).get('/api/apps/app-1/documents/docs/missing.md');

    expect(res.status).toBe(404);
  });

  it('rejects a non-markdown file, a path outside docs/, and traversal', async () => {
    const cases = [
      '/api/apps/app-1/documents/package.json',
      '/api/apps/app-1/documents/server/secret.md',
      '/api/apps/app-1/documents/docs/..%2F..%2Fetc%2Fpasswd.md',
    ];

    for (const path of cases) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(400);
      expect(res.body.code, path).toBe('INVALID_DOCUMENT');
    }
  });

  it('writes and commits a nested docs/ file', async () => {
    const res = await request(app)
      .put('/api/apps/app-1/documents/docs/decisions/2026-01-01-choice.md')
      .send({ content: '# Revised' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, hash: 'abc1234', created: false });
    expect(git.stageFiles).toHaveBeenCalledWith(repoPath, ['docs/decisions/2026-01-01-choice.md']);
    expect(await readFile(join(repoPath, 'docs', 'decisions', '2026-01-01-choice.md'), 'utf-8')).toBe('# Revised');
  });

  it('refuses to write outside the browsable set', async () => {
    const res = await request(app)
      .put('/api/apps/app-1/documents/server/index.js')
      .send({ content: 'pwned' });

    expect(res.status).toBe(400);
    expect(git.stageFiles).not.toHaveBeenCalled();
  });

  it('refuses to read or write through a symlinked directory that escapes the repo', async () => {
    // The lexical containment check passes for `docs/escape/...` — only
    // canonicalizing the path catches that the directory points outside.
    const outside = await mkdtemp(join(tmpdir(), 'portos-outside-'));
    await writeFile(join(outside, 'secret.md'), '# Secret');
    await symlink(outside, join(repoPath, 'docs', 'escape'), 'dir');

    const read = await request(app).get('/api/apps/app-1/documents/docs/escape/secret.md');
    expect(read.status).toBe(400);
    expect(read.body.code).toBe('PATH_TRAVERSAL');

    const write = await request(app)
      .put('/api/apps/app-1/documents/docs/escape/secret.md')
      .send({ content: 'pwned' });
    expect(write.status).toBe(400);
    expect(await readFile(join(outside, 'secret.md'), 'utf-8')).toBe('# Secret');

    await rm(outside, { recursive: true, force: true });
  });

  it('refuses to read a symlinked FILE that escapes the repo', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'portos-outside-'));
    await writeFile(join(outside, 'secret.md'), '# Secret');
    await symlink(join(outside, 'secret.md'), join(repoPath, 'docs', 'leak.md'));

    const res = await request(app).get('/api/apps/app-1/documents/docs/leak.md');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PATH_TRAVERSAL');

    await rm(outside, { recursive: true, force: true });
  });

  it('refuses a write git could never stage, before touching the file', async () => {
    // `notes..md` is a legal filename that `isSafeFilename` accepts, but git
    // staging rejects a substring `..` — writing first would leave a mutated
    // tree behind a 500 from stageFiles.
    const res = await request(app)
      .put('/api/apps/app-1/documents/docs/notes..md')
      .send({ content: '# Notes' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DOCUMENT');
    expect(git.stageFiles).not.toHaveBeenCalled();
    expect(await pathExists(join(repoPath, 'docs', 'notes..md'))).toBe(false);
  });
});
