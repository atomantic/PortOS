import { Router } from 'express';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import { PATHS, pathExists } from '../lib/fileUtils.js';
import { ServerError, getErrorCode } from '../lib/errorHandler.js';

const router = Router();
const AVATAR_DIR = join(PATHS.data, 'avatar');
const AVATAR_PATH = join(AVATAR_DIR, 'model.glb');

// Resolve a requested variant filename to an absolute path inside AVATAR_DIR.
// Only [a-z0-9-] basenames are allowed (no slashes, no dots, no traversal),
// and the .glb extension is appended server-side — so a malicious `?variant`
// can never escape the avatar directory.
function resolveVariant(variant) {
  if (!variant || typeof variant !== 'string') return AVATAR_PATH;
  if (!/^[a-z0-9-]+$/.test(variant)) return null;
  return join(AVATAR_DIR, `${variant}.glb`);
}

router.head('/model.glb', async (req, res) => {
  const path = resolveVariant(req.query.variant);
  if (!path) return res.status(404).end();
  // Single async stat off the event loop, doubling as the existence check —
  // a missing/removed file (TOCTOU) just resolves null → 404.
  const s = await stat(path).catch(() => null);
  if (!s) return res.status(404).end();
  res.set('Content-Type', 'model/gltf-binary');
  res.set('Content-Length', String(s.size));
  res.set('Cache-Control', 'public, max-age=60');
  return res.status(200).end();
});

router.get('/model.glb', async (req, res) => {
  const path = resolveVariant(req.query.variant);
  if (!path || !(await pathExists(path))) {
    throw new ServerError('No avatar model configured. Drop a GLB at data/avatar/model.glb', { status: 404 });
  }
  res.set('Content-Type', 'model/gltf-binary');
  res.set('Cache-Control', 'public, max-age=60');
  // Guard against TOCTOU: if the file is removed between existsSync() and
  // createReadStream(), the stream emits 'error' — handle it instead of crashing.
  const stream = createReadStream(path);
  stream.on('error', (err) => {
    console.warn(`⚠️ Avatar stream error: ${err.code || err.message}`);
    if (!res.headersSent) {
      // The stream 'error' fires outside the asyncHandler promise chain, so a
      // throw here would crash the process instead of bubbling to
      // errorMiddleware. Emit the SAME { error, code, timestamp } envelope
      // errorMiddleware stamps everywhere else so clients see a consistent shape.
      const status = err.code === 'ENOENT' ? 404 : 500;
      res.status(status).json({
        error: 'Avatar model unavailable',
        code: getErrorCode(status),
        timestamp: Date.now()
      });
    } else {
      res.destroy(err);
    }
  });
  stream.pipe(res);
});

export default router;
