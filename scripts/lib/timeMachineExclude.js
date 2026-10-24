/** Fixed paths survive deletion/recreation; never derive these from Spotlight's archive exclusions. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

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

/** Best-effort setup: no directory creation, exclusion removal, or install failure. */
export function excludeFromTimeMachine(installRoot, {
  platform = process.platform,
  run = spawnSync,
  env = process.env,
} = {}) {
  if (platform !== 'darwin') return { status: 'unsupported' };
  if (env.PORTOS_SKIP_TIMEMACHINE_EXCLUDE === '1') return { status: 'skipped' };
  const result = { status: 'present', added: 0, excluded: 0, failures: [] };
  let authenticated = false;
  let authenticationError = null;
  const options = { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], timeout: 30_000 };
  for (const relativePath of TIME_MACHINE_EXCLUDED_DIRS) {
    const path = resolve(installRoot, relativePath);
    if (authenticationError) {
      result.failures.push({ path, error: authenticationError });
      continue;
    }
    try {
      const check = run('tmutil', ['isexcluded', path], options);
      if (check.status === 0 && check.stdout?.includes('[Excluded]')) {
        result.excluded++;
        continue;
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
      } else {
        result.failures.push({ path, error: add.error?.message || add.stderr?.trim() || `sudo exited with status ${add.status}` });
      }
    } catch (error) {
      // An unavailable process runner is also a best-effort setup failure.
      result.failures.push({ path, error: error.message });
    }
  }
  result.status = result.failures.length ? 'partial' : result.added ? 'updated' : 'present';
  return result;
}
