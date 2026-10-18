/** Read-only workspace/dependency ownership shared by startup and pregate. */
import { lstatSync, readFileSync, realpathSync } from 'fs';
import { join } from 'path';

export function dependencyWorkspaces(root) {
  return ['root', 'client', 'server', 'autofixer'].map(label => ({
    label, dir: label === 'root' ? root : join(root, label),
  }));
}

export function hasLinkedDependencies(dir) {
  return lstatSync(join(dir, 'node_modules'), { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}

function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { error: error.code === 'ENOENT' ? 'missing' : 'unreadable', code: error.code ?? 'invalid JSON' };
  }
}

/**
 * Compare actual manifests, not install receipts: old receipts and npm's hidden
 * lockfile cannot establish which package versions are currently on disk.
 * Absent optional dependencies are valid npm installs (platform / --omit=optional).
 */
export function inspectWorkspaceDependencies({ dir, label }) {
  const issues = [];
  let linked = false;
  let owner = dir;
  try {
    linked = hasLinkedDependencies(dir);
    owner = join(realpathSync(join(dir, 'node_modules')), '..');
  } catch (error) {
    issues.push(`node_modules ${error.code === 'ENOENT' ? 'missing' : 'unreadable'} (${error.code})${linked ? ' — linked target unavailable' : ''}`);
  }
  const lock = readJson(join(dir, 'package-lock.json'));
  if (lock.error) {
    issues.push(`package-lock.json ${lock.error} (${lock.code})`);
  } else if (!lock.value?.packages || !lock.value.packages['']) {
    issues.push('package-lock.json unreadable (requires a packages map with a root entry)');
  } else if (issues.length === 0) {
    for (const [path, expected] of Object.entries(lock.value.packages)) {
      if (path === '') continue;
      if (!/^(?:node_modules\/)(?:[^/]+\/)*[^/]+$/.test(path)
        || path.split('/').some(part => part === '..' || part === '.')
        || typeof expected?.version !== 'string' || expected.link) {
        issues.push(`${path}: unreadable lock entry (expected a locked package version)`);
        continue;
      }
      const installed = readJson(join(dir, path, 'package.json'));
      if (installed.error) {
        if (installed.error === 'missing' && expected.optional) continue;
        issues.push(`${path}: ${installed.error} package.json (${installed.code}); expected ${expected.version}`);
      } else if (typeof installed.value?.version !== 'string') {
        issues.push(`${path}: unreadable package version; expected ${expected.version}`);
      } else if (installed.value.version !== expected.version) {
        issues.push(`${path}: expected ${expected.version}, installed ${installed.value.version}`);
      }
    }
  }
  return { label, linked, owner, issues };
}

/** Returns diagnostics only; never installs, patches, deletes or writes receipts. */
export function dependencyConsistencyProblems(root) {
  return dependencyWorkspaces(root).map(inspectWorkspaceDependencies).filter(result => result.issues.length > 0);
}
