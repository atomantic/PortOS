/**
 * Expand `__PORTOS_ROOT__` inside `data/apps.json` to the live checkout path.
 * Shared by `scripts/setup-data.js` so fresh seeds and existing data/ trees
 * both get the rewrite (idempotent).
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  containsPortosRootToken,
  expandPortosRootToken,
  PORTOS_ROOT_TOKEN,
} from '../../server/lib/portosRootPlaceholder.js';

/**
 * @param {string} dataDir Absolute path to the install's `data/` directory
 * @param {string} rootDir Absolute PortOS checkout path that replaces the token
 * @returns {{ rewritten: boolean, appsFile: string }}
 */
export function rewriteAppsPortosRoot(dataDir, rootDir) {
  const appsFile = join(dataDir, 'apps.json');
  if (!existsSync(appsFile)) return { rewritten: false, appsFile };
  const content = readFileSync(appsFile, 'utf8');
  if (!containsPortosRootToken(content)) return { rewritten: false, appsFile };
  // Expand string values after parsing, then let JSON.stringify escape paths
  // (Windows backslashes and legal quote characters) at the storage boundary.
  // Parsing before writing also leaves a malformed registry untouched.
  const apps = JSON.parse(content, (_key, value) => expandPortosRootToken(value, rootDir));
  writeFileSync(appsFile, `${JSON.stringify(apps, null, 2)}\n`);
  return { rewritten: true, appsFile, token: PORTOS_ROOT_TOKEN, rootDir };
}
