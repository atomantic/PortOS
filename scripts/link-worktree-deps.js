#!/usr/bin/env node
/**
 * Link node_modules from the source checkout into a worktree.
 *
 * This script symlinks the root, client/, and server/ node_modules directories
 * from the primary checkout into a fresh worktree, allowing agents to run tests
 * and npm commands without installing dependencies inside the worktree (which
 * would corrupt the primary checkout through symlinks).
 *
 * Usage: node scripts/link-worktree-deps.js <worktree-path>
 *
 * This is called by the Claim Issue prompt's Phase 2 to set up dependencies
 * immediately after `git worktree add`, before any agent work begins.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { linkWorktreeDependencies } from '../server/services/worktreeManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const worktreePath = process.argv[2];

if (!worktreePath) {
  console.error('❌ Usage: node scripts/link-worktree-deps.js <worktree-path>');
  process.exit(1);
}

try {
  await linkWorktreeDependencies(repoRoot, worktreePath);
  console.log(`✓ Linked node_modules into ${worktreePath}`);
} catch (err) {
  console.error(`❌ Failed to link node_modules: ${err.message}`);
  process.exit(1);
}
