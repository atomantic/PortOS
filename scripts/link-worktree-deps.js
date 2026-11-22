#!/usr/bin/env node
/**
 * Link a source checkout's dependency dirs (root, client/, server/
 * node_modules) into a freshly created worktree, so an agent can run tests
 * there without installing — an `npm install` inside a symlinked worktree
 * follows the link and empties the source checkout's real node_modules.
 *
 * Usage: node scripts/link-worktree-deps.js <source-checkout> <worktree-path> [--claim]
 *
 * The claim prompts run this right after their own `git worktree add` (#9052);
 * PortOS-created CoS worktrees get the same links from worktreeManager.
 * Existing entries in the worktree are left untouched.
 */

import { existsSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { formatClaimDependencyStatus } from '../server/services/claimDependencyLock.js';
import { linkWorktreeDependencies } from '../server/services/worktreeManager.js';
import { dependencyWorkspaces, inspectWorkspaceDependencies } from './lib/workspaceDependencies.js';

const [sourceCheckout, worktreePath, mode] = process.argv.slice(2);

if (!sourceCheckout || !worktreePath || (mode && mode !== '--claim')) {
  console.error('❌ Usage: node scripts/link-worktree-deps.js <source-checkout> <worktree-path> [--claim]');
  process.exit(1);
}

try {
  const claim = mode === '--claim';
  const portosRoot = fileURLToPath(new URL('../', import.meta.url));
  const verifyRootLockfile = claim && realpathSync(sourceCheckout) !== realpathSync(portosRoot);
  const dependencies = await linkWorktreeDependencies(resolve(sourceCheckout), resolve(worktreePath), { verifyRootLockfile });
  console.log(claim ? formatClaimDependencyStatus(dependencies) : `🔗 Linked dependencies into ${worktreePath}`);
  // The same check pregate's preflight runs, so a stale source install surfaces
  // at claim time instead of at push time (#17511). Warning only: linking worked.
  const stale = dependencyWorkspaces(resolve(worktreePath))
    .filter(({ dir }) => existsSync(join(dir, 'package-lock.json')))
    .map(inspectWorkspaceDependencies)
    .filter(({ issues }) => issues.length > 0);
  if (stale.length) {
    console.log(`⚠️  Linked node_modules lag this worktree's lockfiles; \`npm run pregate\` will stop at its dependency preflight:`);
    for (const { label, issues } of stale) {
      for (const issue of issues.slice(0, 10)) console.log(`   - ${label}: ${issue}`);
      if (issues.length > 10) console.log(`   - ${label}: ...and ${issues.length - 10} more`);
    }
    console.log('   Never run npm install/ci through the link. Reconcile the SOURCE checkout when no agent is active (an idle PortOS update does it), then re-link.');
  }
} catch (err) {
  console.error(`❌ Failed to link dependencies: ${err.message}`);
  process.exit(1);
}
