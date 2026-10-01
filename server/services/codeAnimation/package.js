import { ServerError } from '../../lib/errorHandler.js';
import { createCodeAnimationPackage, CODE_ANIMATION_PACKAGE_LIMITS } from '../../lib/codeAnimationPackage.js';
import { getCodeAnimationJobRecord, readCodeAnimationHtml } from './jobStore.js';

/** Export explicit portable fields only; never copy a job record or its prompt. */
export async function exportCodeAnimationPackage(id) {
  const job = await getCodeAnimationJobRecord(id);
  if (!job) throw new ServerError('Generation job not found', { status: 404, code: 'NOT_FOUND' });
  if (job.status !== 'completed') {
    throw new ServerError('Only completed animations have a source package', { status: 409, code: 'CODE_ANIMATION_NOT_COMPLETED' });
  }
  const html = await readCodeAnimationHtml(id);
  if (Buffer.byteLength(html) > CODE_ANIMATION_PACKAGE_LIMITS.fileBytes) {
    throw new ServerError('This source exceeds the package file limit; use Download HTML instead', {
      status: 422, code: 'CODE_ANIMATION_PACKAGE_TOO_LARGE',
    });
  }
  const input = job.input || {};
  return createCodeAnimationPackage({
    title: job.title || '',
    brief: { concept: input.concept || '', cast: input.cast || '', onScreenText: input.onScreenText || '' },
    styleGuide: input.styleNotes || '',
    renderer: { kind: 'browser', version: 'code-animation-html-v1', engine: input.renderer || 'auto' },
    format: {
      width: job.frame?.width, height: job.frame?.height,
      fps: job.frame?.fps, durationSeconds: job.frame?.durationSeconds,
    },
    seed: null,
    entrypoints: [{ role: 'preview', path: 'index.html' }],
    assets: [], shots: [], events: [],
    audio: job.audioUrl || input.audio
      ? { kind: 'external', notes: 'The selected audio is not included in this package.' }
      : input.soundtrack === 'procedural'
        ? { kind: 'procedural', notes: 'Live Web Audio in the HTML; no offline soundtrack is included.' }
        : { kind: 'silence' },
    // Legacy jobs do not capture the full effective harness/connection/mode.
    // Unknown provenance stays null; local provider ids never leave the install.
    execution: { requested: null, effective: null },
  }, [{ path: 'index.html', content: html }]);
}
