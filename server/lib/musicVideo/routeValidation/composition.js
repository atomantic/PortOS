/** Request schemas for Music Video composition document import, generation, and preview. */

import { z } from 'zod';
import { MUSIC_VIDEO_DOCUMENT_DIRECTORY, MUSIC_VIDEO_DOCUMENT_TEMPLATES } from '../musicVideoValidation.js';
import { musicVideoCodeGenerateSchema } from './shared.js';

export { musicVideoCodeGenerateSchema };

// A relative folder inside data/ to copy a composition document from.
export const musicVideoDocumentDirectoryImportSchema = z.object({
  directory: z.string().min(1).max(1024).refine((value) => !value.startsWith('/') && !value.includes('\\') && !value.includes(':')
    && !value.includes('\0') && !value.split('/').some((part) => part === '..' || part === '.' || !part), 'directory must be a relative path inside data'),
}).strict();

export const musicVideoDocumentFileQuerySchema = z.object({
  path: z.string().min(1).max(512),
  draft: z.literal('1').optional(),
}).strict();

export const musicVideoDocumentCandidateSchema = z.object({
  directory: z.string().regex(MUSIC_VIDEO_DOCUMENT_DIRECTORY),
}).strict();

export const musicVideoMixedMediaRegenerateSchema = musicVideoCodeGenerateSchema.extend({
  expectedDraft: z.string().regex(MUSIC_VIDEO_DOCUMENT_DIRECTORY),
}).strict();

export const musicVideoDocumentTemplateSchema = z.object({
  template: z.enum(MUSIC_VIDEO_DOCUMENT_TEMPLATES).optional(),
}).strict();
