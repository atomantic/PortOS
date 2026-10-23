#!/usr/bin/env node
/**
 * Exclude the churny data/ subdirectories (worktrees, archives, profiles) from
 * Spotlight indexing (macOS); user media stays indexed. Idempotent; also runs from
 * setup-data.js so fresh installs and updates get it. Opt out with
 * PORTOS_SKIP_SPOTLIGHT_EXCLUDE=1 (the marker is then left as-is).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { excludeFromSpotlight } from './lib/spotlightExclude.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export function setupSpotlight(dir = dataDir, { log = console.log, env = process.env } = {}) {
  if (env.PORTOS_SKIP_SPOTLIGHT_EXCLUDE === '1') return 'skipped';
  const result = excludeFromSpotlight(dir);
  if (result === 'created') log('🔦 Excluded agent worktrees/archives under data/ from Spotlight (.metadata_never_index)');
  return result;
}

if (isDirectlyInvoked(import.meta.url)) setupSpotlight();
