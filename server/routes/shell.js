/**
 * Shell session HTTP routes.
 *
 * The Shell page drives its PTY over Socket.IO (`shell:input` / `shell:output` /
 * `shell:attach` — a keystroke stream and a fan-out, which is what sockets are
 * for). This module is for the shell operations that are one-shot REQUESTS with a
 * result and a payload too big for a socket frame — currently just handing a photo
 * to whatever is running in a session, which is the same shape as
 * `POST /api/cos/agents/:id/btw` and gets the same treatment: Zod validation,
 * `asyncHandler`, and ServerErrors bubbling to the centralized middleware.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { dropImageIntoShellSession } from '../services/shellImageDrop.js';
import { shellImageDropSchema } from '../lib/shellValidation.js';

const router = Router();

// POST /api/shell/sessions/:sessionId/image — save a photo and paste its path
// (plus an optional message) into the session, so a running agent can read it.
router.post('/sessions/:sessionId/image', asyncHandler(async (req, res) => {
  const { data, filename, message } = validateRequest(shellImageDropSchema, req.body ?? {});
  // The service throws a ServerError — 404 when the session is gone, 400 when the
  // bytes are oversized or not a supported image — so no result-shape mapping here.
  const result = await dropImageIntoShellSession({
    sessionId: req.params.sessionId,
    filename,
    data,
    message,
  });
  res.json(result);
}));

export default router;
