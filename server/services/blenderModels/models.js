/**
 * Blender models: operator-authored Blender Python that builds one model into
 * checked, versioned GLB builds (issue #17874). Records, the workspace source,
 * publishing a build, serving its files and opening it in Blender. Builds
 * themselves run in build.js. Explicit actions only; no provider calls.
 *
 * Storage: `db-primary` (`blender_models`, see store.js) for the record and
 * `asset-file-db-indexed` for data/blender-models/<id>/: `src/` is durable
 * authored code and backed up, `builds/` holds immutable outputs (backed up,
 * pruned), `renders/` is regenerable and excluded from backups. Machine-local.
 */
import { copyFile, lstat, mkdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchDetached } from '../../lib/launchDetached.js';
import { assertInsideWithoutSymlinks, blenderRefusal } from '../blenderWorkspace/containment.js';
import {
  deleteSourceFile, presentSourceFiles, readSourceText, resolveSourceFile, walkSourceTree, writeSourceText,
} from '../blenderWorkspace/sourceTree.js';
import { hashSourceEntries } from '../blenderWorkspace/treeHash.js';
import { BLENDER_MODEL_NEEDS_TRUSTED_LOCAL } from './driver.js';
import { presentBlenderModelReferences } from './references.js';
import { listBlenderModelJobs, pruneBlenderModelBuilds, settleBlenderModelBuilds } from './build.js';
import * as store from './store.js';
import {
  assertBlenderModelId, blenderModelBuildsDir, blenderModelRendersDir, blenderModelSourceDirs,
  blenderModelSrcDir, blenderModelWorkspaceDir, resolveBlenderModelBuildFile,
} from './workspace.js';

const STARTER_MODEL = fileURLToPath(new URL('./py/starter/model.py', import.meta.url));

export async function requireBlenderModel(id) {
  assertBlenderModelId(id);
  const model = await store.getModel(id);
  if (!model) throw blenderRefusal('Blender model not found', 'NOT_FOUND', 404);
  return model;
}

/** `{ ready, reason, executionMode, version }` from the Blender execution lane's last check. */
async function blenderToolState() {
  const { getCodeAnimationExecution } = await import('../codeAnimation/execution.js');
  const execution = await getCodeAnimationExecution();
  const trusted = execution.executionMode === 'trusted-local';
  const lane = execution.lanes.blender;
  return {
    ready: trusted && lane.ready === true,
    reason: trusted ? lane.reason || null : BLENDER_MODEL_NEEDS_TRUSTED_LOCAL,
    executionMode: execution.executionMode,
    version: execution.probe?.tools?.blender?.version || null,
  };
}

/** A record with what this machine holds for it: the workspace, the tool and the build jobs. */
export async function getBlenderModelState(id) {
  const model = await requireBlenderModel(id);
  const entries = await walkSourceTree(blenderModelSrcDir(id));
  const { tree } = await hashSourceEntries(entries);
  const latest = [...(model.builds || [])].reverse().find((build) => build.status === 'complete') ?? null;
  return {
    ...model,
    ...await presentBlenderModelReferences(model),
    workspace: {
      path: blenderModelWorkspaceDir(id),
      exists: (await lstat(blenderModelWorkspaceDir(id)).catch(() => null))?.isDirectory() === true,
      hasModel: entries.some((entry) => entry.path === 'model.py'),
      hasPartsBrief: entries.some((entry) => entry.path === 'PARTS.md'),
      files: entries.length,
      srcHash: tree,
      // Whether the source moved on since the newest completed build.
      srcChanged: latest ? latest.srcHash !== tree : null,
    },
    tool: await blenderToolState(),
    jobs: listBlenderModelJobs(id),
  };
}

/** Live models, plus whether this machine can build one. */
export async function listBlenderModels() {
  const [models, tool] = await Promise.all([store.listModels(), blenderToolState()]);
  return { models, tool };
}

export const createBlenderModel = ({ name, description }) => store.createModel({ name, description });

/** Change the name and/or the one-line description; an absent key stays as it is. */
export async function updateBlenderModel(id, patch) {
  await requireBlenderModel(id);
  await store.mutateModel(id, (current) => {
    const next = { ...current, name: patch.name ?? current.name, description: patch.description ?? current.description ?? '' };
    return next.name === current.name && next.description === (current.description ?? '') ? null : next;
  });
  return getBlenderModelState(id);
}

/**
 * Soft-delete the record, then remove its builds and renders once any running
 * build has settled. The authored src/ stays on disk.
 */
export async function deleteBlenderModel(id) {
  await requireBlenderModel(id);
  await settleBlenderModelBuilds(id);
  const now = new Date().toISOString();
  await store.mutateModel(id, (current) => ({ ...current, deleted: true, deletedAt: now }));
  for (const dir of [blenderModelBuildsDir(id), blenderModelRendersDir(id)]) {
    await assertInsideWithoutSymlinks(blenderModelWorkspaceDir(id), dir);
    await rm(dir, { recursive: true, force: true });
  }
  return { ok: true };
}

/** Copy the shipped starter model into src/; refuses once src/model.py exists. */
export async function scaffoldBlenderModelWorkspace(id) {
  await requireBlenderModel(id);
  const { absolute } = await resolveSourceFile(blenderModelSourceDirs(id), 'model.py');
  await mkdir(blenderModelSrcDir(id), { recursive: true });
  const placed = await copyFile(STARTER_MODEL, absolute, constants.COPYFILE_EXCL).then(() => true, (error) => {
    if (error.code === 'EEXIST') return false;
    throw error;
  });
  if (!placed) {
    throw blenderRefusal('This model already has src/model.py. Edit it, or delete it to start again from the starter.', 'BLENDER_MODEL_WORKSPACE_EXISTS', 409);
  }
  store.announceBlenderModel(id);
  return getBlenderModelState(id);
}

export async function listBlenderModelFiles(id) {
  await requireBlenderModel(id);
  return presentSourceFiles(await walkSourceTree(blenderModelSrcDir(id)));
}

export async function readBlenderModelFile(id, path) {
  await requireBlenderModel(id);
  return readSourceText(blenderModelSourceDirs(id), path);
}

export async function writeBlenderModelFile(id, path, content) {
  await requireBlenderModel(id);
  const written = await writeSourceText(blenderModelSourceDirs(id), path, content);
  store.announceBlenderModel(id);
  return written;
}

export async function deleteBlenderModelFile(id, path) {
  await requireBlenderModel(id);
  const removed = await deleteSourceFile(blenderModelSourceDirs(id), path);
  store.announceBlenderModel(id);
  return removed;
}

/** Publish a completed build without errors. Its bytes are already durable; the row only names them. */
export async function publishBlenderModelBuild(id, buildId) {
  await requireBlenderModel(id);
  await resolveBlenderModelBuildFile(id, buildId, 'model.glb');
  await store.mutateModel(id, (current) => {
    const build = (current.builds || []).find((candidate) => candidate.id === buildId);
    if (!build) throw blenderRefusal('Build not found', 'NOT_FOUND', 404);
    if (build.status !== 'complete' || !build.publishable) {
      throw blenderRefusal('Only a completed build without errors can be published. Fix the errors in its report and build again.', 'BLENDER_MODEL_BUILD_NOT_PUBLISHABLE', 409);
    }
    return current.publishedBuildId === buildId ? null : { ...current, publishedBuildId: buildId };
  });
  await pruneBlenderModelBuilds(id);
  return getBlenderModelState(id);
}

/** The published build's GLB: `{ absolute, filename }`. */
export async function getBlenderModelAsset(id) {
  const model = await requireBlenderModel(id);
  if (!model.publishedBuildId) throw blenderRefusal('This model has no published build yet', 'BLENDER_MODEL_NOT_PUBLISHED', 409);
  const { absolute } = await resolveBlenderModelBuildFile(id, model.publishedBuildId, 'model.glb');
  const slug = String(model.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'model';
  return { absolute, filename: `${slug}.glb` };
}

/** One file a build left (model.glb, model.blend, report.json, build.log). */
export async function getBlenderModelBuildFile(id, buildId, name) {
  await requireBlenderModel(id);
  return resolveBlenderModelBuildFile(id, buildId, name);
}

/** Open a build's model.blend in the Blender application; scripts embedded in it stay off. */
export async function openBlenderModelBuild(id, buildId) {
  await requireBlenderModel(id);
  const { absolute } = await resolveBlenderModelBuildFile(id, buildId, 'model.blend');
  const { resolveBlenderTool } = await import('../codeAnimation/execution.js');
  const tool = await resolveBlenderTool();
  await launchDetached(tool.executable, ['--disable-autoexec', absolute]).catch((error) => {
    throw blenderRefusal(`Blender did not start: ${error.message}`, 'BLENDER_MODEL_OPEN_FAILED', 500);
  });
  console.log(`🧊 Opened Blender model ${id.slice(0, 15)} build ${buildId} in Blender ${tool.version}`);
  return { opened: true, blenderVersion: tool.version };
}
