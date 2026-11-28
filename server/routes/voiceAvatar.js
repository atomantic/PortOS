// Host-control endpoints for the optional local Voice Call avatar, its frame stream, and the
// avatar library (the shared Avatars collection plus this install's channel assignments).
import express, { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { getAvatarStatus, manageAvatar, renderAvatar, renderAvatarIdle } from '../services/voice/avatarRuntime.js';
import { MAX_AVATAR_WAV_BYTES } from '../lib/uploadLimits.js';
import {
  voiceAvatarAddSchema, voiceAvatarChannelsSchema, voiceAvatarCommandSchema, voiceAvatarFilenameParamsSchema,
  voiceAvatarIdleSchema, voiceAvatarWaveSchema,
} from '../lib/voiceValidation.js';
import { emptyQuerySchema } from '../lib/queryValidation.js';
import { addAvatar, getAvatarLibrary, removeAvatar, updateAvatarChannels } from '../services/voice/avatarLibrary.js';
import { avatarError } from '../services/voice/avatarWorker.js';

function streamFrames(res, run) {
  const stop = new AbortController();
  const close = () => stop.abort();
  res.once('close', close);
  const onFrame = (frame) => {
    if (!res.headersSent) res.set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    // Rendering must never delay voice playback or buffer unbounded frames for a slow client.
    if (!res.write(JSON.stringify(frame) + '\n') && res.writableLength > 512 * 1024) {
      stop.abort();
      res.end();
    }
  };
  return run({ onFrame, signal: stop.signal }).then(() => {
    if (!res.destroyed && !res.writableEnded) res.end();
  }, (error) => {
    if (!res.headersSent && !stop.signal.aborted) throw error;
    if (!res.destroyed && !res.writableEnded) res.end();
  }).finally(() => {
    res.off('close', close);
  });
}

const router = Router();
router.get('/status', asyncHandler(async (_req, res) => { res.json(await getAvatarStatus()); }));
router.post('/runtime', asyncHandler(async (req, res) => {
  const { action, acceptTerms } = validateRequest(voiceAvatarCommandSchema, req.body);
  if (['install', 'update'].includes(action) && !acceptTerms) {
    throw avatarError('Accept the checkpoint terms before downloading the model.', 400);
  }
  res.json(await manageAvatar(action));
}));
router.get('/library', asyncHandler(async (req, res) => {
  validateRequest(emptyQuerySchema, req.query);
  res.json(await getAvatarLibrary());
}));
router.post('/library', asyncHandler(async (req, res) => {
  validateRequest(emptyQuerySchema, req.query);
  const { filename } = validateRequest(voiceAvatarAddSchema, req.body);
  res.json(await addAvatar(filename));
}));
router.delete('/library/:filename', asyncHandler(async (req, res) => {
  validateRequest(emptyQuerySchema, req.query);
  const { filename } = validateRequest(voiceAvatarFilenameParamsSchema, req.params);
  res.json(await removeAvatar(filename));
}));
router.put('/channels', asyncHandler(async (req, res) => {
  validateRequest(emptyQuerySchema, req.query);
  res.json(await updateAvatarChannels(validateRequest(voiceAvatarChannelsSchema, req.body)));
}));
router.post('/frames', express.raw({ type: 'audio/wav', limit: MAX_AVATAR_WAV_BYTES, inflate: false }), asyncHandler(async (req, res) => {
  const wav = validateRequest(voiceAvatarWaveSchema, req.body);
  await streamFrames(res, options => renderAvatar(wav, options));
}));
router.post('/idle', asyncHandler(async (req, res) => {
  const { stage } = validateRequest(voiceAvatarIdleSchema, req.body ?? {});
  await streamFrames(res, options => renderAvatarIdle({ ...options, stage }));
}));

export default router;
