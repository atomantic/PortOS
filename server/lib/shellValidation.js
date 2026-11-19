/**
 * Zod schema for the shell image-drop route.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';

// POST /api/shell/sessions/:sessionId/image — hand a photo to whatever is running
// in a shell session. `data` is base64 image bytes; the real ceiling is enforced
// by `saveImageUpload` (MAX_SCREENSHOT_BYTES) against the DECODED buffer, so the
// cap here only refuses a payload too large to be worth decoding. The message cap
// matches the BTW route's — both end up bracket-pasted into the same TUI prompt.
export const shellImageDropSchema = z.object({
  data: z.string().min(1, 'data is required (base64)').max(64 * 1024 * 1024),
  filename: z.string().min(1, 'filename is required').max(255),
  message: z.string().max(5000).optional()
});
