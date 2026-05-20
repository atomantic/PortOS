// Shared reader for the `data/certs/meta.json` marker `npm run setup:cert`
// writes — returns null on missing-or-partial so callers treat "no meta" the
// same as "no cert" without each one re-implementing the guard.
import { readFileSync, statSync } from 'node:fs';
import { PATHS, safeJSONParse } from './fileUtils.js';
import { certPaths } from '../../lib/certPaths.js';

const { meta: META_PATH } = certPaths(PATHS.data);

export function readCertMeta() {
  const stat = statSync(META_PATH, { throwIfNoEntry: false });
  if (!stat) return null;
  return safeJSONParse(readFileSync(META_PATH, 'utf-8'), null);
}
