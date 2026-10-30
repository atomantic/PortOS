/** Fixed paths survive deletion/recreation; never derive these from Spotlight's archive exclusions. */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

// Separate from rsync's glob policy: tmutil cannot exclude regenerable files
// inside a creative directory without also losing its irreplaceable contents.
export const TIME_MACHINE_EXCLUDED_DIRS = [
  'data/browser-profile',
  'data/cache',
  'data/browser-downloads',
  'data/code-animation-workspaces',
  'data/code-animation-exports',
  'data/composition-proofs',
  'data/music-video-compositions',
  'data/music-video-film-look',
  'data/music-video-stats-outro',
  'data/music-video-segments',
  'data/music-video-song-renders',
  'data/supercollider',
  'data/federated-media-inbox',
  'data/cos/slashdo-resolved',
  'data/cos/reference-repos',
  'data/cos/worktrees',
  'data/cos/initialized-checkout-fixtures',
  'data/autofixer/worktrees',
  'data/backup-admission',
  'data/model-tests/sandboxes',
  'data/image-thumbnails',
  'data/video-thumbnails',
  'data/python',
  'data/repos',
  // Deployed adapters live in data/loras, which deliberately stays backed up.
  'data/training-runs',
  'data/venvs',
  'data/jev/corpora',
  'data/jev/embeddings',
  'tmp',
  'models',
  'node_modules',
  'client/node_modules',
  'server/node_modules',
  'autofixer/node_modules',
  'scripts/node_modules',
  'browser/node_modules',
];

const PREFERENCE_FILE = 'data/time-machine-exclusions.json';

/**
 * Machine-local answer to "exclude these from Time Machine?": 'accepted' | 'declined' | null (never asked),
 * plus the fixed paths already added. `tmutil isexcluded` reports [UNKNOWN] for a path that no longer
 * exists even though its fixed-path exclusion persists, so without this record a directory that is
 * deleted between runs would re-trigger the sudo prompt on every update.
 */
export function createFilePreference(installRoot) {
  const file = resolve(installRoot, PREFERENCE_FILE);
  const read = () => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) ?? {};
    } catch {
      return {};
    }
  };
  const write = (state) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  };
  return {
    get() {
      const { decision } = read();
      return decision === 'accepted' || decision === 'declined' ? decision : null;
    },
    set(decision) {
      write({ ...read(), decision, decidedAt: new Date().toISOString() });
    },
    added() {
      const { added } = read();
      return new Set(Array.isArray(added) ? added : []);
    },
    markAdded(relativePaths) {
      write({ ...read(), added: [...new Set([...this.added(), ...relativePaths])].sort() });
    },
  };
}

/**
 * Ask on the controlling terminal. update.sh routes stdout/stderr to its log, so
 * the question goes to /dev/tty directly; with no terminal (UI-driven update, CI)
 * it returns null and the caller neither prompts nor records a decision.
 */
export function confirmOnTty(count, { open = openSync, write = writeSync, read = readSync, close = closeSync } = {}) {
  let fd;
  try {
    fd = open('/dev/tty', 'r+');
    write(fd, `\n💾 PortOS can exclude ${count} regenerable directories (node_modules, caches, render scratch) from Time Machine.\n   Creates any that are missing; needs sudo once. Your answer is remembered. Exclude them? [Y/n] `);
    const buf = Buffer.alloc(64);
    const bytes = read(fd, buf, 0, buf.length, null);
    if (bytes === 0) return null; // Ctrl-D: cancelled, not consent
    const answer = buf.toString('utf8', 0, bytes).trim().toLowerCase();
    return answer === 'n' || answer === 'no' ? 'no' : 'yes';
  } catch {
    return null;
  } finally {
    if (fd !== undefined) close(fd);
  }
}

/** Best-effort setup: no install failure; asks once, creates missing dirs only after consent. */
export function excludeFromTimeMachine(installRoot, {
  platform = process.platform,
  run = spawnSync,
  env = process.env,
  exists = existsSync,
  mkdir = mkdirSync,
  preference = createFilePreference(installRoot),
  confirm = confirmOnTty,
} = {}) {
  if (platform !== 'darwin') return { status: 'unsupported' };
  if (env.PORTOS_SKIP_TIMEMACHINE_EXCLUDE === '1') return { status: 'skipped' };
  const result = { status: 'present', added: 0, excluded: 0, created: 0, failures: [] };
  const options = { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], timeout: 30_000 };
  const pending = [];
  const recorded = preference.added?.() ?? new Set();
  for (const relativePath of TIME_MACHINE_EXCLUDED_DIRS) {
    const path = resolve(installRoot, relativePath);
    try {
      if (!exists(path) && recorded.has(relativePath)) {
        result.excluded++;
        continue;
      }
      if (exists(path)) {
        const check = run('tmutil', ['isexcluded', path], options);
        if (check.status === 0 && check.stdout?.includes('[Excluded]')) {
          result.excluded++;
          continue;
        }
      }
      pending.push(path);
    } catch (error) {
      // An unavailable process runner is also a best-effort setup failure.
      result.failures.push({ path, error: error.message });
    }
  }
  if (!pending.length) {
    result.status = result.failures.length ? 'partial' : 'present';
    return result;
  }

  let decision = preference.get();
  if (!decision) {
    const answer = confirm(pending.length);
    if (!answer) return { ...result, status: 'undecided', pending: pending.length };
    decision = answer === 'no' ? 'declined' : 'accepted';
    try { preference.set(decision); } catch (error) { result.failures.push({ path: PREFERENCE_FILE, error: error.message }); }
  }
  if (decision === 'declined') return { ...result, status: 'declined', pending: pending.length };

  const addedRelative = [];
  let authenticated = false;
  let authenticationError = null;
  for (const path of pending) {
    if (authenticationError) {
      result.failures.push({ path, error: authenticationError });
      continue;
    }
    try {
      // tmutil cannot exclude a path that does not exist; the fixed-path exclusion
      // then survives the directory being deleted and recreated.
      if (!exists(path)) {
        mkdir(path, { recursive: true });
        result.created++;
      }
      if (!authenticated) {
        const auth = run('sudo', ['-v'], options);
        if (auth.status !== 0) {
          authenticationError = auth.error?.message || auth.stderr?.trim() || `sudo exited with status ${auth.status}`;
          result.failures.push({ path, error: authenticationError });
          continue;
        }
        authenticated = true;
      }
      const add = run('sudo', ['--', 'tmutil', 'addexclusion', '-p', path], options);
      if (add.status === 0) {
        result.added++;
        addedRelative.push(relative(installRoot, path));
      } else {
        result.failures.push({ path, error: add.error?.message || add.stderr?.trim() || `sudo exited with status ${add.status}` });
      }
    } catch (error) {
      result.failures.push({ path, error: error.message });
    }
  }
  if (addedRelative.length) {
    try { preference.markAdded?.(addedRelative); } catch (error) { result.failures.push({ path: PREFERENCE_FILE, error: error.message }); }
  }
  result.status = result.failures.length ? 'partial' : result.added ? 'updated' : 'present';
  return result;
}
