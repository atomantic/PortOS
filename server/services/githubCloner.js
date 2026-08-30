/**
 * GitHub Repository Cloner Service
 *
 * Handles cloning GitHub repositories to a local directory for reference.
 * Supports shallow clones to save space and provides progress tracking.
 */

import { spawn } from '../lib/childProcess.js';
import { existsSync } from 'fs';
import { mkdtemp, rename, rm } from 'fs/promises';
import { join } from 'path';
import { ensureDir, PATHS } from '../lib/fileUtils.js';
import { parseGitHubUrl, isGitHubRepoUrl } from '../lib/githubRepoUrl.js';

// Default directory for cloned repos (can be configured in settings)
const DEFAULT_CLONE_DIR = PATHS.repos;

// The owner/repo parse rule lives in lib/ so the client can mirror it — the
// Brain capture boxes have to predict "this URL will be cloned" before submit.
// Re-exported here so existing `githubCloner.parseGitHubUrl` callers keep working.
export { parseGitHubUrl, isGitHubRepoUrl };

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
 * Clone a GitHub repository
 * Returns the local path where the repo was cloned
 */
export async function cloneRepo(url, options = {}) {
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    throw new Error('Invalid GitHub URL');
  }

  const { owner, repo } = parsed;
  const cloneDir = await ensureCloneDir(options.cloneDir);
  const localPath = join(cloneDir, owner, repo);

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

  // Ensure owner directory exists
  const ownerDir = join(cloneDir, owner);
  if (!existsSync(ownerDir)) {
    await ensureDir(ownerDir);
  }

  // Clone into attempt-specific staging, then publish it only after git exits.
  // An abruptly orphaned git child can keep writing its private directory, but
  // a retry gets a different directory and cannot race the live checkout.
  const stagingRoot = await mkdtemp(join(ownerDir, `.${repo}-cloning-`));
  const stagingPath = join(stagingRoot, repo);

  // Build clone command with shallow clone for space efficiency
  const httpsUrl = `https://github.com/${owner}/${repo}.git`;
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
