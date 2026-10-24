import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from '../../lib/paths.js';
import { isPathInsideDir } from '../../lib/pathSafety.js';
import { FABLELOOM_EXPORT_LIMITS } from '../../lib/fableLoomExport.js';
import { ServerError } from '../../lib/errorHandler.js';

const refusal = (code, message) => new ServerError(message, { status: 422, code });
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const AUDIO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(wav|mp3|flac|ogg|m4a)$/i;

/**
 * Snapshot one approved voice-reference basename. The resolved source directory
 * has to stay inside the voice library, and the file inside that directory.
 * Callers receive bytes only.
 */
export async function readFableLoomVoiceReference(profileId, filename) {
  if (!PROFILE_ID.test(profileId || '') || !AUDIO_NAME.test(filename || '')) {
    throw refusal('EXPORT_VOICE_REFERENCE_INVALID', 'Approved voice reference must be a managed audio basename.');
  }
  let library;
  try {
    library = await realpath(PATHS.voiceProfiles);
  } catch {
    throw refusal('EXPORT_VOICE_REFERENCE_MISSING', 'Approved voice reference audio is not in the managed voice library.');
  }
  let root;
  try {
    root = await realpath(join(library, profileId, 'source'));
  } catch {
    throw refusal('EXPORT_VOICE_REFERENCE_MISSING', 'Approved voice reference audio is not in the managed voice library.');
  }
  // The profile source directory is the trust anchor. A symlink that leaves
  // the voice library must not become that anchor.
  if (!isPathInsideDir(library, root)) {
    throw refusal('EXPORT_VOICE_REFERENCE_INVALID', 'Approved voice reference resolves outside its profile library.');
  }
  let path;
  try {
    path = await realpath(join(root, filename));
  } catch {
    throw refusal('EXPORT_VOICE_REFERENCE_MISSING', 'Approved voice reference audio is not in the managed voice library.');
  }
  if (!isPathInsideDir(root, path)) {
    throw refusal('EXPORT_VOICE_REFERENCE_INVALID', 'Approved voice reference resolves outside its profile library.');
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > FABLELOOM_EXPORT_LIMITS.maxAssetBytes) {
      throw refusal('EXPORT_VOICE_REFERENCE_INVALID', 'Approved voice reference is empty, not a regular file, or exceeds the 64 MiB asset limit.');
    }
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw refusal('EXPORT_VOICE_REFERENCE_INVALID', 'Approved voice reference changed while taking the export snapshot. Start a new export.');
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
