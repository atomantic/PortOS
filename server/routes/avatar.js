import { Router } from 'express';
import { existsSync, statSync, createReadStream } from 'fs';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';

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

// Non-throwing stat wrapper used by the HEAD handler — file may be removed between
// existsSync() and statSync() (TOCTOU), which would otherwise crash the process.
function safeStat(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

router.head('/model.glb', (req, res) => {
  const path = resolveVariant(req.query.variant);
  if (!path || !existsSync(path)) {
    return res.status(404).end();
  }
  const s = safeStat(path);
  if (!s) return res.status(404).end();
  res.set('Content-Type', 'model/gltf-binary');
  res.set('Content-Length', String(s.size));
  res.set('Cache-Control', 'public, max-age=60');
  return res.status(200).end();
});

router.get('/model.glb', (req, res) => {
  const path = resolveVariant(req.query.variant);
  if (!path || !existsSync(path)) {
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
      res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: 'Avatar model unavailable' });
    } else {
      res.destroy(err);
    }
  });
  stream.pipe(res);
});

export default router;
