import { readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { validateProposedDiff, applyDiffToLive, revertDiffFromLive } from './sandbox.js';

// Session metadata is the authority for patch disposition. The history index is
// append-only from the daemon's perspective, so UI actions never overwrite it.
export function createStagedFixStore({ root, loadApps, execPm2 }) {
  let tail = Promise.resolve();
  const sessionDir = (id) => typeof id === 'string' && /^autofixer_[A-Za-z0-9_-]+$/.test(id)
    ? join(root, 'sessions', id) : null;
  const metadata = async (id) => {
    const dir = sessionDir(id);
    if (!dir) return null;
    return readFile(join(dir, 'metadata.json'), 'utf8').then(JSON.parse).catch(() => null);
  };
  const read = async (id) => {
    const record = await metadata(id);
    if (!record || record.sessionId !== id || record.staged !== true) {
      return { status: 404, error: 'No staged fix found' };
    }
    const patch = await readFile(join(sessionDir(id), 'fix.patch'), 'utf8').catch(() => null);
    if (!patch) return { status: 404, error: 'Staged patch is unavailable' };
    return { record, patch };
  };
  const perform = async (id, action) => {
    const fix = await read(id);
    if (fix.error) return fix;
    const { record, patch } = fix;
    let disposition = 'discarded';
    if (action === 'apply') {
      const app = (await loadApps()).find(app => app.id === record.appId
        && app.repoPath === record.repoPath && app.pm2ProcessNames?.includes(record.processName));
      if (!app) return { status: 409, error: 'The original registered app or process has changed' };
      const validation = validateProposedDiff(patch, { maxBytes: 200 * 1024 });
      if (!validation.ok) return { status: 409, error: validation.reason };
      const applied = await applyDiffToLive(app.repoPath, patch, root);
      if (!applied.ok) return { status: 409, error: applied.error };
      const restart = await execPm2(['restart', record.processName]).catch(error => ({ error: error.message }));
      if (restart.error) {
        const rollback = await revertDiffFromLive(app.repoPath, patch, root);
        // A failed rollback must not advertise this patch as safe to apply again.
        if (rollback.error) {
          await save(id, { ...record, staged: false, disposition: 'recovery-required', error: rollback.error });
        }
        return { status: 500, error: `Restart failed: ${restart.error}${rollback.error ? '; rollback failed — inspect the checkout' : '; patch rolled back'}` };
      }
      disposition = 'applied';
    }
    const updated = { ...record, staged: false, promoted: disposition === 'applied', disposition };
    await save(id, updated);
    return { success: true, disposition };
  };
  const save = async (id, record) => {
    const destination = join(sessionDir(id), 'metadata.json');
    await writeFile(`${destination}.tmp`, JSON.stringify(record, null, 2));
    await rename(`${destination}.tmp`, destination);
  };
  return {
    read,
    mutate: (id, action) => {
      const run = tail.then(() => perform(id, action));
      tail = run.catch(() => {});
      return run;
    },
    decorateHistory: async (history) => Promise.all(history.map(async entry => {
      const record = await metadata(entry.sessionId);
      return record ? { ...entry, staged: record.staged, promoted: record.promoted, disposition: record.disposition } : entry;
    })),
  };
}
