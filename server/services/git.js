import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Get git status for a directory
 */
export async function getStatus(dir) {
  const result = await execAsync('git status --porcelain', { cwd: dir });
  const lines = result.stdout.trim().split('\n').filter(Boolean);

  const files = lines.map(line => {
    const status = line.substring(0, 2);
    const path = line.substring(3);
    return {
      path,
      status: parseStatus(status),
      staged: status[0] !== ' ' && status[0] !== '?',
      modified: status[1] === 'M',
      added: status[0] === 'A' || status === '??',
      deleted: status[0] === 'D' || status[1] === 'D'
    };
  });

  return {
    clean: files.length === 0,
    files,
    staged: files.filter(f => f.staged).length,
    unstaged: files.filter(f => !f.staged).length
  };
}

function parseStatus(status) {
  const map = {
    '??': 'untracked',
    'A ': 'added',
    'M ': 'modified (staged)',
    ' M': 'modified',
    'MM': 'modified (partial)',
    'D ': 'deleted (staged)',
    ' D': 'deleted',
    'R ': 'renamed',
    'C ': 'copied',
    'AM': 'added (modified)',
    'AD': 'added (deleted)'
  };
  return map[status] || status.trim();
}

/**
 * Get current branch name
 */
export async function getBranch(dir) {
  const result = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: dir });
  return result.stdout.trim();
}

/**
 * Get recent commits
 */
export async function getCommits(dir, limit = 10) {
  const format = '--format={"hash":"%h","message":"%s","author":"%an","date":"%ci"}';
  const result = await execAsync(`git log ${format} -n ${limit}`, { cwd: dir });

  const commits = result.stdout.trim().split('\n').filter(Boolean).map(line => {
    return JSON.parse(line);
  });

  return commits;
}

/**
 * Get diff for unstaged changes
 */
export async function getDiff(dir, staged = false) {
  const cmd = staged ? 'git diff --cached' : 'git diff';
  const result = await execAsync(cmd, { cwd: dir, maxBuffer: 10 * 1024 * 1024 });
  return result.stdout;
}

/**
 * Get diff stats
 */
export async function getDiffStats(dir) {
  const result = await execAsync('git diff --stat', { cwd: dir });
  const statsLine = result.stdout.trim().split('\n').pop() || '';

  const filesMatch = statsLine.match(/(\d+) files? changed/);
  const insertionsMatch = statsLine.match(/(\d+) insertions?/);
  const deletionsMatch = statsLine.match(/(\d+) deletions?/);

  return {
    files: filesMatch ? parseInt(filesMatch[1]) : 0,
    insertions: insertionsMatch ? parseInt(insertionsMatch[1]) : 0,
    deletions: deletionsMatch ? parseInt(deletionsMatch[1]) : 0
  };
}

/**
 * Stage files
 */
export async function stageFiles(dir, files) {
  const paths = Array.isArray(files) ? files.join(' ') : files;
  await execAsync(`git add ${paths}`, { cwd: dir });
  return true;
}

/**
 * Unstage files
 */
export async function unstageFiles(dir, files) {
  const paths = Array.isArray(files) ? files.join(' ') : files;
  await execAsync(`git reset HEAD ${paths}`, { cwd: dir });
  return true;
}

/**
 * Create commit
 */
export async function commit(dir, message) {
  const result = await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: dir });
  const hashMatch = result.stdout.match(/\[[\w-]+ ([a-f0-9]+)\]/);
  return {
    hash: hashMatch ? hashMatch[1] : null,
    message
  };
}

/**
 * Check if directory is a git repo
 */
export async function isRepo(dir) {
  const result = await execAsync('git rev-parse --is-inside-work-tree', { cwd: dir }).catch(() => null);
  return result?.stdout.trim() === 'true';
}

/**
 * Get remote info
 */
export async function getRemote(dir) {
  const result = await execAsync('git remote -v', { cwd: dir }).catch(() => null);
  if (!result) return null;

  const lines = result.stdout.trim().split('\n');
  const origins = {};

  lines.forEach(line => {
    const [name, url, type] = line.split(/\s+/);
    if (!origins[name]) origins[name] = {};
    origins[name][type?.replace(/[()]/g, '')] = url;
  });

  return origins;
}

/**
 * Get comprehensive git info
 */
export async function getGitInfo(dir) {
  const [isGit, branch, status, commits, diffStats, remote] = await Promise.all([
    isRepo(dir),
    getBranch(dir).catch(() => null),
    getStatus(dir).catch(() => ({ clean: true, files: [] })),
    getCommits(dir, 5).catch(() => []),
    getDiffStats(dir).catch(() => ({ files: 0, insertions: 0, deletions: 0 })),
    getRemote(dir).catch(() => null)
  ]);

  return {
    isRepo: isGit,
    branch,
    status,
    recentCommits: commits,
    diffStats,
    remote
  };
}
