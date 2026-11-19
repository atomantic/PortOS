/**
 * Development-artifact routes of the Music Video surface: import, review notes and file download (#16097).
 * Mounted from musicVideo.js at the position of its first route so match order
 * against the remaining routes is unchanged.
 */

import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { musicVideoDevArtifactImportSchema, musicVideoDevArtifactNoteSchema, musicVideoDevArtifactNoteUpdateSchema, musicVideoDevArtifactReviewSchema, musicVideoDevArtifactFileQuerySchema } from '../lib/musicVideo/musicVideoRouteValidation.js';
import { uploadSingle } from '../lib/multipart.js';
import { listDevArtifacts, getDevArtifact, importDevArtifact, resolveDevArtifactDownload, addNote as addDevArtifactNote, setNoteResolved as setDevArtifactNoteResolved, reviewArtifact as reviewDevArtifact, removeDevArtifact } from '../services/musicVideo/devArtifactService.js';
import { devArtifactTypeFor } from '../services/musicVideo/devArtifacts.js';

const router = Router();

// --- Development artifacts ("ingredients") ---
// Reviewable development files attached to the project: list, import/upload
// (HTML, Markdown, MP4, PNG, JPG — a new artifact, or a new version of one),
// serve, notes, review and soft delete. See services/musicVideo/devArtifacts.js.
const DEV_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;

const devArtifactUpload = uploadSingle('file', {
  limits: { fileSize: DEV_ARTIFACT_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = String(file.originalname || '').split('.').pop();
    if (String(file.originalname || '').includes('.') && devArtifactTypeFor(ext)) cb(null, true);
    else cb(new ServerError('Unsupported file type — accepted: HTML, Markdown, MP4, PNG, JPG', { status: 400, code: 'VALIDATION_ERROR' }));
  },
});

// A served artifact never runs with the PortOS origin: HTML is sandboxed by
// its CSP even when opened directly (an opaque origin, no same-origin access),
// may run its own inline script inside that sandbox, and can load nothing
// from the network — images, media and fonts only as data:/blob: URLs.
const DEV_ARTIFACT_HTML_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:";

const DEV_ARTIFACT_MEDIA_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

router.get('/:id/dev-artifacts', asyncHandler(async (req, res) => {
  res.json(await listDevArtifacts(req.params.id));
}));

router.post('/:id/dev-artifacts', devArtifactUpload, asyncHandler(async (req, res) => {
  if (!req.file) throw new ServerError('No file uploaded (multipart field "file")', { status: 400, code: 'VALIDATION_ERROR' });
  const input = (() => {
    try {
      return validateRequest(musicVideoDevArtifactImportSchema, req.body || {});
    } catch (err) {
      unlink(req.file.path).catch(() => {});
      throw err;
    }
  })();
  const out = await importDevArtifact(req.params.id, { ...input, tempPath: req.file.path, originalName: req.file.originalname });
  res.status(201).json(out);
}));

router.get('/:id/dev-artifacts/:artifactId', asyncHandler(async (req, res) => {
  res.json(await getDevArtifact(req.params.id, req.params.artifactId));
}));

router.get('/:id/dev-artifacts/:artifactId/file', asyncHandler(async (req, res) => {
  const { version } = validateRequest(musicVideoDevArtifactFileQuerySchema, req.query || {});
  const { path, mimeType } = await resolveDevArtifactDownload(req.params.id, req.params.artifactId, version ?? null);
  if (!existsSync(path)) throw new ServerError('The artifact file is not on this machine', { status: 404, code: 'DEV_ARTIFACT_FILE_MISSING' });
  const isHtml = mimeType === 'text/html';
  res.setHeader('Content-Security-Policy', isHtml ? DEV_ARTIFACT_HTML_CSP : DEV_ARTIFACT_MEDIA_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'private, no-cache');
  // Markdown is shown as text (a browser would otherwise download it).
  res.type(mimeType === 'text/markdown' ? 'text/plain; charset=utf-8' : (isHtml ? 'text/html; charset=utf-8' : mimeType));
  res.sendFile(path, { dotfiles: 'deny' });
}));

router.post('/:id/dev-artifacts/:artifactId/notes', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoDevArtifactNoteSchema, req.body || {});
  res.status(201).json(await addDevArtifactNote(req.params.id, req.params.artifactId, input));
}));

router.patch('/:id/dev-artifacts/:artifactId/notes/:noteId', asyncHandler(async (req, res) => {
  const { resolved } = validateRequest(musicVideoDevArtifactNoteUpdateSchema, req.body || {});
  res.json(await setDevArtifactNoteResolved(req.params.id, req.params.artifactId, req.params.noteId, resolved));
}));

router.post('/:id/dev-artifacts/:artifactId/review', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoDevArtifactReviewSchema, req.body || {});
  res.json(await reviewDevArtifact(req.params.id, req.params.artifactId, input));
}));

router.delete('/:id/dev-artifacts/:artifactId', asyncHandler(async (req, res) => {
  res.json(await removeDevArtifact(req.params.id, req.params.artifactId));
}));

export default router;
