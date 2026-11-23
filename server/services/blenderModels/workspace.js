/**
 * A Blender model's workspace on this install:
 *
 *   data/blender-models/<id>/
 *     src/                authored model code (durable, backed up); entry point src/model.py
 *     builds/<buildId>/   one build's outputs, never rewritten: model.blend, model.glb,
 *                         report.json, build.log (backed up; pruned to the published
 *                         build and the newest five)
 *     renders/            regenerable previews (excluded from backups)
 *
 * Every path a request names is rebuilt from validated segments and re-checked
 * to sit inside the workspace with no symlink on the way (the shared
 * ../blenderWorkspace/containment.js). Path math and `lstat` only.
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathWithin } from '../../../lib/pathWithin.js';
import { PATHS } from '../../lib/paths.js';
import { assertInsideWithoutSymlinks, blenderRefusal } from '../blenderWorkspace/containment.js';

export const BLENDER_MODEL_ID = /^bmodel-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const BLENDER_MODEL_BUILD_ID = /^build-\d{8}T\d{6}Z-[0-9a-f]{8}$/;

/** The files a build leaves, with the media type each is served as. */
export const BLENDER_MODEL_BUILD_FILES = Object.freeze({
  'model.glb': 'model/gltf-binary',
  'model.blend': 'application/x-blender',
  'report.json': 'application/json; charset=utf-8',
  'build.log': 'text/plain; charset=utf-8',
});

export function assertBlenderModelId(id) {
  if (typeof id !== 'string' || !BLENDER_MODEL_ID.test(id)) throw blenderRefusal('Blender model not found', 'NOT_FOUND', 404);
  return id;
}

export function assertBlenderModelBuildId(buildId) {
  if (typeof buildId !== 'string' || !BLENDER_MODEL_BUILD_ID.test(buildId)) throw blenderRefusal('Build not found', 'NOT_FOUND', 404);
  return buildId;
}

export const blenderModelWorkspaceDir = (id) => pathWithin(PATHS.blenderModels, assertBlenderModelId(id));
export const blenderModelSrcDir = (id) => join(blenderModelWorkspaceDir(id), 'src');
export const blenderModelBuildsDir = (id) => join(blenderModelWorkspaceDir(id), 'builds');
export const blenderModelRendersDir = (id) => join(blenderModelWorkspaceDir(id), 'renders');
export const blenderModelBuildDir = (id, buildId) => join(blenderModelBuildsDir(id), assertBlenderModelBuildId(buildId));

/** The `{ workspace, src }` pair the shared source-tree helpers take. */
export const blenderModelSourceDirs = (id) => ({ workspace: blenderModelWorkspaceDir(id), src: blenderModelSrcDir(id) });

/** A sortable build id: UTC start second plus a random suffix. */
export const newBlenderModelBuildId = (now = new Date(), suffix = Math.floor(Math.random() * 0x100000000)) =>
  `build-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${suffix.toString(16).padStart(8, '0')}`;

/** One regular file a build left (`name` from BLENDER_MODEL_BUILD_FILES): `{ absolute, type }`, 404 otherwise. */
export async function resolveBlenderModelBuildFile(id, buildId, name) {
  const type = BLENDER_MODEL_BUILD_FILES[name];
  if (!type) throw blenderRefusal('That build file is not on this machine', 'NOT_FOUND', 404);
  const absolute = join(blenderModelBuildDir(id, buildId), name);
  await assertInsideWithoutSymlinks(blenderModelWorkspaceDir(id), absolute);
  const info = await lstat(absolute).catch(() => null);
  if (!info?.isFile()) throw blenderRefusal('That build file is not on this machine', 'NOT_FOUND', 404);
  return { absolute, type, bytes: info.size };
}
