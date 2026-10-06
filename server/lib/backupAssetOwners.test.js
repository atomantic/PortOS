/**
 * The owner inventory decides what consistency a backup snapshot may claim, so
 * it must agree with the code in both directions (#9982): every module it calls
 * admitted really holds the admission lease, and every module that takes the
 * lease is inventoried. Otherwise a stale entry could let a snapshot claim
 * global consistency, or a newly admitted workflow could go unrecorded.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { BACKUP_ASSET_OWNERS, backupAssetConsistency } from './backupAssetOwners.js';
import { blankComments } from './sourceScan.js';

const SERVER_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BOUNDARY_MODULE = 'lib/backupSnapshotBoundary.js';
const STATUSES = new Set(['admitted', 'reference-only', 'outstanding']);
const INJECTED_TOOLKIT_MODULES = new Set([
  'lib/aiToolkit/runner.js', 'lib/aiToolkit/internal/runFinalizer.js',
]);
const takesAdmission = (path) => {
  const source = blankComments(readFileSync(join(SERVER_ROOT, path), 'utf8')).join('\n');
  return /\bwithBackupAssetPublication\s*\(/.test(source)
    || (INJECTED_TOOLKIT_MODULES.has(path) && /\bwithAssetPublication\s*\(/.test(source));
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
    const source = path => blankComments(readFileSync(join(SERVER_ROOT, path), 'utf8')).join('\n');
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
    const sources = execFileSync('git', ['ls-files', '*.js', '*.mjs'], { cwd: SERVER_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(path => path && !path.includes('.test.') && path !== BOUNDARY_MODULE && !path.startsWith('node_modules/'));
    // A broken `git ls-files` would otherwise pass by scanning nothing.
    expect(sources.length).toBeGreaterThan(200);
    const admitting = sources.filter(takesAdmission);
    expect(admitting.length).toBeGreaterThan(0);
    expect(admitting.filter(path => !admittedModules.has(path))).toEqual([]);
  });
});

describe('backupAssetConsistency', () => {
  it('claims global consistency only when no owner is outstanding', () => {
    expect(backupAssetConsistency([
      { id: 'example-admitted', status: 'admitted', modules: [] },
      { id: 'example-reference', status: 'reference-only', modules: [] },
    ])).toEqual({ scope: 'global', outstanding: [] });
    expect(backupAssetConsistency([
      { id: 'example-admitted', status: 'admitted', modules: [] },
      { id: 'example-outstanding', status: 'outstanding', modules: [] },
    ])).toEqual({ scope: 'admitted-owners', outstanding: ['example-outstanding'] });
  });

  it('treats an unrecognized status as outstanding rather than covered', () => {
    expect(backupAssetConsistency([{ id: 'example-typo', status: 'admited', modules: [] }]))
      .toEqual({ scope: 'admitted-owners', outstanding: ['example-typo'] });
  });

  it('reports the shipped inventory as partial while owners remain outside admission', () => {
    const outstanding = BACKUP_ASSET_OWNERS.filter(owner => owner.status === 'outstanding').map(owner => owner.id);
    expect(outstanding.length).toBeGreaterThan(0);
    expect(backupAssetConsistency()).toEqual({ scope: 'admitted-owners', outstanding });
  });
});
