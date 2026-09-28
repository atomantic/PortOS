#!/usr/bin/env node
/**
 * Link a source checkout's dependency dirs (root, client/, server/
 * node_modules) into a freshly created worktree, so an agent can run tests
 * there without installing — an `npm install` inside a symlinked worktree
 * follows the link and empties the source checkout's real node_modules.
 *
 * Usage: node scripts/link-worktree-deps.js <source-checkout> <worktree-path>
 *
 * The claim prompts run this right after their own `git worktree add` (#9052);
 * PortOS-created CoS worktrees get the same links from worktreeManager.
 * Existing entries in the worktree are left untouched.
 */

import { resolve } from 'path';
import { linkWorktreeDependencies } from '../server/services/worktreeManager.js';

const [sourceCheckout, worktreePath] = process.argv.slice(2);

if (!sourceCheckout || !worktreePath) {
  console.error('❌ Usage: node scripts/link-worktree-deps.js <source-checkout> <worktree-path>');
  process.exit(1);
}

try {
  await linkWorktreeDependencies(resolve(sourceCheckout), resolve(worktreePath));
  console.log(`🔗 Linked dependencies into ${worktreePath}`);
} catch (err) {
  console.error(`❌ Failed to link dependencies: ${err.message}`);
  process.exit(1);
}
