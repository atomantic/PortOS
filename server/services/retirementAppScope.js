import { stat } from 'fs/promises';

/** A repository path grants no app identity; retirement needs one exact registry match. */
export async function resolveRetirementApp(repoPath) {
  const { getAllApps } = await import('./apps.js');
  const apps = await getAllApps().catch(() => null);
  if (!Array.isArray(apps)) return { reason: 'retirement-app-registry-unavailable' };
  const root = await stat(repoPath, { bigint: true }).catch(() => null);
  if (!root?.isDirectory() || root.ino === 0n) return { reason: 'retirement-repository-unavailable' };
  const matches = [];
  for (const app of apps) {
    if (typeof app?.repoPath !== 'string' || !app.repoPath) continue;
    const info = await stat(app.repoPath, { bigint: true }).catch(() => null);
    // Compare physical directories, including symlink and Windows short-name aliases.
    if (info?.isDirectory() && info.dev === root.dev && info.ino === root.ino) matches.push(app);
  }
  if (matches.length > 1) return { reason: 'retirement-app-ambiguous' };
  if (!matches[0]?.id) return { reason: 'retirement-app-unavailable' };
  return { app: matches[0] };
}
