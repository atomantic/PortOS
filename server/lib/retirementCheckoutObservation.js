/** Filesystem identity distinguishes checkouts recreated at the same path/head. */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execGit } from './execGit.js';

export async function readRetirementCheckoutIdentity(path) {
  const info = await lstat(join(path, '.git'), { bigint: true }).catch(() => null);
  if (!info || (!info.isFile() && !info.isDirectory())) return null;
  return createHash('sha256').update(JSON.stringify([String(info.dev), String(info.ino), String(info.birthtimeNs)])).digest('hex');
}

/** Read-only admission; neither a stale inventory nor a pathname grants a new obligation. */
export async function isCurrentRetirementCheckout(row) {
  if (!row.checkoutIdentity) return false;
  const before = await readRetirementCheckoutIdentity(row.path);
  if (before !== row.checkoutIdentity) return false;
  const [head, branch] = await Promise.all([
    execGit(['rev-parse', '--verify', 'HEAD'], row.path),
    execGit(['symbolic-ref', '--quiet', 'HEAD'], row.path, { ignoreExitCode: true }),
  ]);
  return head.stdout.trim() === row.head
    && (branch.stdout.trim().replace(/^refs\/heads\//, '') || null) === (row.branch || null)
    && await readRetirementCheckoutIdentity(row.path) === before;
}
