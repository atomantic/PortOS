/** Filename validation, containment checks, and approved asset resolution. */
import { existsSync, statSync } from 'fs';
import { basename, join, resolve as resolvePath, sep as PATH_SEP } from 'path';
import { platform } from 'os';
import { ServerError } from './errorHandler.js';
import { PATHS } from './paths.js';
import { escapeRegExp } from './textUtils.js';

/**
 * Validate a user-supplied filename is a safe basename with one of the
 * allowed extensions — refuses path-traversal, null bytes, separators, and
 * exact `.` / `..`. Throws a 400 ServerError with code VALIDATION_ERROR
 * so calling routes don't have to repeat the check.
 *
 * Consolidates the two near-identical assertions that used to live in
 * `services/loras.js#assertSafeLoraFilename` (`.safetensors` only) and
 * `services/imageGen/local.js#assertGalleryFilename` (`.png` only).
 *
 * Substring `..` is intentionally allowed (e.g. `foo..bar.png` is fine);
 * only the exact-string traversal cases are rejected. Path separators (`/`
 * and `\`) are rejected on every platform — the same input gets posted
 * from Windows clients too.
 *
 * @param {string} filename
 * @param {{ extensions: string[], subject?: string, requiredMessage?: string }} opts
 *   - `extensions`: list of allowed extensions including the leading dot
 *     (`['.png']`, `['.safetensors']`, etc.). Case-insensitive match. Each
 *     entry MUST be a non-empty string starting with `.` — otherwise a bare
 *     suffix like `'png'` would also match `'not-an-imagepng'` and weaken
 *     the validation, so we treat that as a programmer error and throw.
 *   - `subject`: optional noun for the error message ("LoRA filename" →
 *     "Invalid LoRA filename"). Defaults to "filename".
 *   - `requiredMessage`: optional exact message used when `filename` is
 *     missing/empty — preserves backward-compat for wrappers that used to
 *     throw a specific phrase. The gallery wrapper passes `'Invalid filename'`
 *     (its pre-refactor implementation threw that for every failure, including
 *     missing-input); the LoRA wrapper passes `'Filename required'` to match
 *     its historical wording. When omitted, the message is derived from
 *     `subject` (e.g. `'Filename required'` / `'LoRA filename required'`).
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
  // Null bytes terminate C strings — some POSIX syscalls treat the prefix
  // as a separate path. Reject up front so it can't reach the FS layer.
  if (filename.includes('\0')) {
    throw new ServerError(`Invalid ${subjectText}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (!isSafeFilename(filename, extensions)) {
    throw new ServerError(`Invalid ${subjectText}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
}

/**
 * `assertSafeFilename`'s non-throwing twin: the same rule as a predicate, for
 * callers that must report a bad name as *data* rather than fail the request —
 * e.g. a read-only preflight that names one corrupt record as a blocked row
 * instead of 400-ing the whole sweep. Both share this implementation so the
 * thrown gate and the reported verdict can never disagree.
 *
 * Rejects: empty/non-string, null bytes (they terminate C strings, so some
 * POSIX syscalls treat the prefix as a separate path), `.`/`..`, any path
 * separator, anything that isn't already a pure basename, and any extension
 * outside `extensions`. The basename equality check is kept alongside the
 * separator check so e.g. `subdir\foo.png` is rejected on both counts.
 *
 * `extensions` must be dot-prefixed, and unlike `assertSafeFilename` this does
 * not police that for you — a bare suffix like `png` would also match
 * `not-an-imagepng`. Pass a module constant, never a caller-supplied list.
 */
export function isSafeFilename(filename, extensions) {
  if (!isTopLevelEntryName(filename)) return false;
  const lower = filename.toLowerCase();
  return extensions.some((ext) => lower.endsWith(String(ext).toLowerCase()));
}

/**
 * `isSafeFilename`'s traversal half, without the extension gate: true when
 * `name` addresses exactly one entry directly inside some directory.
 *
 * For callers that legitimately cannot allowlist extensions — an arbitrary
 * user asset, or a directory entry — but must still refuse traversal. Naming
 * a single entry is what makes a subsequent `join(dir, name)` safe *in the
 * filesystem sense* and not just lexically: with no separator there is no
 * intermediate component left for a symlink to redirect, which a
 * `resolve`/`relative` containment check cannot see. The Data Manager's
 * per-item purge (`purgeCategory`) is the reference caller.
 *
 * `isSafeFilename` is layered on top of this, so the two can never disagree
 * about what "a single entry" means.
 */
export function isTopLevelEntryName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('\0')) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  return basename(name) === name;
}

/**
 * True when `candidatePath` resolves to a location strictly inside `dir`.
 *
 * The root itself is NOT reported as "inside", which is the desired behavior
 * for file containment. `pathContainment.js` owns the root-inclusive variant
 * (`isPathAtOrInsideDir`) for guards that police a whole tree; the two are
 * deliberately separate declarations rather than one importing the other,
 * because that module is a leaf `fileCore.js` reaches and this one drags
 * `errorHandler`/`paths` — see the budget in `importScoping.test.js`.
 *
 * Uses an anchored-prefix idiom (`resolvePath(dir) + PATH_SEP`): appending the
 * platform separator means a sibling whose name merely *starts with* the root
 * (`/data/uploads-evil` vs `/data/uploads`) can't slip past a bare
 * `startsWith(root)` check.
 *
 * Comparison is case-INSENSITIVE on Windows and macOS, whose filesystems are.
 * A bare `startsWith` there reports `C:\\Users\\Foo\\wt` as outside
 * `C:\\Users\\foo`, even though both name the same directory — so a managed
 * worktree read as `worktree-unmanaged-location` and was silently never reaped.
 * Case-folding only ever makes containment recognize paths that ARE the same
 * file on that platform; it can never admit a path from outside the root, so
 * the security posture is unchanged. Linux stays case-sensitive.
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
 * Build a single-root path resolver that returns a function with the same
 * signature as `resolveGalleryImage` / `resolveImageRef` / `resolveTemplateAsset`.
 *
 * Defense in depth (applied on every call):
 *  1. `basename()` strips dirs (so `../../etc/passwd` → `passwd`).
 *  2. Reject `.`/`..`/empty basenames outright.
 *  3. `resolve` + `startsWith(rootPrefix)` so unicode tricks can't escape.
 *  4. Optional extension allow-list (case-insensitive) before any FS syscall.
 *  5. When `mustExist`, `statSync({ throwIfNoEntry: false }).isFile()` rejects
 *     directories (the root itself would otherwise pass an existsSync check
 *     and flow into ffmpeg / image-gen as an "image path" where it'd fail in
 *     confusing ways). Note: `statSync` follows symlinks, so a symlink under
 *     the root pointing to a regular file outside still passes. PortOS is
 *     single-user (see AGENTS.md "Security Model") so we accept that — for
 *     symlink rejection, swap to `lstatSync`.
 *
 * Pass `{ mustExist: false }` at call time for code paths that intentionally
 * skip the existence check (e.g. when the path is resolved at request time
 * but read later — TOCTOU between resolve and use isn't worth the extra
 * syscall, and the downstream renderer surfaces a clear error if the file
 * vanished).
 *
 * @param {() => string} getRoot - Thunk returning the absolute directory.
 *   A thunk (not a literal) so tests that mutate `PATHS.x` at mock-eval
 *   time still steer the resolver — the value is captured on first call
 *   and cached thereafter (recomputed only if the thunk later returns a
 *   different value, which production code never does).
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] - allowed extensions WITHOUT the leading
 *   dot (`['png', 'jpg', 'jpeg', 'webp']`). When omitted, all extensions are
 *   accepted (matches the legacy gallery/refs behavior — extension checks
 *   happen elsewhere on those paths).
 * @param {boolean} [opts.cache=false] - Memoize successful resolutions. Only
 *   safe for shipped/stable assets (templates) where the basename → path
 *   binding is stable for the process lifetime; never enable for user-mutable
 *   dirs (gallery, refs) since deletions would be masked.
 * @returns {(name: string, opts?: { mustExist?: boolean }) => string|null}
 */
export function makePathResolver(getRoot, { extensions, cache = false } = {}) {
  if (typeof getRoot !== 'function') {
    throw new Error('makePathResolver: getRoot must be a function returning the root dir');
  }
  // Escape regex metacharacters in each extension before interpolating —
  // current callers pass plain alphanumeric tokens (png/jpg/jpeg/webp), but
  // the exported factory shouldn't behave incorrectly if a future caller
  // passes an extension containing `.`/`+`/etc.
  const extRegex = Array.isArray(extensions) && extensions.length > 0
    ? new RegExp(`\\.(${extensions
      .map((e) => escapeRegExp(String(e).replace(/^\./, '')))
      .join('|')})$`, 'i')
    : null;
  const memo = cache ? new Map() : null;
  // Resolved-root cache so the hot path doesn't re-run `resolvePath(root) +
  // PATH_SEP` per call. Recomputes only when `getRoot()` returns a different
  // value — picks up test-time `PATHS.x = ...` mutation on first call, then
  // stays warm for the rest of the process.
  let _root = null;
  let _rootAbsPrefix = null;

  return (name, { mustExist = true } = {}) => {
    if (typeof name !== 'string' || !name) return null;
    const safe = basename(name);
    if (!safe || safe === '.' || safe === '..') return null;
    if (extRegex && !extRegex.test(safe)) return null;
    // Refresh the root cache BEFORE the memo lookup so a getRoot() that
    // suddenly returns a new value (e.g. a test re-mocks `PATHS.x` mid-run)
    // invalidates the memo too — otherwise the old root's cached
    // resolutions would shadow the new root forever.
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
    // throwIfNoEntry:false swallows ENOENT but not EACCES / transient I/O —
    // treat those as "not a valid reference" too rather than bubbling a 500
    // out of the route layer.
    let resolved = null;
    try {
      const stat = statSync(localPath, { throwIfNoEntry: false });
      resolved = stat?.isFile() ? localPath : null;
    } catch { /* falls through to null */ }
    // Only cache successful resolutions — a missing-then-installed asset
    // should pick up on the next call (e.g. setup-data.js racing a render).
    if (memo && resolved) memo.set(cacheKey, resolved);
    return resolved;
  };
}

/**
 * Resolve a user-supplied gallery image filename to an absolute path under
 * `PATHS.images`. Returns `null` on any failure so callers can decide whether
 * to throw, log-and-skip, or substitute a fallback. See `makePathResolver`
 * for the defense-in-depth checks. Late-binds via a thunk so tests that
 * mutate `PATHS.images` at mock-eval time still steer the resolver.
 */
export const resolveGalleryImage = makePathResolver(() => PATHS.images);

/**
 * Resolve a user-supplied reference-image filename to an absolute path under
 * `PATHS.imageRefs`. Multi-reference uploads land in a sibling dir to keep
 * them out of the gallery enumeration; same defense-in-depth as the gallery
 * resolver but anchored at the refs root.
 */
export const resolveImageRef = makePathResolver(() => PATHS.imageRefs);

/**
 * Resolve an Image Cleaner temp init/result filename to an absolute path under
 * `PATHS.imageCleanTmp` (issue #2264). The GPU FLUX round-trip stages the
 * sync-cleaned init bytes here and renders the result back here, so the runner
 * must accept this root as a valid `initImagePath` source. Same defense-in-depth
 * as the gallery/refs resolvers, anchored at the temp root.
 */
export const resolveImageCleanTmp = makePathResolver(() => PATHS.imageCleanTmp);

/**
 * Resolve a peer-uploaded conditioning image staged under
 * `PATHS.federatedMediaInbox` to an absolute path. The provider maps an
 * accepted asset id onto one of these before handing the job to the local
 * generator, so the runner must accept this root as a valid `initImagePath` /
 * reference / keyframe source.
 *
 * Extension-restricted at the resolver rather than only at upload: the upload
 * endpoint already MIME-allowlists, but this is the boundary the *runner*
 * crosses, and a second check here means a hand-written file in the inbox still
 * cannot become an arbitrary path argument to the generator.
 */
export const resolveFederatedMediaAsset = makePathResolver(() => PATHS.federatedMediaInbox, {
  extensions: ['png', 'jpg', 'jpeg', 'webp'],
});

/**
 * Resolve a sprite reference asset used as an image-gen init image (issue
 * #2896 — anchors i2i from the locked main reference; uploaded design
 * references). `data/sprites/` is a server-managed NESTED tree, so unlike
 * the single-level basename resolvers above this accepts only an absolute
 * path already inside the sprites root (no basename fallback — a bare
 * filename is ambiguous across records) and validates containment.
 */
export function resolveSpriteImageInput(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) return null;
  const resolved = resolvePath(rawPath);
  return isPathInsideDir(PATHS.sprites, resolved) ? resolved : null;
}

/**
 * Resolve a shipped visual template filename (e.g. character reference-sheet
 * layout PNG) to an absolute path under `PATHS.visualTemplates`. Caches
 * successful resolutions because the template assets are shipped and stable
 * for the lifetime of the process — keeps reference-sheet rendering off the
 * statSync hot path.
 */
export const resolveTemplateAsset = makePathResolver(() => PATHS.visualTemplates, {
  extensions: ['png', 'jpg', 'jpeg', 'webp'],
  cache: true,
});

/**
 * Resolve a user-supplied screenshot filename to an absolute path under
 * `PATHS.screenshots`. Used by the vision-test endpoint, whose `imagePath`
 * comes straight from `req.body` — basenaming the input (and rejecting any
 * non-image extension or missing file) stops `../` traversal and absolute-path
 * escapes from reading arbitrary files off disk and forwarding their contents
 * to an external vision provider. Returns `null` on any failure so the caller
 * can surface a clean error. See `makePathResolver` for the defense-in-depth
 * checks. Late-binds via a thunk so tests that mutate `PATHS.screenshots` still
 * steer the resolver.
 */
export const resolveScreenshot = makePathResolver(() => PATHS.screenshots, {
  extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
});

/**
 * Resolve any user-supplied image input (init image OR multi-reference image)
 * to an absolute path under one of PortOS's approved image roots — the
 * gallery (`PATHS.images`), the multi-ref upload dir (`PATHS.imageRefs`),
 * or the shipped visual-template dir (`PATHS.visualTemplates`). Used by the
 * image-gen runner to re-validate paths that originated from internal
 * features (gallery picks, reference-sheet renders) which may legitimately
 * cross dir boundaries.
 *
 * Accepts both basename input (`"foo.png"`) and already-resolved absolute
 * paths (the local image-gen runner re-validates the same input on every
 * call so we need to accept both shapes).
 *
 * @param {string} rawPath - basename or absolute path
 * @returns {string|null} validated absolute path, or null
 */
// Pairs of (PATHS-key, resolver). Read PATHS at CALL time so tests that
// mutate `PATHS.x` at mock-eval time still steer the prefix dispatch — a
// module-load snapshot would freeze the pre-mock paths.
const IMAGE_INPUT_RESOLVERS = [
  ['images', resolveGalleryImage],
  ['imageRefs', resolveImageRef],
  ['visualTemplates', resolveTemplateAsset],
  // Image Cleaner temp init images (issue #2264) — the GPU FLUX round-trip
  // stages sync-cleaned bytes here as the img2img init.
  ['imageCleanTmp', resolveImageCleanTmp],
  // Peer-uploaded conditioning images (#4348) — an allowlisted peer's init /
  // reference / keyframe bytes, staged for the one federated render they were
  // uploaded for.
  ['federatedMediaInbox', resolveFederatedMediaAsset],
  // Sprite reference assets (issue #2896) — the locked main reference /
  // uploaded design reference as the anchors' i2i init. Absolute-only
  // (returns null on basename input, so the fall-through loop skips it).
  ['sprites', resolveSpriteImageInput],
];

export function resolveImageInputPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) return null;
  // For ABSOLUTE inputs, dispatch by prefix. The single-root resolvers
  // basename their input for defense-in-depth, so trying them in order on an
  // absolute path can silently redirect a `/data/templates/foo.png` input
  // to `/data/images/foo.png` whenever a same-named file lives in the gallery.
  // Validate against the matching root only.
  const resolvedInput = resolvePath(rawPath);
  for (const [key, resolver] of IMAGE_INPUT_RESOLVERS) {
    const rootPrefix = resolvePath(PATHS[key]) + PATH_SEP;
    if (resolvedInput.startsWith(rootPrefix)) return resolver(rawPath);
  }
  // For basename / relative input (no matching prefix), fall through the
  // resolvers in order. First match wins; basename collisions across roots
  // are accepted as ambiguous and resolve to the first defined root.
  for (const [, resolver] of IMAGE_INPUT_RESOLVERS) {
    const candidate = resolver(rawPath);
    if (candidate) return candidate;
  }
  return null;
}
