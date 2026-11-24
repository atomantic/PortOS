/** Filename validation, containment checks, and approved image-asset resolution. */
import { statSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve as resolvePath, sep as PATH_SEP } from 'path';
import { platform } from 'os';
import { ServerError } from './errorHandler.js';
import { PATHS } from './paths.js';
import { escapeRegExp } from './textUtils.js';

/**
 /**
 * Throws a 400 VALIDATION_ERROR unless `filename` is a safe basename with an allowed extension: refuses traversal, null bytes, separators (both `/` and `\\`,
 * on every platform) and exact `.`/`..`; substring `..` is allowed (`foo..bar.png`).
 *
 * @param {string} filename
 * @param {{ extensions: string[], subject?: string, requiredMessage?: string }} opts
 *   - `extensions`: case-insensitive, each a non-empty string starting with `.` (a bare `png` would also match `not-an-imagepng`, so that is a programmer error and throws).
 *   - `subject`: noun for the error message ("LoRA filename"); defaults to "filename".
 *   - `requiredMessage`: exact message for a missing/empty filename; derived from `subject` when omitted.
  */
export function assertSafeFilename(filename, { extensions, subject = 'filename', requiredMessage } = {}) {
  if (!Array.isArray(extensions) || extensions.length === 0) {
    throw new Error('assertSafeFilename: extensions allowlist is required');
  }
  for (const ext of extensions) {
    if (typeof ext !== 'string' || ext.length < 2 || !ext.startsWith('.')) {
      throw new Error(`assertSafeFilename: each extension must be a non-empty string starting with "." (got ${JSON.stringify(ext)})`);
    }
  }
  const subjectText = subject || 'filename';
  if (!filename || typeof filename !== 'string') {
    const Subject = `${subjectText[0].toUpperCase()}${subjectText.slice(1)}`;
    const message = typeof requiredMessage === 'string' && requiredMessage.length > 0
      ? requiredMessage
      : `${Subject} required`;
    throw new ServerError(message, { status: 400, code: 'VALIDATION_ERROR' });
  }
  // Null bytes terminate C strings; some POSIX syscalls treat the prefix as a separate path.
  if (filename.includes('\0')) {
    throw new ServerError(`Invalid ${subjectText}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (!isSafeFilename(filename, extensions)) {
    throw new ServerError(`Invalid ${subjectText}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
}

/**
 /**
  * `assertSafeFilename`'s non-throwing twin (shared implementation, so gate and verdict cannot disagree), for callers that report a bad name as data.
  * Unlike the assert, `extensions` is NOT policed for the leading dot: pass a module constant, never a caller-supplied list.
  */
export function isSafeFilename(filename, extensions) {
  if (!isTopLevelEntryName(filename)) return false;
  const lower = filename.toLowerCase();
  return extensions.some((ext) => lower.endsWith(String(ext).toLowerCase()));
}

/**
 /**
  * `isSafeFilename`'s traversal half, without the extension gate: true when `name` addresses exactly one entry directly inside a directory.
  * With no separator there is no intermediate component for a symlink to redirect, which a `resolve`/`relative` containment check cannot see.
  */
export function isTopLevelEntryName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('\0')) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  return basename(name) === name;
}

/**
 /**
  * True when `candidatePath` resolves strictly inside `dir` (the root itself is NOT inside).
  * `pathContainment.js` owns the root-inclusive variant; the two stay separate because that module is a leaf `fileCore.js` reaches and this one drags
  * `errorHandler`/`paths` (see the budget in `importScoping.test.js`).
  *
  * Anchored prefix (`resolvePath(dir) + PATH_SEP`) so a sibling like `/data/uploads-evil` can't pass a bare `startsWith`.
  * Comparison is case-INSENSITIVE on Windows and macOS, whose filesystems are; this only recognises paths that ARE the same file, so it never admits a path from outside the root.
  *
  * @param {string} dir - the containing directory (absolute or relative)
  * @param {string} candidatePath - the path to test
  * @returns {boolean}
  */
const CASE_INSENSITIVE_FS = platform() === 'win32' || platform() === 'darwin';

export function isPathInsideDir(dir, candidatePath) {
  if (typeof dir !== 'string' || typeof candidatePath !== 'string' || !dir || !candidatePath) {
    return false;
  }
  const fold = (p) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);
  const rootPrefix = fold(resolvePath(dir) + PATH_SEP);
  return fold(resolvePath(candidatePath)).startsWith(rootPrefix);
}

/**
 /**
  * Build a single-root path resolver with the same signature as `resolveGalleryImage` / `resolveImageRef` / `resolveTemplateAsset`.
  *
  * Defense in depth on every call: `basename()` strips dirs; `.`/`..`/empty basenames are rejected; `resolve` + `startsWith(rootPrefix)`; optional extension allow-list
  * before any FS syscall; and with `mustExist`, `statSync({ throwIfNoEntry: false }).isFile()` rejects directories. `statSync` follows symlinks, so a symlink under the root to a
  * regular file outside still passes (accepted per AGENTS.md "Security Model"; swap to `lstatSync` to reject).
  * Pass `{ mustExist: false }` at call time to skip the existence check (TOCTOU between resolve and use isn't worth a syscall).
  *
  * @param {() => string} getRoot - Thunk returning the absolute directory, so tests that mutate `PATHS.x` at mock-eval time still steer the resolver
  *   (captured on first call; recomputed only if the thunk returns a different value).
  * @param {object} [opts]
  * @param {string[]} [opts.extensions] - allowed extensions WITHOUT the leading dot; all accepted when omitted.
  * @param {boolean} [opts.cache=false] - Memoize successful resolutions. Only for shipped/stable assets (templates); never for user-mutable dirs (deletions would be masked).
  * @returns {(name: string, opts?: { mustExist?: boolean }) => string|null}
  */
export function makePathResolver(getRoot, { extensions, cache = false } = {}) {
  if (typeof getRoot !== 'function') {
    throw new Error('makePathResolver: getRoot must be a function returning the root dir');
  }
  // Escape regex metacharacters so a future extension containing `.`/`+` can't misbehave.
  const extRegex = Array.isArray(extensions) && extensions.length > 0
    ? new RegExp(`\\.(${extensions
      .map((e) => escapeRegExp(String(e).replace(/^\./, '')))
      .join('|')})$`, 'i')
    : null;
  const memo = cache ? new Map() : null;
  // Resolved-root cache; recomputed only when `getRoot()` returns a different value.
  let _root = null;
  let _rootAbsPrefix = null;

  return (name, { mustExist = true } = {}) => {
    if (typeof name !== 'string' || !name) return null;
    const safe = basename(name);
    if (!safe || safe === '.' || safe === '..') return null;
    if (extRegex && !extRegex.test(safe)) return null;
    // Refresh the root BEFORE the memo lookup so a changed root also invalidates the memo (else old resolutions shadow the new root).
    const root = getRoot();
    if (root !== _root) {
      _root = root;
      _rootAbsPrefix = resolvePath(root) + PATH_SEP;
      if (memo) memo.clear();
    }
    const cacheKey = memo ? (mustExist ? `must:${safe}` : `nostat:${safe}`) : null;
    if (memo && memo.has(cacheKey)) return memo.get(cacheKey);
    const localPath = resolvePath(join(root, safe));
    if (!localPath.startsWith(_rootAbsPrefix)) return null;
    if (!mustExist) {
      if (memo) memo.set(cacheKey, localPath);
      return localPath;
    }
    // throwIfNoEntry:false swallows ENOENT but not EACCES / transient I/O; treat those as "not a valid reference" rather than a 500.
    let resolved = null;
    try {
      const stat = statSync(localPath, { throwIfNoEntry: false });
      resolved = stat?.isFile() ? localPath : null;
    } catch { /* falls through to null */ }
    // Cache only successful resolutions so a later-installed asset is picked up.
    if (memo && resolved) memo.set(cacheKey, resolved);
    return resolved;
  };
}

/**
 /** Resolve a gallery image filename to an absolute path under `PATHS.images`, or `null` (see `makePathResolver`). */
// Formats already written to the gallery by rendering and import workflows.
export const GALLERY_IMAGE_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);

export const resolveGalleryImage = makePathResolver(() => PATHS.images);

/** A Media History video by filename (`mp4`, `webm`, `mov`, `m4v`) under `PATHS.videos`, or null. */
export const resolveGalleryVideo = makePathResolver(() => PATHS.videos, { extensions: ['mp4', 'webm', 'mov', 'm4v'] });

/**
 /** Resolve a reference-image filename under `PATHS.imageRefs` (a sibling dir, kept out of gallery enumeration). */
export const resolveImageRef = makePathResolver(() => PATHS.imageRefs);

/**
 /** Resolve an Image Cleaner temp init/result filename under `PATHS.imageCleanTmp`; the runner accepts this root as an `initImagePath` source. */
export const resolveImageCleanTmp = makePathResolver(() => PATHS.imageCleanTmp);

/**
 /**
  * Resolve a peer-uploaded conditioning image staged under `PATHS.federatedMediaInbox`; the runner accepts this root as an init/reference/keyframe source.
  * Extension-restricted here too (not only at upload) since this is the boundary the runner crosses.
  */
export const resolveFederatedMediaAsset = makePathResolver(() => PATHS.federatedMediaInbox, {
  extensions: ['png', 'jpg', 'jpeg', 'webp'],
});

/**
 /**
  * Resolve a sprite reference asset used as an image-gen init image. `data/sprites/` is a NESTED tree, so this accepts only an absolute path already inside the
  * sprites root (no basename fallback: a bare filename is ambiguous across records).
  */
export function resolveSpriteImageInput(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) return null;
  const resolved = resolvePath(rawPath);
  return isPathInsideDir(PATHS.sprites, resolved) ? resolved : null;
}

/**
 /** Resolve a shipped visual template filename under `PATHS.visualTemplates`; cached because the assets are stable for the process lifetime. */
export const resolveTemplateAsset = makePathResolver(() => PATHS.visualTemplates, {
  extensions: ['png', 'jpg', 'jpeg', 'webp'],
  cache: true,
});

/**
 /**
  * Resolve a screenshot filename under `PATHS.screenshots` for the vision-test endpoint, whose `imagePath` comes straight from `req.body`: basenaming plus the
  * extension/existence checks stop `../` and absolute-path escapes from reading arbitrary files and forwarding them to an external vision provider.
  */
export const resolveScreenshot = makePathResolver(() => PATHS.screenshots, {
  extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
});

const resolveVideoThumbnail = makePathResolver(() => PATHS.videoThumbnails, {
  extensions: ['jpg', 'jpeg', 'png', 'webp'],
});

// A publish-kit workflow supplies a resolved frame. Keep thumbnail names out
// of the generic basename search used by gallery and upload inputs.
function resolveVideoThumbnailInput(rawPath) {
  if (!isAbsolute(rawPath) || dirname(resolvePath(rawPath)) !== resolvePath(PATHS.videoThumbnails)) return null;
  return resolveVideoThumbnail(rawPath);
}

/**
 /**
  * Resolve any user-supplied image input (init or multi-reference) to an absolute path under an approved image root (gallery, multi-ref dir, template dir, ...).
  * Accepts basenames and already-resolved absolute paths (the local runner re-validates the same input on every call).
  *
  * @param {string} rawPath - basename or absolute path
  * @returns {string|null} validated absolute path, or null
  */
 // Pairs of (PATHS-key, resolver), read at CALL time so tests that mutate `PATHS.x` still steer prefix dispatch.
const IMAGE_INPUT_RESOLVERS = [
  ['images', resolveGalleryImage],
  ['imageRefs', resolveImageRef],
  ['visualTemplates', resolveTemplateAsset],
  ['imageCleanTmp', resolveImageCleanTmp],
  ['federatedMediaInbox', resolveFederatedMediaAsset],
  ['videoThumbnails', resolveVideoThumbnailInput],
  // Sprite resolver is absolute-only (null on basename input, so the fall-through loop skips it).
  ['sprites', resolveSpriteImageInput],
];

export function resolveImageInputPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) return null;
  // ABSOLUTE inputs dispatch by prefix: the single-root resolvers basename their input, so trying them in order could redirect `/data/templates/foo.png` to a same-named gallery file.
  const resolvedInput = resolvePath(rawPath);
  for (const [key, resolver] of IMAGE_INPUT_RESOLVERS) {
    const rootPrefix = resolvePath(PATHS[key]) + PATH_SEP;
    if (resolvedInput.startsWith(rootPrefix)) return resolver(rawPath);
  }
  // Basename/relative input falls through the resolvers in order; first match wins.
  for (const [, resolver] of IMAGE_INPUT_RESOLVERS) {
    const candidate = resolver(rawPath);
    if (candidate) return candidate;
  }
  return null;
}
