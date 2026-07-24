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
 * The optional runtimeContract (#2982) is the reverse direction: the app
 * declares the grid it was built against ({ walkFrameCount, cellSize,
 * columnCount }) and a publish whose compiled geometry disagrees is refused
 * instead of silently shifting every column the game reads. Alongside the PNG,
 * publish writes a `<atlas-stem>.layout.json` sidecar describing the grid
 * PortOS actually produced, so the app can resolve columns by name rather than
 * by memory. An absent contract publishes unchecked, exactly as before.
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
import { spriteDir, RUNTIME_POINTER_REL, RUNTIME_PUBLICATIONS_REL } from './paths.js';
import { requireCharacter } from './reference.js';
import { updateRecord } from './records.js';
import { withWalkWriteTail } from './walk.js';
import { compileAtlasInTail } from './atlas.js';
import { sha256Buffer } from './walkPostprocess.js';
import { spriteRuntimeContractSchema } from '../../lib/validation.js';
import { buildAtlasLayout, layoutSidecarPath, runtimeContractMismatch } from './atlasLayout.js';

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

/**
 * Validate the optional runtimeContract — the grid the consuming app was built
 * against (#2982). Shape and bounds come from the SAME Zod schema the route
 * parses, so a non-route caller (importer, peer sync, a test) can't persist a
 * contract the route would have rejected.
 *
 * `walkFrameCount` is required once a contract is present (it is the whole
 * point of declaring one); `cellSize` and `columnCount` are optional extra
 * assertions. The fields are NOT cross-checked against each other: what counts
 * as a consistent column layout is the compiler's business and changes with the
 * grid (#2986 drops the scanner column), so a stale count surfaces at publish
 * with both numbers named rather than as an unexplained 400 at save.
 */
function validateRuntimeContract(runtimeContract) {
  if (runtimeContract === undefined || runtimeContract === null) return null;
  const parsed = spriteRuntimeContractSchema.safeParse(runtimeContract);
  if (!parsed.success) {
    const issue = parsed.error.issues?.[0];
    const field = issue?.path?.length ? `runtimeContract.${issue.path.join('.')}` : 'runtimeContract';
    throw bindingError(`${field}: ${issue?.message || 'invalid'}`, 'INVALID_RUNTIME_CONTRACT');
  }
  const { walkFrameCount, cellSize, columnCount } = parsed.data;
  return { walkFrameCount, cellSize: cellSize ?? null, columnCount: columnCount ?? null };
}

/** Validate a publishBinding shape (null clears it). */
export async function validatePublishBinding(binding) {
  if (binding === null) return null;
  const { appId, atlasDestPath, codeBinding, runtimeContract } = binding;
  const { app } = await requireAppRepo(appId, 400);
  anchorRepoPath(app.repoPath, atlasDestPath, 'atlasDestPath');
  // The sidecar lands beside the atlas, so its path must anchor too — catch a
  // destination whose sidecar would escape the repo at SAVE time, not mid-publish.
  anchorRepoPath(app.repoPath, layoutSidecarPath(atlasDestPath), 'atlas layout sidecar');
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
    // `undefined` (key absent) is distinct from `null` (explicit clear) — see
    // setPublishBinding, which carries an absent contract over from the stored
    // binding so a client that predates the field can't silently wipe it.
    runtimeContract: validateRuntimeContract(runtimeContract),
  };
}

/**
 * Persist a validated binding on the record. A binding that omits
 * `runtimeContract` entirely INHERITS the stored one (absent ≠ empty): the
 * publish form saves appId/dest/codeBinding only, and a form save must not
 * silently drop the contract an app declared through the API. Pass
 * `runtimeContract: null` to clear it, or `binding: null` to clear everything.
 */
export async function setPublishBinding(recordId, binding) {
  const record = await requireCharacter(recordId);
  const validated = await validatePublishBinding(binding);
  if (validated && binding.runtimeContract === undefined) {
    validated.runtimeContract = record.publishBinding?.runtimeContract ?? null;
  }
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

  const dir = spriteDir(recordId);
  // Reuse the current pointer's geometry so publish ships the atlas the user
  // compiled and previewed — a bare default-geometry recompile would silently
  // discard a custom-geometry compile and flip the pointer back to defaults.
  const pointer = await readJSONFile(join(dir, RUNTIME_POINTER_REL), null);
  const geometryOverride = pointer?.geometry
    ? {
      cellSize: pointer.geometry.cellSize,
      pivot: pointer.geometry.pivot,
      targetMaxHeight: pointer.geometry.targetMaxHeight,
      targetMaxWidth: pointer.geometry.targetMaxWidth,
    }
    : undefined;
  const compiled = await compileAtlasInTail(recordId, { geometry: geometryOverride });

  // Export contract (#2982). Everything below runs BEFORE the repo write lock,
  // so a publish the bound app cannot consume leaves the game tree untouched.
  // One geometry assertion serves both the contract compare and the sidecar.
  const appLabel = app.name || binding.appId;
  if (!Array.isArray(compiled.geometry?.columns)) {
    throw new ServerError(
      'The compiled atlas reports no column layout, so neither its export contract nor its layout sidecar can be resolved — recompile the atlas before publishing.',
      { status: 422, code: 'ATLAS_GEOMETRY_UNKNOWN' },
    );
  }
  // No declared contract ⇒ unchanged, unchecked behavior.
  const mismatch = runtimeContractMismatch(compiled.geometry, binding.runtimeContract, appLabel);
  if (mismatch) throw new ServerError(mismatch, { status: 409, code: 'PUBLISH_CONTRACT_MISMATCH' });

  // The sidecar describing the grid PortOS actually produced. Built here (pure,
  // lock-free) so the same bytes serve both the write and the up-to-date
  // comparison below. It carries no timestamp: identical geometry ⇒ identical
  // bytes ⇒ a republish is a genuine no-op.
  const layout = buildAtlasLayout({
    characterId: recordId,
    geometry: compiled.geometry,
    atlasSha256: compiled.atlasSha256,
    version: compiled.version,
    atlasDestPath: binding.atlasDestPath,
  });
  const layoutBuffer = Buffer.from(`${JSON.stringify(layout, null, 2)}\n`);
  const layoutSha256 = sha256Buffer(layoutBuffer);
  const layoutDestPath = layoutSidecarPath(binding.atlasDestPath);

  return repoPublishTail(resolve(repoRoot), async () => {
    // Don't mutate a tree a deploy is currently building from — appDeployer
    // keys its lock by repoPath, so honor it here (the reverse direction —
    // deploy checking publishes — isn't needed; publishes are sub-second).
    if (isDeploying(repoRoot)) {
      throw new ServerError(`App ${appLabel} is deploying — retry when the deploy finishes`, { status: 409, code: 'APP_DEPLOY_IN_PROGRESS' });
    }
    const destAbs = anchorRepoPath(repoRoot, binding.atlasDestPath, 'atlasDestPath');
    // The sidecar is repo-anchored and written inside this same per-repo tail
    // as the PNG, so the pair is never interleaved with another publish into
    // the same checkout.
    const layoutAbs = anchorRepoPath(repoRoot, layoutDestPath, 'atlas layout sidecar');
    // Write it only when the content actually differs, so a republish that
    // changes nothing stays a genuine no-op. Returns whether the repo was
    // mutated — an atlas already at the destination but MISSING its sidecar
    // still gets one, so the two can never be permanently out of step.
    const writeLayoutSidecar = async () => {
      const existing = await readFile(layoutAbs).catch(() => null);
      if (existing?.equals(layoutBuffer)) return false;
      await atomicWrite(layoutAbs, layoutBuffer);
      return true;
    };
    const atlasBuffer = await readFile(join(dir, compiled.atlasPath)).catch(() => null);
    if (!atlasBuffer) {
      throw new ServerError('Compiled atlas file is missing on disk — recompile before publishing', { status: 422, code: 'ATLAS_OUTPUT_MISSING' });
    }
    // The only path that writes outside data/ ships exactly the bytes the
    // evidence chain vouched for — never a tampered runtime/vN file.
    if (sha256Buffer(atlasBuffer) !== compiled.atlasSha256) {
      throw new ServerError('Compiled atlas bytes no longer match their recorded sha256 — recompile before publishing', { status: 422, code: 'ATLAS_OUTPUT_TAMPERED' });
    }

    const publications = await readJSONFile(join(dir, RUNTIME_PUBLICATIONS_REL), []);
    const previous = [...publications].reverse().find(
      (p) => p.appId === binding.appId && p.atlasDestPath === binding.atlasDestPath,
    );
    // The code-binding baseline follows the FILE, not the destination — a
    // destination move changes atlasDestPath, and the rewrite exists exactly
    // for that case, so a dest-keyed lookup would never find the old
    // resource path to rewrite from.
    const previousForCode = binding.codeBinding
      ? [...publications].reverse().find(
        (p) => p.appId === binding.appId && p.codeBinding?.path === binding.codeBinding.path,
      )
      : null;

    const recordPublication = async (extra) => {
      const publication = {
        publishedAt: new Date().toISOString(),
        characterId: recordId,
        version: compiled.version,
        atlasPath: compiled.atlasPath,
        atlasSha256: compiled.atlasSha256,
        appId: binding.appId,
        appName: app.name || null,
        atlasDestPath: binding.atlasDestPath,
        ...extra,
      };
      publications.push(publication);
      await atomicWrite(join(dir, RUNTIME_PUBLICATIONS_REL), publications);
      return publication;
    };

    const destSha256 = (await pathExists(destAbs)) ? await sha256File(destAbs) : null;
    if (destSha256 === compiled.atlasSha256) {
      // Verify the code binding even on a no-op so drift never hides.
      const codeBinding = binding.codeBinding
        ? await applyCodeBinding(repoRoot, binding.codeBinding, previousForCode?.codeBinding?.resourcePath)
        : null;
      // An up-to-date atlas can still be missing (or carrying a stale) layout
      // sidecar — from a publish that predates it, or a hand-deleted file.
      // Reconcile it here so the pair converges on the next publish.
      const layoutWritten = await writeLayoutSidecar();
      // The destination already holds the current bytes, but three sub-cases
      // still mutate durable state and must be recorded: a code-binding
      // rewrite just changed the game's source, the sidecar was just written,
      // and a first-ever publish finding its own bytes needs a history
      // baseline (otherwise the next changed-atlas publish reads the dest as
      // foreign and 409s OCCUPIED).
      let publication = null;
      if ((codeBinding?.rewritten || layoutWritten || !previous)) {
        publication = await recordPublication({
          destPreviousSha256: destSha256, codeBinding, layoutDestPath, layoutSha256, upToDateBaseline: true,
        });
      }
      return {
        published: false, upToDate: true, compiled, codeBinding, publication, layoutWritten, layoutDestPath,
      };
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
      ? await applyCodeBinding(repoRoot, binding.codeBinding, previousForCode?.codeBinding?.resourcePath)
      : null;

    // Sidecar BEFORE the atlas. Either order has a crash window, but only this
    // one fails loudly: the layout carries `sourceAtlasSha256`, so a sidecar
    // that landed without its atlas is DETECTABLE by the consumer, whereas a
    // new atlas under a stale/absent layout is exactly the silent column shift
    // this whole contract exists to prevent.
    const layoutWritten = await writeLayoutSidecar();
    await atomicWrite(destAbs, atlasBuffer);

    const publication = await recordPublication({
      destPreviousSha256: destSha256, codeBinding, layoutDestPath, layoutSha256,
    });
    console.log(`🚚 sprite atlas v${compiled.version} published for ${recordId} → ${appLabel}:${binding.atlasDestPath}`);
    return { published: true, publication, compiled, layoutWritten, layoutDestPath };
  });
}
