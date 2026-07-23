/**
 * Sprites — publish the compiled runtime atlas into a managed app's repo
 * (issue #2898, phase 4).
 *
 * The game consumes sprites from its own tree; PortOS owns provenance. A
 * per-record `publishBinding` ({ appId, atlasDestPath, codeBinding? }) names
 * the managed app and the repo-relative destination. Publishing compiles the
 * atlas (idempotently), path-anchors the destination under the app's
 * repoPath, and atomically replaces the file — refusing when the destination
 * bytes no longer match the previous publish (something else changed the
 * game's atlas; clobbering it silently would destroy that change).
 *
 * The optional codeBinding is a verify-or-rewrite guard over the game source
 * file that references the atlas: the binding's resourcePath must appear in
 * the file exactly requiredOccurrenceCount times. When a previous publish
 * recorded a different resourcePath (a destination move), the old string is
 * rewritten to the new one — occurrence-count guarded, refusing on any
 * drift. Engine sidecars (e.g. Godot .png.import) are the game repo's
 * concern and are never touched.
 *
 * Publishes serialize on a per-app queue (the appDeployer per-app-lock
 * posture) nested inside the record's walk write tail.
 */

import { join, resolve } from 'path';
import { readFile, stat } from 'fs/promises';
import {
  atomicWrite, isPathInsideDir, readJSONFile, sha256File, pathExists,
} from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { getAppById } from '../apps.js';
import { isDeploying } from '../appDeployer.js';
import { spriteDir, RUNTIME_PUBLICATIONS_REL } from './paths.js';
import { requireCharacter } from './reference.js';
import { updateRecord } from './records.js';
import { withWalkWriteTail } from './walk.js';
import { compileAtlasInTail } from './atlas.js';

// Per-repo serialization: keyed by the resolved repoPath (matching
// appDeployer's `deployingApps` key), so two app records pointing at the
// same checkout — or two characters publishing into one game — queue behind
// each other instead of interleaving writes to the same tree.
const repoPublishTail = createKeyCachedQueue();

const bindingError = (message, code) => new ServerError(message, { status: 400, code });

/**
 * Anchor a repo-relative path under a managed app's repoPath, refusing
 * absolute paths, traversal, and the repo root itself.
 */
function anchorRepoPath(repoRoot, relPath, label) {
  if (typeof relPath !== 'string' || !relPath || relPath.startsWith('/') || relPath.includes('\\')) {
    throw bindingError(`${label} must be a repo-relative path`, 'INVALID_PUBLISH_PATH');
  }
  const abs = resolve(repoRoot, relPath);
  if (abs === resolve(repoRoot) || !isPathInsideDir(repoRoot, abs)) {
    throw bindingError(`${label} escapes the app repository: ${relPath}`, 'INVALID_PUBLISH_PATH');
  }
  return abs;
}

/**
 * Resolve a binding's app and confirm its repoPath is a real directory.
 * Shared by save-time validation (400) and publish time (409) so the two
 * checks can't drift.
 */
async function requireAppRepo(appId, status) {
  const app = await getAppById(appId);
  if (!app) throw new ServerError(`Unknown app: ${appId}`, { status, code: 'UNKNOWN_APP' });
  const repoStat = app.repoPath ? await stat(app.repoPath).catch(() => null) : null;
  if (!repoStat?.isDirectory()) {
    throw new ServerError(`App ${app.name || appId} has no accessible repoPath`, { status, code: 'APP_REPO_MISSING' });
  }
  return { app, repoRoot: app.repoPath };
}

/** Validate a publishBinding shape (null clears it). */
export async function validatePublishBinding(binding) {
  if (binding === null) return null;
  const { appId, atlasDestPath, codeBinding } = binding;
  const { app } = await requireAppRepo(appId, 400);
  anchorRepoPath(app.repoPath, atlasDestPath, 'atlasDestPath');
  if (codeBinding) {
    anchorRepoPath(app.repoPath, codeBinding.path, 'codeBinding.path');
    if (typeof codeBinding.resourcePath !== 'string' || !codeBinding.resourcePath.trim()) {
      throw bindingError('codeBinding.resourcePath is required', 'INVALID_CODE_BINDING');
    }
  }
  return {
    appId,
    atlasDestPath,
    codeBinding: codeBinding
      ? {
        path: codeBinding.path,
        resourcePath: codeBinding.resourcePath.trim(),
        requiredOccurrenceCount: codeBinding.requiredOccurrenceCount ?? 1,
      }
      : null,
  };
}

/** Persist a validated binding on the record. */
export async function setPublishBinding(recordId, binding) {
  await requireCharacter(recordId);
  const validated = await validatePublishBinding(binding);
  return updateRecord(recordId, { publishBinding: validated });
}

const countOccurrences = (text, needle) => (needle ? text.split(needle).length - 1 : 0);

/**
 * Verify (or occurrence-guarded-rewrite) the game-source code binding.
 * Returns the publication's codeBinding summary; throws on drift.
 */
async function applyCodeBinding(repoRoot, codeBinding, previousResourcePath) {
  const abs = anchorRepoPath(repoRoot, codeBinding.path, 'codeBinding.path');
  const required = codeBinding.requiredOccurrenceCount ?? 1;
  const text = await readFile(abs, 'utf8').catch(() => null);
  if (text === null) {
    throw new ServerError(`Code binding file not found in app repo: ${codeBinding.path}`, { status: 409, code: 'CODE_BINDING_MISSING' });
  }
  const currentCount = countOccurrences(text, codeBinding.resourcePath);
  if (currentCount === required) {
    return { ...codeBinding, rewritten: false };
  }
  // Destination moved since the last publish: the file should still hold the
  // previously-published resource path exactly N times — rewrite it.
  if (previousResourcePath && previousResourcePath !== codeBinding.resourcePath) {
    const previousCount = countOccurrences(text, previousResourcePath);
    if (previousCount === required) {
      await atomicWrite(abs, text.split(previousResourcePath).join(codeBinding.resourcePath));
      return { ...codeBinding, rewritten: true, previousResourcePath };
    }
  }
  throw new ServerError(
    `Code binding drifted: ${codeBinding.path} contains ${currentCount} occurrence(s) of the resource path (expected ${required})`,
    { status: 409, code: 'CODE_BINDING_DRIFTED' },
  );
}

/**
 * Compile (idempotently) and publish the runtime atlas into the bound
 * managed app. Refuses without a binding, on a diverged destination, on an
 * occupied destination PortOS never published (unless explicitly
 * acknowledged), and on code-binding drift. Idempotent: a destination
 * already holding the current atlas bytes records nothing and touches
 * nothing.
 */
export function publishAtlas(recordId, options = {}) {
  return withWalkWriteTail(recordId, () => publishAtlasImpl(recordId, options));
}

async function publishAtlasImpl(recordId, { acknowledgeOverwrite = false } = {}) {
  const record = await requireCharacter(recordId);
  const binding = record.publishBinding;
  if (!binding?.appId || !binding?.atlasDestPath) {
    throw new ServerError('No publish binding configured — set the target app and atlas path first', { status: 409, code: 'PUBLISH_BINDING_REQUIRED' });
  }
  const { app, repoRoot } = await requireAppRepo(binding.appId, 409);

  const compiled = await compileAtlasInTail(recordId);

  return repoPublishTail(resolve(repoRoot), async () => {
    // Don't mutate a tree a deploy is currently building from — appDeployer
    // keys its lock by repoPath, so honor it here (the reverse direction —
    // deploy checking publishes — isn't needed; publishes are sub-second).
    if (isDeploying(repoRoot)) {
      throw new ServerError(`App ${app.name || binding.appId} is deploying — retry when the deploy finishes`, { status: 409, code: 'APP_DEPLOY_IN_PROGRESS' });
    }
    const dir = spriteDir(recordId);
    const destAbs = anchorRepoPath(repoRoot, binding.atlasDestPath, 'atlasDestPath');
    const atlasBuffer = await readFile(join(dir, compiled.atlasPath));

    const publications = await readJSONFile(join(dir, RUNTIME_PUBLICATIONS_REL), []);
    const previous = [...publications].reverse().find(
      (p) => p.appId === binding.appId && p.atlasDestPath === binding.atlasDestPath,
    );

    const destSha256 = (await pathExists(destAbs)) ? await sha256File(destAbs) : null;
    if (destSha256 === compiled.atlasSha256) {
      // Verify the code binding even on a no-op so drift never hides.
      const codeBinding = binding.codeBinding
        ? await applyCodeBinding(repoRoot, binding.codeBinding, previous?.codeBinding?.resourcePath)
        : null;
      return { published: false, upToDate: true, compiled, codeBinding };
    }
    if (previous && destSha256 !== null && destSha256 !== previous.atlasSha256) {
      throw new ServerError(
        'Destination atlas no longer matches the previous publish — it was changed outside PortOS. Resolve in the game repo, then re-publish.',
        { status: 409, code: 'PUBLISH_DEST_DIVERGED' },
      );
    }
    // Never silently destroy bytes PortOS didn't write: a destination that
    // already exists with no publication history needs an explicit overwrite
    // acknowledgment from the caller.
    if (!previous && destSha256 !== null && !acknowledgeOverwrite) {
      throw new ServerError(
        'Destination already contains an atlas PortOS did not publish — confirm the overwrite to replace it.',
        { status: 409, code: 'PUBLISH_DEST_OCCUPIED' },
      );
    }

    // Verify/rewrite the code binding BEFORE replacing the atlas so a drifted
    // binding aborts the publish with the game repo untouched.
    const codeBinding = binding.codeBinding
      ? await applyCodeBinding(repoRoot, binding.codeBinding, previous?.codeBinding?.resourcePath)
      : null;

    await atomicWrite(destAbs, atlasBuffer);

    const publication = {
      publishedAt: new Date().toISOString(),
      characterId: recordId,
      version: compiled.version,
      atlasPath: compiled.atlasPath,
      atlasSha256: compiled.atlasSha256,
      appId: binding.appId,
      appName: app.name || null,
      atlasDestPath: binding.atlasDestPath,
      destPreviousSha256: destSha256,
      codeBinding,
    };
    publications.push(publication);
    await atomicWrite(join(dir, RUNTIME_PUBLICATIONS_REL), publications);
    console.log(`🚚 sprite atlas v${compiled.version} published for ${recordId} → ${app.name || binding.appId}:${binding.atlasDestPath}`);
    return { published: true, publication, compiled };
  });
}
