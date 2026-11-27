/**
 * Validate the recorded admission exceptions and the toolkit's injected lease.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { BACKUP_ASSET_OWNERS } from '../../../lib/backupAssetOwners.js';
import { blankComments } from '../../guardSources.js';
import { readText, REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

const SERVER_ROOT = join(REPO_ROOT, 'server');
const STATUSES = new Set(['reference-only', 'outstanding']);

describe('backup asset owner inventory', () => {
  it('names each owner once, with a known status and modules that exist', () => {
    expect(new Set(BACKUP_ASSET_OWNERS.map(owner => owner.id)).size).toBe(BACKUP_ASSET_OWNERS.length);
    for (const owner of BACKUP_ASSET_OWNERS) {
      expect(STATUSES.has(owner.status), owner.id).toBe(true);
      for (const path of owner.modules) expect(existsSync(join(SERVER_ROOT, path)), path).toBe(true);
    }
  });

  it('admits injected toolkit writers only through the real host boundary', () => {
    const source = path => blankComments(readText(join(SERVER_ROOT, path))).join('\n');
    const bootstrap = source('services/bootstrap.js');
    expect(bootstrap).toMatch(/import\s*\{\s*withBackupAssetPublication\s*\}\s*from ['"]\.\.\/lib\/backupSnapshotBoundary\.js['"]/);
    expect(bootstrap).toMatch(/createAIToolkit\(\{[\s\S]*?withAssetPublication:\s*withBackupAssetPublication/);
    expect(source('lib/aiToolkit/index.js')).toMatch(/createRunnerService\(\{\s*withAssetPublication,/);
    const runner = source('lib/aiToolkit/runner.js');
    expect(runner).toMatch(/const execution = \{[^}]*\bwithAssetPublication\b/);
    expect(runner).toMatch(/createApiStreamExecutor\(\{\s*\.\.\.execution,/);
    expect(source('lib/aiToolkit/internal/apiStreamExecutor.js')).toMatch(/createRunFinalizer\(\{\s*withAssetPublication,/);
  });
});
