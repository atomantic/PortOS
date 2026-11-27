/** Group a Codex claim's durable thread without changing its execution worktree. */
import { createHash } from 'crypto';
import { realpath } from 'fs/promises';
import { setTimeout as delay } from 'timers/promises';
import { basename, isAbsolute, resolve } from 'path';

const MAX_PROJECT_PAGES = 12;
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const stableRoot = async path => {
  if (typeof path !== 'string' || !isAbsolute(path)) return null;
  const full = await realpath(path).catch(() => resolve(path));
  return process.platform === 'win32' ? full.toLowerCase() : full;
};

async function projectMatchesRoot(project, root) {
  const paths = await Promise.all((project?.roots ?? []).map(value => stableRoot(value.path)));
  return paths.includes(root);
}

async function projectCandidates(request, repoRoot, checkout) {
  const projects = [];
  let cursor = null;
  for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
    const result = await request('project/list', { limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data)) return null;
    projects.push(...result.data);
    cursor = result.nextCursor;
    if (!cursor) {
      const app = (await Promise.all(projects.map(async p => [p, await projectMatchesRoot(p, repoRoot)])))
        .filter(([, matches]) => matches).map(([p]) => p);
      const ephemeral = (await Promise.all(projects.map(async p => [p, await projectMatchesRoot(p, checkout)])))
        .filter(([, matches]) => matches).map(([p]) => p);
      return { app, ephemeral };
    }
  }
  return null;
}

export async function groupCodexClaimProject({
  request, repoPath, workspacePath, appName, startedAt,
  sourceKind, now = () => Date.now(),
  waits = [0, 750, 1750, 3500, 7000, 14000, 25000, 35000],
  sleep = ms => delay(ms, undefined, { ref: false }),
}) {
  if (!['cli', 'exec'].includes(sourceKind) || !Number.isFinite(startedAt)) return { status: 'ineligible' };
  const [repoRoot, checkout] = await Promise.all([stableRoot(repoPath), stableRoot(workspacePath)]);
  if (!repoRoot || !checkout || repoRoot === checkout) return { status: 'ineligible' };

  for (const wait of waits) {
    if (wait) await sleep(wait);
    // Codex does not publish a brand-new empty thread until its first turn.
    // Match only a new root in the actual claim checkout, never by prompt title.
    const result = await request('thread/list', { cwd: checkout, sourceKinds: [sourceKind], limit: 30 });
    if (!Array.isArray(result?.data)) return { status: 'unsupported' };
    const possible = result.data.filter(t => UUID.test(t?.id) && !t.parentThreadId && !t.forkedFromId
      && t.createdAt >= Math.floor(startedAt / 1000) && t.createdAt <= Math.ceil(now() / 1000));
    const matched = (await Promise.all(possible.map(async t => [t, await stableRoot(t.cwd)])))
      .filter(([, cwd]) => cwd === checkout).map(([thread]) => thread);
    if (matched.length > 1 || result.nextCursor) return { status: 'ambiguous' };
    if (!matched.length) continue;
    const thread = matched[0];
    const projects = await projectCandidates(request, repoRoot, checkout);
    if (!projects || projects.app.length > 1) return { status: 'ambiguous' };
    let app = projects.app[0];
    if (app?.id && app.id === thread.projectId) return { status: 'already-grouped' };

    // Respect a manually assigned project. Only take over an unassigned thread
    // or one grouped under its individual checkout by Codex.
    if (thread.projectId && !projects.ephemeral.some(project => project.id === thread.projectId)) {
      return { status: 'already-assigned' };
    }

    if (!app) {
      const idempotencyKey = `portos-claim-${createHash('sha256').update(repoRoot).digest('hex')}`;
      const created = await request('project/create', {
        name: (appName?.trim() || basename(repoRoot)).slice(0, 100), roots: [{ path: repoRoot }], idempotencyKey,
      });
      app = created?.project;
      if (!app?.id || !await projectMatchesRoot(app, repoRoot)) return { status: 'unverified' };
    }
    const updated = await request('thread/metadata/update', { threadId: thread.id, projectId: app.id });
    return { status: updated?.thread?.projectId === app.id ? 'grouped' : 'unverified' };
  }
  return { status: 'not-found' };
}
