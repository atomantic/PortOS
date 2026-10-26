#!/usr/bin/env node
import { assertGitMergeTree } from '../lib/gitMergeTree.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

if (isDirectlyInvoked(import.meta.url)) {
  try {
    assertGitMergeTree(process.cwd());
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  }
}
