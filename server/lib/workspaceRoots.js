import { realpathSync } from 'fs';
import { resolve, relative, isAbsolute } from 'path';
import { homedir } from 'os';

// Allowed workspace roots shared by routes that accept a caller-supplied
// filesystem path (command execution scoping in `routes/commands.js`, repo
// detection in `routes/detect.js`).
//
// Defaults cover common single-user Tailscale deployments (home + /tmp +
// /Users so multiple macOS accounts' repos work, plus /Volumes for external
// drives and /opt for Linux server layouts). Operators can extend via
// PORTOS_WORKSPACE_ROOTS="/path1:/path2" if their repos live somewhere more
// exotic.
//
// Roots are symlink-resolved (e.g. /tmp -> /private/tmp on macOS) so a path
// the caller passed and we realpath() still matches.
export const DEFAULT_WORKSPACE_ROOTS = [homedir(), '/tmp', '/Users', '/Volumes', '/opt'];

export const EXTRA_WORKSPACE_ROOTS = (process.env.PORTOS_WORKSPACE_ROOTS || '')
  .split(':')
  .map(s => s.trim())
  .filter(Boolean);

// True when the operator has explicitly configured PORTOS_WORKSPACE_ROOTS.
// Routes that are permissive by default (detect) opt into root-restriction
// only when this is set; routes that always scope (command execution) ignore
// it and enforce against ALLOWED_WORKSPACE_ROOTS unconditionally.
export const WORKSPACE_ROOTS_CONFIGURED = EXTRA_WORKSPACE_ROOTS.length > 0;

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

// True when a symlink-resolved path sits inside any allowed root. Callers must
// pass an already-realpath()'d path so a symlink can't escape the check.
export function isWithinAllowedRoots(realPath) {
  return ALLOWED_WORKSPACE_ROOTS.some(root => isWithinRoot(realPath, root));
}
