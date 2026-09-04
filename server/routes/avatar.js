import { Router } from 'express';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import { PATHS, pathExists } from '../lib/fileUtils.js';
import {
  AVATAR_VARIANT_PATTERN,
  RIGGED_VARIANT_PREFIX,
  isAnimatedRecordReady,
  parseRiggedVariant,
  riggedVariantForId,
} from '../lib/avatarVariants.js';
import { ServerError, getErrorCode } from '../lib/errorHandler.js';
import { buildClipCoverage } from '../services/rigging/clipCapabilities.js';
import { retargetRunPaths } from '../services/rigging/retarget.js';
import { getModel, listModels } from '../services/imageTo3d/db.js';

const router = Router();
const AVATAR_DIR = join(PATHS.data, 'avatar');
const AVATAR_PATH = join(AVATAR_DIR, 'model.glb');

// Resolve a requested variant filename to an absolute path inside AVATAR_DIR.
// Only [a-z0-9-] basenames are allowed (no slashes, no dots, no traversal),
// and the .glb extension is appended server-side — so a malicious `?variant`
// can never escape the avatar directory.
function resolveVariant(variant) {
  if (!variant || typeof variant !== 'string') return AVATAR_PATH;
  if (!AVATAR_VARIANT_PATTERN.test(variant)) return null;
  return join(AVATAR_DIR, `${variant}.glb`);
}

// Resolve a `rigged-<modelId>` spelling to the record's published animated GLB
// (#5894). The id passed the shared charset guard in `parseRiggedVariant`, so
// the joins below cannot escape the record dir; the retarget id comes from the
// stored record (not the request) and is re-checked for the same reason. Only
// a record whose retarget verified at publish time resolves — anything else
// (unknown id, rig-only, failed, in-flight) is a 404, never a half-animated file.
async function resolveRiggedVariant(variant) {
  const modelId = parseRiggedVariant(variant);
  if (!modelId) return null;
  const record = await getModel(modelId);
  if (!isAnimatedRecordReady(record)) return null;
  const { retargetId } = record.retarget;
  if (!AVATAR_VARIANT_PATTERN.test(retargetId)) return null;
  return retargetRunPaths({ recordDir: join(PATHS.imageTo3d, modelId), retargetId }).publishedGlb;
}

// Resolve any `?variant=` to an absolute GLB path, or null when unresolvable.
// Rigged spellings are checked FIRST: `rigged-<id>` also satisfies the file
// charset, so falling through to the file branch would 404 a selectable
// record against a filename that was never meant to exist.
async function resolveAvatarPath(variant) {
  if (typeof variant === 'string' && variant.startsWith(RIGGED_VARIANT_PREFIX)) {
    return resolveRiggedVariant(variant);
  }
  return resolveVariant(variant);
}

const isRiggedSpelling = (variant) => typeof variant === 'string' && variant.startsWith(RIGGED_VARIANT_PREFIX);

router.head('/model.glb', async (req, res) => {
  const path = await resolveAvatarPath(req.query.variant);
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
  const path = await resolveAvatarPath(req.query.variant);
  if (!path || !(await pathExists(path))) {
    if (isRiggedSpelling(req.query.variant)) {
      throw new ServerError('That animated character is not available. Rig and animate the record first.', { status: 404 });
    }
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

// One selector entry for a ready animated record: the `?variant=` spelling
// that selects it, the avatar-route URL that serves it (variant-guarded and
// HEAD-probeable, unlike the raw `/data` mount), the retargeted clip name, and
// the server-computed CoS-state coverage so selectors can show what the
// character covers without re-deriving the vocabulary client-side.
const riggedAvatarEntry = (record) => {
  const variant = riggedVariantForId(record.id);
  const clip = typeof record?.retarget?.clip === 'string' && record.retarget.clip ? record.retarget.clip : null;
  return {
    id: record.id,
    name: record.name || record.id,
    variant,
    assetUrl: variant ? `/api/avatar/model.glb?variant=${encodeURIComponent(variant)}` : null,
    clip,
    coverage: buildClipCoverage(clip ? [clip] : []),
  };
};

// The animated records the avatar selectors may offer. Read-only: a DB list
// filtered to verified retargets, each carrying its coverage — an empty list
// (no records, none animated yet) is the normal fresh-install answer, not an error.
router.get('/rigged', async (_req, res) => {
  const records = await listModels();
  const ready = records.filter(isAnimatedRecordReady).map(riggedAvatarEntry).filter((entry) => entry.variant);
  res.json({ records: ready });
});

export default router;
