import { Router } from 'express';
import { createReadStream, existsSync, statSync } from 'fs';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';

const router = Router();

const MODEL_PATH = join(PATHS.data, 'avatar', 'model.glb');

// HEAD /api/avatar/model.glb — probe whether a user-supplied model is configured.
// 200 if present, 404 otherwise. No body.
router.head('/model.glb', (req, res) => {
  if (!existsSync(MODEL_PATH)) {
    console.log(`🎭 avatar HEAD ${MODEL_PATH} — 404 (no model configured)`);
    return res.status(404).end();
  }
  const { size } = statSync(MODEL_PATH);
  res.set({
    'Content-Type': 'model/gltf-binary',
    'Content-Length': size,
    'Cache-Control': 'no-cache'
  });
  res.status(200).end();
});

// GET /api/avatar/model.glb — stream the user-supplied rigged avatar if present.
router.get('/model.glb', (req, res) => {
  if (!existsSync(MODEL_PATH)) {
    console.log(`🎭 avatar GET ${MODEL_PATH} — 404 (no model configured)`);
    return res.status(404).json({ error: 'avatar model not configured' });
  }
  const { size } = statSync(MODEL_PATH);
  console.log(`🎭 avatar GET streaming ${size} bytes from ${MODEL_PATH}`);
  res.set({
    'Content-Type': 'model/gltf-binary',
    'Content-Length': size,
    'Cache-Control': 'no-cache'
  });
  createReadStream(MODEL_PATH).pipe(res);
});

export default router;
