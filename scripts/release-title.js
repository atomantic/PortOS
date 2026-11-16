#!/usr/bin/env node

import { readFileSync } from 'fs';
import { releaseNotesProblem, releaseTitleFromChangelog } from './lib/releaseTitle.js';

const [version, changelogPath] = process.argv.slice(2);

if (!version || !changelogPath) {
  console.error('Usage: node scripts/release-title.js <version> <changelog-path>');
  process.exit(2);
}

const changelog = readFileSync(changelogPath, 'utf8');
const problem = releaseNotesProblem(changelog, version);
if (problem) {
  console.error(`::error::${problem}`);
  process.exit(1);
}

console.log(releaseTitleFromChangelog(changelog, version));
