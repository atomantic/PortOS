/**
 * Deterministic pre-filter for the `dependency-updates` scheduled task: decides
 * whether a repository declares ANY third-party dependency, so an agent is never
 * spawned just to be told "nothing to update".
 *
 * Conservative by design — only a positive "no dependencies" verdict skips the
 * run. An unreadable directory, an unparsable manifest, or an ecosystem this
 * probe doesn't know all resolve to `hasDependencies: true`.
 */
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', '.git', 'data']);
const MAX_DEPTH = 3;
const MAX_DIRS = 200;

const PACKAGE_JSON_DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies'];

// Manifests whose mere presence means dependencies are (or are likely) declared.
// Lockfile-style or free-form formats are checked for non-comment content below.
const PRESENCE_MANIFESTS = new Set([
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'pubspec.yaml',
  'Package.swift', 'mix.exs', 'Podfile', 'Pipfile', 'environment.yml', 'deno.json', 'deno.jsonc',
  'setup.py', 'setup.cfg', 'pyproject.toml', 'Cargo.toml', 'go.mod'
]);

const hasContentLine = (text, ignore = /^\s*(#|$)/) => text.split('\n').some((l) => !ignore.test(l));

async function manifestDeclaresDependencies(name, path) {
  if (name === 'package.json') {
    const pkg = JSON.parse(await readFile(path, 'utf8'));
    return PACKAGE_JSON_DEP_KEYS.some((k) => {
      const v = pkg?.[k];
      return Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' && Object.keys(v).length > 0;
    });
  }
  if (name === 'requirements.txt' || /^requirements.*\.txt$/.test(name)) {
    return hasContentLine(await readFile(path, 'utf8'));
  }
  if (name === 'go.mod') {
    return /^\s*(require\s|\t)/m.test(await readFile(path, 'utf8'));
  }
  if (name === 'Cargo.toml') {
    return /^\[(.*dependencies.*)\]\s*\n\s*[^\s[#]/m.test(await readFile(path, 'utf8'))
      || /^\[(?:workspace\.)?dependencies\./m.test(await readFile(path, 'utf8'));
  }
  if (PRESENCE_MANIFESTS.has(name)) return true;
  return /\.(csproj|fsproj|vbproj)$/.test(name);
}

/**
 * @param {string} repoPath
 * @returns {Promise<{ hasDependencies: boolean, reason: string }>}
 */
export async function probeDependencyManifests(repoPath) {
  if (!repoPath) return { hasDependencies: true, reason: 'no repo path' };
  let visited = 0;
  let sawManifest = false;

  const walk = async (dir, depth) => {
    if (visited++ >= MAX_DIRS) return true;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile()) {
        const isManifest = e.name === 'package.json' || /^requirements.*\.txt$/.test(e.name)
          || PRESENCE_MANIFESTS.has(e.name) || /\.(csproj|fsproj|vbproj)$/.test(e.name);
        if (!isManifest) continue;
        sawManifest = true;
        const declares = await manifestDeclaresDependencies(e.name, join(dir, e.name)).catch(() => true);
        if (declares) return true;
      }
    }
    if (depth >= MAX_DEPTH) return false;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) {
        if (await walk(join(dir, e.name), depth + 1)) return true;
      }
    }
    return false;
  };

  const found = await walk(repoPath, 0).catch(() => true);
  if (found) return { hasDependencies: true, reason: 'dependency manifest found' };
  return {
    hasDependencies: false,
    reason: sawManifest ? 'manifests declare no dependencies' : 'no dependency manifest found'
  };
}
