import { spawn } from 'child_process';

/**
 * Execute a git command safely using spawn (prevents shell injection)
 * @param {string[]} args - Git command arguments
 * @param {string} cwd - Working directory
 * @param {object} options - Additional options
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function execGit(args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      shell: false,
      maxBuffer: options.maxBuffer || 10 * 1024 * 1024
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
      if (code !== 0 && !options.ignoreExitCode) {
        reject(new Error(stderr || `git exited with code ${code}`));
      } else {
        resolve({ stdout, stderr });
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Get git status for a directory
 */
export async function getStatus(dir) {
  const result = await execGit(['status', '--porcelain'], dir);
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
  const result = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  return result.stdout.trim();
}

/**
 * Get recent commits
 */
export async function getCommits(dir, limit = 10) {
  // Validate limit is a positive integer to prevent injection
  const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 10));
  const format = '--format={"hash":"%h","message":"%s","author":"%an","date":"%ci"}';
  const result = await execGit(['log', format, '-n', String(safeLimit)], dir);

  const commits = result.stdout.trim().split('\n').filter(Boolean).map(line => {
    return JSON.parse(line);
  });

  return commits;
}

/**
 * Get diff for unstaged changes
 */
export async function getDiff(dir, staged = false) {
  const args = staged ? ['diff', '--cached'] : ['diff'];
  const result = await execGit(args, dir, { maxBuffer: 10 * 1024 * 1024 });
  return result.stdout;
}

/**
 * Get diff stats
 */
export async function getDiffStats(dir) {
  const result = await execGit(['diff', '--stat'], dir);
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
 * Validate file paths to prevent command injection and path traversal
 * @param {string[]} files - Array of file paths
 * @returns {string[]} - Sanitized file paths
 */
function validateFilePaths(files) {
  const fileList = Array.isArray(files) ? files : [files];
  return fileList.map(f => {
    // Reject paths with null bytes or command separators
    if (/[\0;|&`$]/.test(f)) {
      throw new Error(`Invalid character in file path: ${f}`);
    }
    // Reject absolute paths or parent directory traversal
    if (f.startsWith('/') || f.includes('..')) {
      throw new Error(`Invalid file path: ${f}`);
    }
    return f;
  });
}

/**
 * Stage files
 */
export async function stageFiles(dir, files) {
  const safePaths = validateFilePaths(files);
  await execGit(['add', '--', ...safePaths], dir);
  return true;
}

/**
 * Unstage files
 */
export async function unstageFiles(dir, files) {
  const safePaths = validateFilePaths(files);
  await execGit(['reset', 'HEAD', '--', ...safePaths], dir);
  return true;
}

/**
 * Create commit
 */
export async function commit(dir, message) {
  // Using spawn with -m argument passes message safely without shell interpretation
  const result = await execGit(['commit', '-m', message], dir);
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
  const result = await execGit(['rev-parse', '--is-inside-work-tree'], dir, { ignoreExitCode: true }).catch(() => null);
  return result?.stdout.trim() === 'true';
}

/**
 * Get remote info
 */
export async function getRemote(dir) {
  const result = await execGit(['remote', '-v'], dir, { ignoreExitCode: true }).catch(() => null);
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
