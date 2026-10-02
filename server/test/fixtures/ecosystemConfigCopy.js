import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const repoFile = (rel) => new URL(`../../../${rel}`, import.meta.url);

/**
 * Copy the REAL `ecosystem.config.cjs` into a disposable install root, with the
 * dependency-free `.env` parser it `require()`s (#9471) — a bare config copy
 * would throw MODULE_NOT_FOUND when loaded from the temp root.
 */
export function copyEcosystemConfig(root) {
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  copyFileSync(repoFile('ecosystem.config.cjs'), join(root, 'ecosystem.config.cjs'));
  copyFileSync(repoFile('scripts/lib/envFile.cjs'), join(root, 'scripts', 'lib', 'envFile.cjs'));
}
