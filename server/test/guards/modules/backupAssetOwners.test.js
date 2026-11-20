/**
 * The owner inventory decides what consistency a backup snapshot may claim, so
 * it must agree with the code in both directions (#9982): every module it calls
 * admitted really holds the admission lease, and every module that takes the
 * lease is inventoried. Otherwise a stale entry could let a snapshot claim
 * global consistency, or a newly admitted workflow could go unrecorded.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { BACKUP_ASSET_OWNERS } from '../../../lib/backupAssetOwners.js';
import { blankComments } from '../../guardSources.js';
import { readText, REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';

const SERVER_ROOT = join(REPO_ROOT, 'server');
const BOUNDARY_MODULE = 'lib/backupSnapshotBoundary.js';
const STATUSES = new Set(['admitted', 'reference-only', 'outstanding']);
const INJECTED_TOOLKIT_MODULES = new Set([
  'lib/aiToolkit/runner.js', 'lib/aiToolkit/internal/runFinalizer.js',
]);
const RUNTIME_DELEGATES = new Set(['services/runner.js', 'services/loops.js', 'cos-runner/completion.js']);
const takesAdmission = (path) => {
  const source = blankComments(readText(join(SERVER_ROOT, path))).join('\n');
  return /\bwithBackupAssetPublication\s*\(/.test(source)
    || (INJECTED_TOOLKIT_MODULES.has(path) && /\bwithAssetPublication\s*\(/.test(source))
    || (RUNTIME_DELEGATES.has(path) && /import \{[^}]*\bpublishRuntimeFiles\b[^}]*\} from ['"]\.\.\/lib\/runtimeFilePublication\.js['"]/.test(source)
      && /\bpublishRuntimeFiles\s*\(/.test(source));
};
const admittedModules = new Set(BACKUP_ASSET_OWNERS
  .filter(owner => owner.status === 'admitted')
  .flatMap(owner => owner.modules));

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
    expect(source('lib/aiToolkit/runner.js')).toMatch(/createRunFinalizer\(\{\s*withAssetPublication,/);
  });

  it('lists only modules that hold the admission lease as admitted', () => {
    for (const path of admittedModules) expect(takesAdmission(path), path).toBe(true);
  });

  it('inventories every module that takes the admission lease', () => {
    const sources = trackedFiles(SERVER_ROOT, ['*.js', '*.mjs'])
      .filter(path => path && !path.includes('.test.') && path !== BOUNDARY_MODULE && !path.startsWith('node_modules/'));
    // A broken `git ls-files` would otherwise pass by scanning nothing.
    expect(sources.length).toBeGreaterThan(200);
    const admitting = sources.filter(takesAdmission);
    expect(admitting.length).toBeGreaterThan(0);
    expect(admitting.filter(path => !admittedModules.has(path))).toEqual([]);
  });
});
