import { realpathSync } from 'fs';
import { resolve, relative, isAbsolute, delimiter } from 'path';
import { homedir, tmpdir } from 'os';

// Allowed workspace roots shared by routes that accept a caller-supplied
// filesystem path: command execution (`routes/commands.js`), repo detection
// (`routes/detect.js`), scaffolding (`routes/scaffold.js`), submodule reads
// (`routes/git.js`).
//
// Repos legitimately live on secondary volumes, so the defaults cover home plus
// the places each platform mounts them: /Volumes (macOS), /mnt + /media (Linux),
// and — because Windows has no such directory — any lettered non-system drive,
// via the rule below. Windows also drops the POSIX literals entirely: there is
// no /tmp or /opt there, and `resolve('/tmp')` means "\tmp on whatever drive the
// process happens to be on", which is both meaningless and non-deterministic.
//
// Operators extend either platform with PORTOS_WORKSPACE_ROOTS, split on the
// platform path delimiter (`;` on Windows, where `:` would cut `D:\repos` at
// the drive letter).
//
// Roots are symlink-resolved (e.g. /tmp -> /private/tmp on macOS) so a path
// the caller passed and we realpath() still matches.
const IS_WINDOWS = process.platform === 'win32';

export const DEFAULT_WORKSPACE_ROOTS = IS_WINDOWS
  ? [homedir(), tmpdir()]
  : [homedir(), '/tmp', '/Users', '/Volumes', '/mnt', '/media', '/opt'];

// The drive Windows itself is installed on, e.g. `C:`. Everything on it stays
// confined to the roots above, so C:\Windows and C:\Program Files are out.
const WINDOWS_SYSTEM_DRIVE = IS_WINDOWS ? (process.env.SystemDrive || 'C:').toUpperCase() : null;

// A lettered drive prefix: `D:\` or `D:/`. UNC paths (\\server\share) do not
// match — but note a network share mapped to a letter (`net use Z: …`) is
// indistinguishable from a local volume here, and is allowed.
const WINDOWS_DRIVE_PREFIX = /^([A-Za-z]:)[\\/]/;

export const EXTRA_WORKSPACE_ROOTS = (process.env.PORTOS_WORKSPACE_ROOTS || '')
  .split(delimiter)
  .map(s => s.trim())
  .filter(Boolean);

// True when the operator has explicitly configured PORTOS_WORKSPACE_ROOTS.
// Routes that are permissive by default (detect) opt into root-restriction
// only when this is set; routes that always scope (command execution) ignore
// it and enforce against ALLOWED_WORKSPACE_ROOTS unconditionally.
export const WORKSPACE_ROOTS_CONFIGURED = EXTRA_WORKSPACE_ROOTS.length > 0;

// NOT the whole answer on Windows — the non-system-drive rule below allows paths
// that appear in no root here. `isWithinAllowedRoots` is the only complete test;
// don't render this list as "the directories you may use".
export const ALLOWED_WORKSPACE_ROOTS = [...DEFAULT_WORKSPACE_ROOTS, ...EXTRA_WORKSPACE_ROOTS]
  .map(r => {
    const abs = resolve(r);
    // Falls back to the resolved path if the root doesn't exist yet — callers
    // providing paths under a non-existent root will fail the existence check.
    try { return realpathSync(abs); } catch { return abs; }
  });

// Separator-safe containment: resolvedPath === root or is a descendant of root.
export function isWithinRoot(resolvedPath, root) {
  if (resolvedPath === root) return true;
  const rel = relative(root, resolvedPath);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

// Windows counterpart of /Volumes and /mnt: a repo on a data drive (D:\code) is
// as legitimate a workspace as ~/projects. Node can't enumerate drives portably,
// so this is a rule rather than another entry in ALLOWED_WORKSPACE_ROOTS.
function isOnWindowsWorkspaceDrive(realPath) {
  if (!IS_WINDOWS) return false;
  const match = WINDOWS_DRIVE_PREFIX.exec(realPath);
  return !!match && match[1].toUpperCase() !== WINDOWS_SYSTEM_DRIVE;
}

// True when a symlink-resolved path sits inside any allowed root. Callers must
// pass an already-realpath()'d path so a symlink can't escape the check. This is
// the single entry point — see the ALLOWED_WORKSPACE_ROOTS caveat above.
export function isWithinAllowedRoots(realPath) {
  if (isOnWindowsWorkspaceDrive(realPath)) return true;
  return ALLOWED_WORKSPACE_ROOTS.some(root => isWithinRoot(realPath, root));
}

const HOME_ROOT = ALLOWED_WORKSPACE_ROOTS[0];

const formatWorkspaceRoot = (root) => root === HOME_ROOT ? '~' : root;

const singleLine = (value) => String(value).replace(/[\r\n]+/g, ' ');

/**
 * Build the server-only diagnostic for a path rejected by isWithinAllowedRoots.
 * Callers keep their existing terse HTTP error so a real filesystem path never
 * appears in an API response or a value a user might paste into a public issue.
 */
export function outsideAllowedRootsMessage(realPath, { field = 'path' } = {}) {
  const roots = ALLOWED_WORKSPACE_ROOTS.map(formatWorkspaceRoot);
  if (IS_WINDOWS) roots.push('any non-system drive');
  return `${singleLine(field)} is outside allowed directories: ${singleLine(realPath)} (allowed: ${roots.map(singleLine).join(', ')})`;
}
