import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const repoFile = (rel) => new URL(`../../../${rel}`, import.meta.url);

/**
 * Copy the REAL `ecosystem.config.cjs` into a disposable install root, with the
 * dependency-free configuration modules it `require()`s — a bare config copy
 * would throw MODULE_NOT_FOUND when loaded from the temp root.
 */
export function copyEcosystemConfig(root) {
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  copyFileSync(repoFile('ecosystem.config.cjs'), join(root, 'ecosystem.config.cjs'));
  for (const file of ['envFile.cjs', 'databaseSettings.cjs']) {
    copyFileSync(repoFile(`scripts/lib/${file}`), join(root, 'scripts', 'lib', file));
  }
}
