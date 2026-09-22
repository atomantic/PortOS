#!/usr/bin/env node

import { readFileSync } from 'fs';
import { releaseTitleFromChangelog } from './lib/releaseTitle.js';

const [version, changelogPath] = process.argv.slice(2);

if (!version || !changelogPath) {
  console.error('Usage: node scripts/release-title.js <version> <changelog-path>');
  process.exit(2);
}

console.log(releaseTitleFromChangelog(readFileSync(changelogPath, 'utf8'), version));
