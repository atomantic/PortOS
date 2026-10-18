import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { isSeedableReferencePath } from './migrationOwnedPaths.js';

/**
 * Seed a fresh or existing install without overwriting its records. Migration-
 * owned paths must never land before migrations derive them from user data.
 * Logging is opt-in so boot smoke can seed its disposable install silently.
 */
export function seedDataDir({ referenceDir, dataDir, log = () => {} }) {
  const isSeedable = isSeedableReferencePath(referenceDir);
  const created = !existsSync(dataDir);
  if (created) {
    log('📁 Creating data directory from data.reference...');
    mkdirSync(dataDir, { recursive: true });
    cpSync(referenceDir, dataDir, { recursive: true, filter: isSeedable });
  } else {
    const ensureSampleContent = (srcDir, destDir) => {
      for (const item of readdirSync(srcDir)) {
        const srcPath = join(srcDir, item);
        if (!isSeedable(srcPath)) continue;
        const destPath = join(destDir, item);
        if (statSync(srcPath).isDirectory()) {
          if (!existsSync(destPath)) {
            log(`📁 Creating missing directory: ${item}`);
            mkdirSync(destPath, { recursive: true });
          }
          ensureSampleContent(srcPath, destPath);
        } else if (!existsSync(destPath)) {
          log(`📄 Creating missing file: ${destPath.replace(dataDir + '/', '')}`);
          cpSync(srcPath, destPath);
        }
      }
    };
    ensureSampleContent(referenceDir, dataDir);
  }
  return { created };
}
