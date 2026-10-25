/** Filesystem identity distinguishes checkouts recreated at the same path/head. */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execGit } from './execGit.js';

/** Same identity from a server-captured pointer, after the checkout is gone. */
export function retirementCheckoutIdentityFromPointer(pointer) {
  const values = [pointer?.dev, pointer?.ino, pointer?.birthtimeNs];
  return values.every(value => typeof value === 'string' && /^\d+$/.test(value))
    ? createHash('sha256').update(JSON.stringify(values)).digest('hex') : null;
}

export async function readRetirementCheckoutIdentity(path) {
  const info = await lstat(join(path, '.git'), { bigint: true }).catch(() => null);
  if (!info || (!info.isFile() && !info.isDirectory())) return null;
  return retirementCheckoutIdentityFromPointer({ dev: String(info.dev), ino: String(info.ino), birthtimeNs: String(info.birthtimeNs) });
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
