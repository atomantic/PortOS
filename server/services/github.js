import { spawn } from 'child_process';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { readJSONFile, PATHS, ensureDir } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { getSettings, updateSettings } from './settings.js';

const DATA_DIR = PATHS.data;
const REPOS_FILE = join(DATA_DIR, 'github-repos.json');
const CONCURRENCY = 3;

let cache = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 2000;

const defaultData = () => ({
  repos: {},
  secrets: {},
  lastRepoSync: null,
  githubUser: 'atomantic'
});

async function load() {
  const now = Date.now();
  if (cache && (now - cacheTimestamp) < CACHE_TTL_MS) return cache;
  await ensureDir(DATA_DIR);
  cache = await readJSONFile(REPOS_FILE, defaultData());
  cacheTimestamp = now;
  return cache;
}

async function save(data) {
  await ensureDir(DATA_DIR);
  await writeFile(REPOS_FILE, JSON.stringify(data, null, 2) + '\n');
  cache = data;
  cacheTimestamp = Date.now();
}

/**
 * Execute a gh CLI command safely using spawn
 */
function execGh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `gh exited with code ${code}`));
      } else {
        resolve(stdout.trim());
      }
    });
    child.on('error', (err) => reject(err));
  });
}

/**
 * Run tasks with limited concurrency
 */
async function runWithConcurrency(tasks, limit) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

/**
 * Sync repos from GitHub using gh CLI
 */
export async function syncRepos() {
  const data = await load();
  const owner = data.githubUser || 'atomantic';
  const raw = await execGh([
    'repo', 'list', owner, '--limit', '200',
    '--json', 'name,nameWithOwner,description,pushedAt,isArchived,isPrivate,isFork,parent,licenseInfo'
  ]);
  const remoteRepos = JSON.parse(raw);

  // Build set of remote repo names to detect deletions
  const remoteNames = new Set();

  for (const repo of remoteRepos) {
    const fullName = repo.nameWithOwner;
    remoteNames.add(fullName);
    const existing = data.repos[fullName] || {};
    data.repos[fullName] = {
      name: repo.name,
      fullName,
      description: repo.description || '',
      isArchived: repo.isArchived,
      isPrivate: repo.isPrivate,
      isFork: repo.isFork,
      forkSource: repo.parent ? `${repo.parent.owner.login}/${repo.parent.name}` : null,
      pushedAt: repo.pushedAt,
      license: repo.licenseInfo?.name || null,
      flags: existing.flags || {},
      managedSecrets: existing.managedSecrets || [],
      lastSecretSync: existing.lastSecretSync || null
    };
  }

  // Remove repos that no longer exist on GitHub
  const removed = Object.keys(data.repos).filter(name => !remoteNames.has(name));
  for (const name of removed) {
    delete data.repos[name];
  }

  data.lastRepoSync = new Date().toISOString();
  await save(data);
  const removedMsg = removed.length ? `, removed ${removed.length} deleted` : '';
  console.log(`🔄 Synced ${remoteRepos.length} repos from GitHub${removedMsg}`);
  return data;
}

/**
 * Get cached repo list
 */
export async function getRepos() {
  const data = await load();
  return data.repos;
}

/**
 * Update repo flags and managed secrets
 */
export async function updateRepoFlags(fullName, updates) {
  const data = await load();
  const repo = data.repos[fullName];
  if (!repo) throw new ServerError(`Repo not found: ${fullName}`, { status: 404, code: 'REPO_NOT_FOUND' });

  if (updates.flags) {
    repo.flags = { ...repo.flags, ...updates.flags };

    // Auto-manage NPM_TOKEN based on npmProject flag
    if (updates.flags.npmProject === true && !repo.managedSecrets.includes('NPM_TOKEN')) {
      repo.managedSecrets.push('NPM_TOKEN');
    } else if (updates.flags.npmProject === false) {
      repo.managedSecrets = repo.managedSecrets.filter(s => s !== 'NPM_TOKEN');
    }
  }

  if (updates.managedSecrets) {
    repo.managedSecrets = updates.managedSecrets;
  }

  await save(data);
  return repo;
}

/**
 * Set a secret value and sync to all repos with it in managedSecrets
 */
export async function setSecret(name, value) {
  // Store value in settings.json (never returned to client)
  const settings = await getSettings();
  const secrets = settings.secrets || {};
  secrets[name] = value;
  await updateSettings({ secrets });

  // Update metadata in github-repos.json
  const data = await load();
  data.secrets[name] = {
    hasValue: true,
    updatedAt: new Date().toISOString()
  };
  await save(data);

  // Sync to repos
  const result = await syncSecretToRepos(name);
  return result;
}

/**
 * Sync a secret to all repos that have it in managedSecrets
 */
export async function syncSecretToRepos(name) {
  const settings = await getSettings();
  const value = settings.secrets?.[name];
  if (!value) throw new ServerError(`No value stored for secret: ${name}`, { status: 400, code: 'SECRET_NOT_CONFIGURED' });

  const data = await load();
  const targetRepos = Object.values(data.repos).filter(
    r => r.managedSecrets.includes(name) && !r.isArchived
  );

  if (targetRepos.length === 0) {
    return { synced: 0, failed: 0, errors: [] };
  }

  let synced = 0;
  let failed = 0;
  const errors = [];
  const succeeded = new Set();

  const tasks = targetRepos.map(repo => async () => {
    const result = await syncOneSecret(name, value, repo.fullName);
    if (result.success) {
      synced++;
      succeeded.add(repo.fullName);
    } else {
      failed++;
      errors.push({ repo: repo.fullName, error: result.error });
    }
  });

  await runWithConcurrency(tasks, CONCURRENCY);

  // Update last sync timestamp only on repos where sync succeeded
  for (const fullName of succeeded) {
    if (data.repos[fullName]) {
      data.repos[fullName].lastSecretSync = new Date().toISOString();
    }
  }
  await save(data);

  console.log(`🔑 Secret ${name} synced to ${synced} repos (${failed} failed)`);
  return { synced, failed, errors };
}

/**
 * Sync a single secret to a single repo via stdin pipe
 */
function syncOneSecret(name, value, fullName) {
  return new Promise((resolve) => {
    const child = spawn('gh', ['secret', 'set', name, '--repo', fullName], {
      shell: false,
      windowsHide: true
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: stderr.trim() || `exit code ${code}` });
      }
    });
    child.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
    child.stdin.write(value);
    child.stdin.end();
  });
}

/**
 * Archive or unarchive a repo on GitHub
 */
export async function setRepoArchived(fullName, archived) {
  const cmd = archived ? 'archive' : 'unarchive';
  await execGh(['repo', cmd, fullName, '--yes']);

  // Update local cache
  const data = await load();
  if (data.repos[fullName]) {
    data.repos[fullName].isArchived = archived;
    await save(data);
  }

  console.log(`📦 ${archived ? 'Archived' : 'Unarchived'} ${fullName}`);
  return data.repos[fullName] || { fullName, isArchived: archived };
}

/**
 * Get secret metadata (no values)
 */
export async function getSecrets() {
  const data = await load();
  return data.secrets;
}

/**
 * Get sync status summary
 */
export async function getStatus() {
  const data = await load();
  const repos = Object.values(data.repos);
  return {
    lastRepoSync: data.lastRepoSync,
    totalRepos: repos.length,
    activeRepos: repos.filter(r => !r.isArchived).length,
    npmProjects: repos.filter(r => r.flags?.npmProject).length,
    reposWithSecrets: repos.filter(r => r.managedSecrets?.length > 0).length,
    secretCount: Object.keys(data.secrets).length
  };
}
