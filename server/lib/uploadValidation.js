/**
 * Zod schemas for the base64 upload, attachment upload and screenshot upload routes.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { nonEmptyString, nullishString } from './sharedSchemas.js';

// POST /api/uploads and POST /api/attachments. The shared upload helper
// enforces decoded-byte limits and extension allowlists; this schema bounds
// the JSON shape before the helper receives it.
const base64FileUploadSchema = z.object({
  data: z.string().trim().min(1, 'data is required (base64)').max(64 * 1024 * 1024),
  // The upload helper prefixes the sanitized name with a 9-byte UUID marker.
  filename: z.string().min(1, 'filename is required').max(246),
});

export const uploadRequestSchema = base64FileUploadSchema;
export const attachmentUploadRequestSchema = base64FileUploadSchema;

export const screenshotUploadBodySchema = z.object({ data: nonEmptyString, filename: nullishString });
