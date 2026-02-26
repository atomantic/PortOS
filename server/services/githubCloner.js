/**
 * GitHub Repository Cloner Service
 *
 * Handles cloning GitHub repositories to a local directory for reference.
 * Supports shallow clones to save space and provides progress tracking.
 */

import { spawn } from 'child_process';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Default directory for cloned repos (can be configured in settings)
const DEFAULT_CLONE_DIR = join(__dirname, '../../data/repos');

/**
 * Parse GitHub URL to extract owner and repo name
 * Supports formats:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 * - github.com/owner/repo
 */
export function parseGitHubUrl(url) {
  if (!url) return null;

  // Normalize URL
  let normalized = url.trim();

  // Handle SSH format: git@github.com:owner/repo.git
  const sshMatch = normalized.match(/git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
      isGitHub: true
    };
  }

  // Handle HTTPS format: https://github.com/owner/repo or github.com/owner/repo
  const httpsMatch = normalized.match(/(?:https?:\/\/)?github\.com\/([^/]+)\/([^/?#]+)/i);
  if (httpsMatch) {
    return {
      owner: httpsMatch[1],
      repo: httpsMatch[2].replace(/\.git$/, ''),
      isGitHub: true
    };
  }

  return null;
}

/**
 * Check if a URL is a GitHub repository URL
 */
export function isGitHubRepoUrl(url) {
  return parseGitHubUrl(url) !== null;
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
    await mkdir(dir, { recursive: true });
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
    await mkdir(ownerDir, { recursive: true });
  }

  // Build clone command with shallow clone for space efficiency
  const httpsUrl = `https://github.com/${owner}/${repo}.git`;
  const args = [
    'clone',
    '--depth', '1',
    '--single-branch',
    httpsUrl,
    localPath
  ];

  console.log(`📥 Cloning ${owner}/${repo}...`);

  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      env: process.env,
      shell: false,
      windowsHide: true
    });

    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ Cloned ${owner}/${repo} to ${localPath}`);
        resolve({
          localPath,
          owner,
          repo,
          alreadyCloned: false
        });
      } else {
        console.error(`❌ Failed to clone ${owner}/${repo}: ${stderr}`);
        reject(new Error(`Git clone failed: ${stderr || `exit code ${code}`}`));
      }
    });

    child.on('error', (err) => {
      console.error(`❌ Git clone error: ${err.message}`);
      reject(err);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      child.kill();
      reject(new Error('Clone timed out after 5 minutes'));
    }, 300000);
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
      shell: false,
      windowsHide: true
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
      shell: false,
      windowsHide: true
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
