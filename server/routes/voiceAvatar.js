// Host-control endpoints for the optional local Voice Call avatar and its frame stream.
import express, { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { getAvatarStatus, manageAvatar, renderAvatar } from '../services/voice/avatarRuntime.js';
import { MAX_AVATAR_WAV_BYTES } from '../lib/uploadLimits.js';
import { voiceAvatarCommandSchema, voiceAvatarWaveSchema } from '../lib/voiceValidation.js';
import { avatarError } from '../services/voice/avatarWorker.js';

const router = Router();
router.get('/status', asyncHandler(async (_req, res) => { res.json(await getAvatarStatus()); }));
router.post('/runtime', asyncHandler(async (req, res) => {
  const { action, acceptTerms } = validateRequest(voiceAvatarCommandSchema, req.body);
  if (['install', 'update'].includes(action) && !acceptTerms) {
    throw avatarError('Accept the checkpoint terms before downloading the model.', 400);
  }
  res.json(await manageAvatar(action));
}));
router.post('/frames', express.raw({ type: 'audio/wav', limit: MAX_AVATAR_WAV_BYTES, inflate: false }), asyncHandler(async (req, res) => {
  const wav = validateRequest(voiceAvatarWaveSchema, req.body);
  const stop = new AbortController();
  const close = () => stop.abort();
  res.once('close', close);
  try {
    const onFrame = (frame) => {
      if (!res.headersSent) res.set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      // Rendering must never delay voice playback or buffer unbounded frames for a slow client.
      if (!res.write(JSON.stringify(frame) + '\n') && res.writableLength > 512 * 1024) {
        stop.abort();
        res.end();
      }
    };
    await renderAvatar(wav, { onFrame, signal: stop.signal });
    if (!res.destroyed && !res.writableEnded) res.end();
  } catch (error) {
    if (!res.headersSent && !stop.signal.aborted) throw error;
    if (!res.destroyed && !res.writableEnded) res.end();
  } finally {
    res.off('close', close);
  }
}));

export default router;
