/**
 * Composition document routes of the Music Video surface: import, generate, revise, accept, export and preview (#16097).
 * Mounted from musicVideo.js at the position of its first route so match order
 * against the remaining routes is unchanged.
 */

import { unlink } from 'fs/promises';
import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { musicVideoCodeGenerateSchema, musicVideoDocumentDirectoryImportSchema, musicVideoDocumentFileQuerySchema, musicVideoDocumentTemplateSchema, musicVideoDocumentCandidateSchema, musicVideoMixedMediaRegenerateSchema } from '../lib/musicVideo/musicVideoRouteValidation.js';
import { uploadSingle } from '../lib/multipart.js';
import { requireProject } from '../services/musicVideo/requireProject.js';
import { DOCUMENT_ZIP_MAX_BYTES, detachDocument, discardGeneratedDocument, documentMimeType, documentNativePlayback, exportDocumentZip, importDocumentDirectory, importDocumentTemplate, importDocumentZip, upgradeDocumentEngine, readDocumentManifest, resolveDocumentFile } from '../services/musicVideo/compositionDocument.js';
import { DIRECTOR_STARTED } from '../services/musicVideo/productionReview.js';
import { acceptMixedMediaDocument, generateMixedMediaDocument, readMixedMediaCandidate, regenerateMixedMediaSection, reviseMixedMediaEvents } from '../services/musicVideo/documentGeneration.js';
import { isZipUpload } from '../lib/zipStream.js';

const router = Router();

// --- Composition document (render style `document`) ---
// A project-owned HTML composition document (services/musicVideo/
// compositionDocument.js): import a zip, a folder inside data/, or the shipped
// template; export it; read its manifest; preview it. Files stay on this
// install; the record keeps a pointer to the current immutable version.
// A new document gets its overlay text checked in the background, so the
// findings are waiting at the storyboard approval (local browser work, no provider).
// The check renders the document in the headless composition browser. Finish
// loading before responding so this request owns the kickoff; the returned
// check remains background work. The deferred import is memoized because
// overlapping first loads can resolve past a test's module mock.
let overlayTextModule;

const checkOverlayTextAfterImport = async (projectId) => {
  await (overlayTextModule ??= import('../services/musicVideo/overlayTextService.js'))
    .then(({ checkOverlayTextInBackground }) => { checkOverlayTextInBackground(projectId); })
    .catch((err) => console.error(`❌ Overlay text check did not start: ${err.message}`));
};

const documentZipUpload = uploadSingle('file', {
  limits: { fileSize: DOCUMENT_ZIP_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (isZipUpload(file)) cb(null, true);
    else cb(new ServerError('Upload a .zip of the composition document', { status: 400, code: 'VALIDATION_ERROR' }));
  },
});

router.get('/:id/composition/document', asyncHandler(async (req, res) => {
  res.json(await readDocumentManifest(await requireProject(req.params.id)));
}));

router.post('/:id/composition/document/zip', documentZipUpload, asyncHandler(async (req, res) => {
  if (!req.file) throw new ServerError('No file uploaded (multipart field "file")', { status: 400, code: 'VALIDATION_ERROR' });
  try {
    const imported = await importDocumentZip(req.params.id, req.file.path, req.file.originalname);
    await checkOverlayTextAfterImport(req.params.id);
    res.status(201).json(imported);
  } finally {
    await unlink(req.file.path).catch(() => {});
  }
}));

router.post('/:id/composition/document/directory', asyncHandler(async (req, res) => {
  const { directory } = validateRequest(musicVideoDocumentDirectoryImportSchema, req.body || {});
  const imported = await importDocumentDirectory(req.params.id, directory);
  await checkOverlayTextAfterImport(req.params.id);
  res.status(201).json(imported);
}));

router.post('/:id/composition/document/template', asyncHandler(async (req, res) => {
  const { template } = validateRequest(musicVideoDocumentTemplateSchema, req.body || {});
  res.status(201).json(await importDocumentTemplate(req.params.id, template));
}));

// An explicit engine-only revision: no provider call or authored-code rewrite.
router.post('/:id/composition/document/engine/upgrade', asyncHandler(async (req, res) => {
  const { directory } = validateRequest(musicVideoDocumentCandidateSchema, req.body || {});
  res.json(await upgradeDocumentEngine(req.params.id, directory));
}));

router.post('/:id/composition/document/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(musicVideoCodeGenerateSchema, req.body || {});
  res.status(201).json(await generateMixedMediaDocument(req.params.id, { ...body, startedBy: DIRECTOR_STARTED }));
}));

router.get('/:id/composition/document/candidate', asyncHandler(async (req, res) => {
  res.json(await readMixedMediaCandidate(req.params.id));
}));

router.post('/:id/composition/document/events/revise', asyncHandler(async (req, res) => {
  const body = validateRequest(musicVideoMixedMediaRegenerateSchema, req.body || {});
  res.status(201).json(await reviseMixedMediaEvents(req.params.id, { ...body, startedBy: DIRECTOR_STARTED }));
}));

router.post('/:id/composition/document/sections/:sectionId/regenerate', asyncHandler(async (req, res) => {
  const body = validateRequest(musicVideoMixedMediaRegenerateSchema, req.body || {});
  res.status(201).json(await regenerateMixedMediaSection(req.params.id, req.params.sectionId, { ...body, startedBy: DIRECTOR_STARTED }));
}));

router.post('/:id/composition/document/accept', asyncHandler(async (req, res) => {
  const { directory } = validateRequest(musicVideoDocumentCandidateSchema, req.body || {});
  const accepted = await acceptMixedMediaDocument(req.params.id, directory);
  await checkOverlayTextAfterImport(req.params.id);
  res.json(accepted);
}));

router.delete('/:id/composition/document/candidate', asyncHandler(async (req, res) => {
  const { directory } = validateRequest(musicVideoDocumentCandidateSchema, req.body || {});
  res.json(await discardGeneratedDocument(req.params.id, directory));
}));

router.get('/:id/composition/document/export', asyncHandler(async (req, res) => {
  const { zip, filename } = await exportDocumentZip(await requireProject(req.params.id));
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(zip);
}));

// Whether the document is the unmodified shipped template, whose scenes may play in the page itself.
router.get('/:id/composition/document/playback', asyncHandler(async (req, res) => {
  res.json(await documentNativePlayback(await requireProject(req.params.id)));
}));

// One document file, for the preview's asset bridge (fetched by the PortOS
// page, never loaded by the sandboxed preview itself). Served inert: a
// sandbox CSP, no sniffing, same-origin only.
router.get('/:id/composition/document/file', asyncHandler(async (req, res) => {
  const { path, draft } = validateRequest(musicVideoDocumentFileQuerySchema, req.query || {});
  const project = await requireProject(req.params.id);
  const pointer = draft ? project.composition?.documentDraft : project.composition?.document;
  if (draft && !pointer) throw new ServerError('No composition candidate to preview', { status: 404, code: 'NOT_FOUND' });
  const abs = await resolveDocumentFile(draft ? { ...project, composition: { ...project.composition, document: pointer } } : project, path);
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'private, no-cache');
  res.type(documentMimeType(path));
  res.sendFile(abs, { dotfiles: 'allow' });
}));

router.delete('/:id/composition/document', asyncHandler(async (req, res) => {
  await requireProject(req.params.id);
  res.json(await detachDocument(req.params.id));
}));

export default router;
