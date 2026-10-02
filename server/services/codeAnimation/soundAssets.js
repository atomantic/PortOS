/** Copy validated upload/library bytes into a new portable source candidate. */
import { constants } from 'fs';
import { open } from 'fs/promises';
import { extname } from 'path';
import { z } from 'zod';
import { PATHS } from '../../lib/paths.js';
import { makePathResolver } from '../../lib/pathSafety.js';
import { UPLOAD_AUDIO_EXTENSIONS } from '../../lib/mimeTypes.js';
import { createCodeAnimationPackage, CODE_ANIMATION_PACKAGE_LIMITS } from '../../lib/codeAnimationPackage.js';
import { validateRequest } from '../../lib/validation.js';
import { ServerError } from '../../lib/errorHandler.js';
import { SUPPORTED_AUDIO_EXTENSIONS, statMusicTrack } from '../pipeline/musicLibrary.js';
import { exportProductionPackage, importProductionPackage } from './projects.js';

export const soundAssetSchema = z.object({
  revisionId: z.string().uuid(), source: z.enum(['upload', 'library']),
  filename: z.string().min(1).max(256).regex(/^[^/\\]+$/),
}).strict();
const upload = makePathResolver(() => PATHS.uploads, { extensions: UPLOAD_AUDIO_EXTENSIONS });
const library = makePathResolver(() => PATHS.music, { extensions: SUPPORTED_AUDIO_EXTENSIONS });

export async function stageProductionSoundAsset(projectId, input) {
  const request = validateRequest(soundAssetSchema, input);
  const pkg = await exportProductionPackage(projectId, request.revisionId);
  if (request.source === 'library' && !await statMusicTrack(request.filename)) {
    throw new ServerError('Library sound is missing', { status: 404, code: 'AUDIO_NOT_FOUND' });
  }
  const path = (request.source === 'upload' ? upload : library)(request.filename);
  if (!path) throw new ServerError('Sound asset is missing or unsupported', { status: 404, code: 'AUDIO_NOT_FOUND' });
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > CODE_ANIMATION_PACKAGE_LIMITS.fileBytes) {
      throw new ServerError('Sound asset exceeds the portable package file limit', { status: 400, code: 'CODE_ANIMATION_AUDIO_SIZE' });
    }
    // Read at most the package limit even if another upload grows the file.
    bytes = Buffer.alloc(info.size);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== bytes.length) throw new ServerError('Sound asset changed while staging', { status: 409, code: 'CODE_ANIMATION_AUDIO_CHANGED' });
  } finally { await handle.close(); }
  const target = `audio/soundtrack${extname(request.filename).toLowerCase()}`;
  const files = pkg.files.filter(file => file.path !== target);
  files.push({ path: target, content: bytes.toString('base64'), encoding: 'base64' });
  return importProductionPackage(projectId, createCodeAnimationPackage({ ...pkg.manifest,
    audio: { kind: 'file', path: target }, assets: [...new Set([...pkg.manifest.assets, target])],
  }, files));
}
