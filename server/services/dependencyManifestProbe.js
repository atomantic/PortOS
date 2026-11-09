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
  'setup.py', 'setup.cfg', 'pyproject.toml', 'Cargo.toml', 'go.mod',
  'renovate.json', 'renovate.json5', '.renovaterc', '.renovaterc.json', 'Cartfile'
]);

// `.github/` is a dot-dir the walk skips, but it declares two things the
// dependency-updates prompt acts on: a Dependabot/Renovate config (whose bot PRs
// Phase 1 lands) and workflow `uses:` pins on third-party actions (the
// github-actions ecosystem). A repo with only those still has work to do.
const GITHUB_BOT_CONFIGS = ['dependabot.yml', 'dependabot.yaml', 'renovate.json', 'renovate.json5'];
const EXTERNAL_ACTION_USE = /^\s*(?:-\s*)?uses:\s*['"]?(?!\.\/)[^\s'"#]+@/m;

async function githubDeclaresDependencies(repoPath) {
  const githubDir = join(repoPath, '.github');
  const entries = await readdir(githubDir).catch(() => []);
  if (entries.some((name) => GITHUB_BOT_CONFIGS.includes(name))) return true;
  const workflowsDir = join(githubDir, 'workflows');
  const workflows = (await readdir(workflowsDir).catch(() => [])).filter((name) => /\.ya?ml$/.test(name));
  for (const name of workflows) {
    const text = await readFile(join(workflowsDir, name), 'utf8').catch(() => '');
    if (EXTERNAL_ACTION_USE.test(text)) return true;
  }
  return false;
}

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
  if (name === 'project.pbxproj') {
    // An Xcode app adds Swift packages in its project file, not a Package.swift.
    return (await readFile(path, 'utf8')).includes('XCRemoteSwiftPackageReference');
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
  if (await githubDeclaresDependencies(repoPath)) {
    return { hasDependencies: true, reason: 'GitHub Actions or a dependency-bot config found' };
  }
  let visited = 0;
  let sawManifest = false;

  const walk = async (dir, depth) => {
    if (visited++ >= MAX_DIRS) return true;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile()) {
        const isManifest = e.name === 'package.json' || e.name === 'project.pbxproj' || /^requirements.*\.txt$/.test(e.name)
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
