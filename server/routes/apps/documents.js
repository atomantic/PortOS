/**
 * App document endpoints — read/list a fixed allowlist of planning docs and
 * write-with-git-commit updates.
 *
 *   GET /:id/documents            → { documents, hasPlanning, gsd }
 *   GET /:id/documents/:filename  → { filename, content }
 *   PUT /:id/documents/:filename  → { success, hash?, created }  (git commit)
 */

import { Router } from 'express';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { atomicWrite } from '../../lib/fileUtils.js';
import { documentUpdateSchema } from '../../lib/validation.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import * as git from '../../services/git.js';
import { loadApp, pathExists } from './shared.js';

const router = Router();

const ALLOWED_DOCUMENTS = ['PLAN.md', 'CLAUDE.md', 'GOALS.md', 'REVIEW.md', 'REJECTED.md'];

// GET /api/apps/:id/documents - List which documents exist
router.get('/:id/documents', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!app.repoPath || !await pathExists(app.repoPath)) {
    return res.json({ documents: [], hasPlanning: false });
  }

  const documents = await Promise.all(ALLOWED_DOCUMENTS.map(async filename => ({
    filename,
    exists: await pathExists(join(app.repoPath, filename))
  })));

  const planningDir = join(app.repoPath, '.planning');
  const hasPlanning = await pathExists(planningDir);

  // GSD status: detect which GSD artifacts exist
  const gsd = {
    hasCodebaseMap: await pathExists(join(planningDir, 'codebase')),
    hasProject: await pathExists(join(planningDir, 'PROJECT.md')),
    hasRoadmap: await pathExists(join(planningDir, 'ROADMAP.md')),
    hasState: await pathExists(join(planningDir, 'STATE.md')),
    hasConcerns: await pathExists(join(planningDir, 'CONCERNS.md')),
  };

  res.json({ documents, hasPlanning, gsd });
}));

// GET /api/apps/:id/documents/:filename - Read a single document
router.get('/:id/documents/:filename', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const { filename } = req.params;

  if (!ALLOWED_DOCUMENTS.includes(filename)) {
    throw new ServerError('Document not in allowlist', { status: 400, code: 'INVALID_DOCUMENT' });
  }

  if (!app.repoPath || !await pathExists(app.repoPath)) {
    throw new ServerError('App repo path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  const filePath = join(app.repoPath, filename);
  const resolved = resolve(filePath);

  // Path traversal guard
  if (!resolved.startsWith(resolve(app.repoPath))) {
    throw new ServerError('Invalid document path', { status: 400, code: 'PATH_TRAVERSAL' });
  }

  if (!await pathExists(resolved)) {
    throw new ServerError('Document not found', { status: 404, code: 'NOT_FOUND' });
  }

  const content = await readFile(resolved, 'utf-8');
  res.json({ filename, content });
}));

// PUT /api/apps/:id/documents/:filename - Update a document and git commit
router.put('/:id/documents/:filename', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const { filename } = req.params;

  if (!ALLOWED_DOCUMENTS.includes(filename)) {
    throw new ServerError('Document not in allowlist', { status: 400, code: 'INVALID_DOCUMENT' });
  }

  if (!app.repoPath || !await pathExists(app.repoPath)) {
    throw new ServerError('App repo path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  const filePath = join(app.repoPath, filename);
  const resolved = resolve(filePath);

  if (!resolved.startsWith(resolve(app.repoPath))) {
    throw new ServerError('Invalid document path', { status: 400, code: 'PATH_TRAVERSAL' });
  }

  const { content, commitMessage } = documentUpdateSchema.parse(req.body);
  const created = !await pathExists(resolved);

  await atomicWrite(resolved, content);
  await git.stageFiles(app.repoPath, [filename]);

  const status = await git.getStatus(app.repoPath);
  if (status.clean) {
    return res.json({ success: true, noChanges: true });
  }

  const message = commitMessage || `docs: update ${filename} via PortOS`;
  const result = await git.commit(app.repoPath, message);
  console.log(`📝 ${created ? 'Created' : 'Updated'} ${filename} in ${app.name} (${result.hash})`);

  res.json({ success: true, hash: result.hash, created });
}));

export default router;
