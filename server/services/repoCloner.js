/**
 * Repository Cloner Service
 *
 * Handles cloning repositories (github.com / gitlab.com — see `REPO_HOSTS` in
 * lib/repoUrl.js) to a local directory for reference. Supports shallow clones to
 * save space and provides progress tracking.
 */

import { spawn } from '../lib/childProcess.js';
import { existsSync } from 'fs';
import { access, mkdtemp, readdir, rename, rm } from 'fs/promises';
import { dirname, join } from 'path';
import { ensureDir, PATHS } from '../lib/fileUtils.js';
import { MAX_REPO_PATH_DEPTH, REPO_HOSTS, parseRepoUrl, repoCloneUrl } from '../lib/repoUrl.js';

// Default directory for cloned repos (can be configured in settings)
const DEFAULT_CLONE_DIR = PATHS.repos;
const CLONE_STAGING_PREFIX = '.portos-clone-';
const CLONE_STAGING_MAX_AGE_MS = 10 * 60 * 1000;
const CLONE_STAGING_RE = /^\.portos-clone-(\d{13})-[A-Za-z0-9]+$/;

/**
 * The clone directory for a parsed repo, relative to the repos root.
 *
 * A host flagged `flatClonePath` keeps the historical `<owner>/<repo>` layout so
 * every clone made before PortOS supported a second host stays exactly where its
 * link record says it is. Every other host is namespaced under its hostname,
 * which is also what keeps `gitlab.com/acme/widgets` from colliding with
 * `github.com/acme/widgets`. A GitLab `owner` may itself be a `group/subgroup`
 * path; every segment is validated by parseRepoUrl, so the join stays inside
 * the root.
 */
export function repoSubPath({ host, owner, repo }) {
  return REPO_HOSTS[host]?.flatClonePath ? join(owner, repo) : join(host, owner, repo);
}

/**
 * Get clone directory path
 */
export function getCloneDir(customDir) {
  return customDir || DEFAULT_CLONE_DIR;
}

/**
 * Ensure clone directory exists
 */
export async function ensureCloneDir(cloneDir) {
  const dir = getCloneDir(cloneDir);
  if (!existsSync(dir)) {
    await ensureDir(dir);
    console.log(`📁 Created repos directory: ${dir}`);
  }
  return dir;
}

/**
 * Clone a repository from a supported host.
 * Returns the local path where the repo was cloned.
 */
export async function cloneRepo(url, options = {}) {
  const parsed = parseRepoUrl(url);
  if (!parsed) {
    throw new Error('Invalid repository URL');
  }

  const { owner, repo } = parsed;
  const cloneDir = await ensureCloneDir(options.cloneDir);
  const localPath = join(cloneDir, repoSubPath(parsed));

  // Boot recovery marks only a known interrupted attempt. Old PortOS versions
  // cloned straight into localPath, so their partial checkout must be replaced
  // before the normal already-cloned compatibility check can trust `.git`.
  if (options.replaceIncomplete === true) {
    await rm(localPath, { recursive: true, force: true });
  }

  // Check if already cloned
  if (existsSync(join(localPath, '.git'))) {
    console.log(`📦 Repo already cloned: ${owner}/${repo}`);
    return {
      localPath,
      owner,
      repo,
      alreadyCloned: true
    };
  }

  // Ensure the owner directory exists (for a namespaced host, and for a GitLab
  // subgroup path, that is several levels below the repos root).
  const ownerDir = dirname(localPath);
  if (!existsSync(ownerDir)) {
    await ensureDir(ownerDir);
  }

  // Clone into attempt-specific staging, then publish it only after git exits.
  // An abruptly orphaned git child can keep writing its private directory, but
  // a retry gets a different directory and cannot race the live checkout.
  const stagingRoot = await mkdtemp(join(ownerDir, `${CLONE_STAGING_PREFIX}${Date.now()}-`));
  const stagingPath = join(stagingRoot, repo);

  // Build clone command with shallow clone for space efficiency
  const httpsUrl = repoCloneUrl(parsed);
  const args = [
    'clone',
    '--depth', '1',
    '--single-branch',
    httpsUrl,
    stagingPath
  ];

  console.log(`📥 Cloning ${owner}/${repo}...`);

  const clone = new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      env: process.env,
      shell: false
    });

    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Clone timed out after 5 minutes'));
    }, 300000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        console.error(`❌ Failed to clone ${owner}/${repo}: ${stderr}`);
        reject(new Error(`Git clone failed: ${stderr || `exit code ${code}`}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`❌ Git clone error: ${err.message}`);
      reject(err);
    });
  });

  const cleanupStaging = () => rm(stagingRoot, { recursive: true, force: true })
    .catch(err => console.error(`❌ Failed to clean clone staging directory: ${err.message}`));

  return clone.then(async () => {
    // A concurrent attempt may have won while this one was cloning. Keep the
    // completed checkout and discard only this attempt's private staging dir.
    if (existsSync(join(localPath, '.git'))) {
      await cleanupStaging();
      return { localPath, owner, repo, alreadyCloned: true };
    }
    await rename(stagingPath, localPath);
    await cleanupStaging();
    console.log(`✅ Cloned ${owner}/${repo} to ${localPath}`);
    return { localPath, owner, repo, alreadyCloned: false };
  }).catch(async (err) => {
    await cleanupStaging();
    throw err;
  });
}

/**
 * Remove only PortOS-owned clone staging directories older than twice the git
 * timeout. A freshly orphaned child may still be writing; the age gate leaves
 * it alone while bounding disk retained across repeated interrupted attempts.
 *
 * The sweep RECURSES because staging sits beside the checkout it will become,
 * and that is no longer always one level down: a namespaced host adds a
 * hostname level and each GitLab subgroup adds another. The bound is DERIVED
 * from the host table's namespace caps rather than hardcoded — a hand-picked
 * number silently stops reaping the moment a host's `maxDepth` is raised, and
 * an unreaped interrupted clone is hundreds of MB that nothing ever frees.
 *
 * Staging sits beside the repo segment, so the sweep must be able to LIST the
 * directory one level above the deepest repo — and `sweep` is called with
 * `depth = level + 1` (the repos root itself is depth 1). Recursing into that
 * directory therefore needs the guard to still pass at depth
 * `MAX_REPO_PATH_DEPTH - 1`, which makes the bound `MAX_REPO_PATH_DEPTH` exactly.
 */
const MAX_STAGING_DEPTH = MAX_REPO_PATH_DEPTH;

// A directory holding `.git` is a finished clone, not a namespace level —
// descending into it would walk the studied repo's whole source tree.
const isCheckout = (dir) => access(join(dir, '.git')).then(() => true, () => false);

export async function reapStaleCloneStaging({ cloneDir = DEFAULT_CLONE_DIR, now = Date.now() } = {}) {
  // One unreadable directory (removed mid-sweep, or not ours to read) must not
  // abort the sweep and leave every later branch's staging behind.
  const sweep = async (dir, depth) => {
    const entries = await readdir(dir, { withFileTypes: true })
      .catch(err => {
        if (err.code !== 'ENOENT') console.error(`⚠️ Skipped clone staging sweep for ${dir}: ${err.message}`);
        return [];
      });
    let reaped = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(CLONE_STAGING_RE);
      if (match) {
        if (now - Number(match[1]) < CLONE_STAGING_MAX_AGE_MS) continue;
        await rm(join(dir, entry.name), { recursive: true, force: true });
        reaped++;
      } else if (depth < MAX_STAGING_DEPTH && !await isCheckout(join(dir, entry.name))) {
        reaped += await sweep(join(dir, entry.name), depth + 1);
      }
    }
    return reaped;
  };

  const reaped = await sweep(cloneDir, 1);
  if (reaped > 0) console.log(`🧹 Reaped ${reaped} stale repository clone staging director${reaped === 1 ? 'y' : 'ies'}`);
  return reaped;
}

/**
 * Pull latest changes for an existing repo
 */
export async function pullRepo(localPath) {
  if (!existsSync(join(localPath, '.git'))) {
    throw new Error('Not a git repository');
  }

  console.log(`🔄 Pulling latest for ${localPath}...`);

  return new Promise((resolve, reject) => {
    const child = spawn('git', ['pull', '--ff-only'], {
      cwd: localPath,
      env: process.env,
      shell: false
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ Pulled latest for ${localPath}`);
        resolve({ stdout, stderr, success: true });
      } else {
        console.error(`❌ Failed to pull ${localPath}: ${stderr}`);
        reject(new Error(`Git pull failed: ${stderr || `exit code ${code}`}`));
      }
    });

    child.on('error', reject);

    // Timeout after 2 minutes
    setTimeout(() => {
      child.kill();
      reject(new Error('Pull timed out after 2 minutes'));
    }, 120000);
  });
}

/**
 * Get repo info (last commit, etc.)
 */
export async function getRepoInfo(localPath) {
  if (!existsSync(join(localPath, '.git'))) {
    return null;
  }

  return new Promise((resolve) => {
    const child = spawn('git', ['log', '-1', '--format=%H|%s|%ci'], {
      cwd: localPath,
      env: process.env,
      shell: false
    });

    let stdout = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        const [hash, message, date] = stdout.trim().split('|');
        resolve({
          lastCommitHash: hash,
          lastCommitMessage: message,
          lastCommitDate: date
        });
      } else {
        resolve(null);
      }
    });

    child.on('error', () => resolve(null));
  });
}
