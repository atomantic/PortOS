import { readFile } from 'fs/promises';
import { join } from 'path';
import { validateProposedDiff, applyDiffToLive, revertDiffFromLive } from './sandbox.js';
import { writeHistoryJson } from './historyFiles.js';

// Session IDs name a directory under sessions/, so they stay inside one
// filesystem-safe segment. PM2 names may contain dots (lib/pm2ProcessName.js);
// new IDs encode each dot as `_2e_` and keep the real name in metadata.
const SESSION_ID_RE = /^autofixer_[A-Za-z0-9_-]+$/;
// Compatibility for IDs generated before the encoding, which embedded the raw
// name. Anchored on the generated `_<epoch ms>_<base36>` suffix and still free
// of any path separator, so malformed or unrelated directories stay ineligible.
const LEGACY_DOTTED_SESSION_ID_RE = /^autofixer_[A-Za-z0-9_][A-Za-z0-9._-]*\.[A-Za-z0-9._-]*_\d+_[a-z0-9]+$/;

export const isAutofixerSessionId = id => typeof id === 'string'
  && (SESSION_ID_RE.test(id) || LEGACY_DOTTED_SESSION_ID_RE.test(id));

export const buildAutofixerSessionId = (processName, now = Date.now(), random = Math.random()) =>
  `autofixer_${processName.replaceAll('.', '_2e_')}_${now}_${random.toString(36).slice(2, 11)}`;

// Best-effort inverse for recovering a name from an ID when no metadata exists.
export const processNameFromSessionId = (id) => {
  const encoded = typeof id === 'string' ? id.match(/^autofixer_(.+)_\d+_[a-z0-9]+$/)?.[1] : null;
  return encoded ? encoded.replaceAll('_2e_', '.') : null;
};

// Session metadata is the authority for patch disposition. The history index is
// written by the monitor. Manual and automatic promotion share this queue so
// applying, restarting and rolling back one patch cannot overlap another.
export function createStagedFixStore({ root, loadApps, execPm2 }) {
  let tail = Promise.resolve();
  let stopping = false;
  let patchInProgress = false;
  const restarting = new Set();
  const serialize = (operation) => {
    const run = tail.then(() => {
      if (stopping) throw new Error('Autofixer is shutting down');
      return operation();
    });
    tail = run.catch(() => {});
    return run;
  };
  const withPatchTransaction = async (operation) => {
    if (stopping) throw new Error('Autofixer is shutting down');
    patchInProgress = true;
    try {
      return await operation();
    } finally {
      patchInProgress = false;
    }
  };
  const serializePatch = operation => serialize(() => withPatchTransaction(operation));
  const sessionDir = id => isAutofixerSessionId(id) ? join(root, 'sessions', id) : null;
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
    if (action !== 'apply') {
      await save(id, { ...record, staged: false, promoted: false, disposition: 'discarded' });
      return { success: true, disposition: 'discarded' };
    }
    const app = (await loadApps()).find(app => app.id === record.appId
      && app.repoPath === record.repoPath && app.pm2ProcessNames?.includes(record.processName));
    if (!app) return { status: 409, error: 'The original registered app or process has changed' };
    const validation = validateProposedDiff(patch, { maxBytes: 200 * 1024 });
    if (!validation.ok) return { status: 409, error: validation.reason };
    return withPatchTransaction(async () => {
      const applied = await applyDiffToLive(app.repoPath, patch, root);
      if (!applied.ok) return { status: 409, error: applied.error };
      const rollback = async (error) => {
        const reverted = await revertDiffFromLive(app.repoPath, patch, root);
        // A failed rollback must not advertise this patch as safe to apply again.
        if (reverted.error) {
          await save(id, { ...record, staged: false, disposition: 'recovery-required', error: reverted.error });
        } else if (record.processName === 'portos-autofixer') {
          await save(id, record);
        }
        return `Restart failed: ${error}${reverted.error ? '; rollback failed — inspect the checkout' : '; patch rolled back'}`;
      };
      const updated = { ...record, staged: false, promoted: true, disposition: 'applied' };
      if (record.processName === 'portos-autofixer') {
        // Commit the applied disposition before dispatching a restart that
        // waits for this daemon to exit. The shutdown drain cannot await it.
        restarting.add(id);
        try {
          await save(id, updated);
        } catch (error) {
          restarting.delete(id);
          throw error;
        }
        void execPm2(['restart', record.processName])
          .catch(error => serializePatch(() => rollback(error.message)))
          .then(message => { if (message) console.error(`❌ [Autofixer] ${message}`); })
          .catch(error => console.error(`❌ [Autofixer] Could not reconcile self-restart: ${error.message}`))
          .finally(() => restarting.delete(id));
        return { success: true, disposition: 'applied', status: 202 };
      }
      const restart = await execPm2(['restart', record.processName]).catch(error => ({ error: error.message }));
      if (restart.error) return { status: 500, error: await rollback(restart.error) };
      await save(id, updated);
      return { success: true, disposition: 'applied' };
    });
  };
  const save = (id, record) => writeHistoryJson(join(sessionDir(id), 'metadata.json'), record);
  return {
    read,
    serialize,
    serializePatch,
    hasActivePatch: () => patchInProgress,
    async canPrune(id) {
      const dir = sessionDir(id);
      if (!dir || restarting.has(id)) return false;
      try {
        const record = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8'));
        return record?.staged !== true && !restarting.has(id);
      } catch (error) {
        // A partial session can have no metadata. Other failures leave its
        // staged disposition unknown until a later cleanup pass.
        if (error.code === 'ENOENT') return !restarting.has(id);
        throw error;
      }
    },
    stopMutations: () => {
      stopping = true;
      return tail;
    },
    mutate: (id, action) => serialize(() => perform(id, action)),
    decorateHistory: async (history) => Promise.all(history.map(async entry => {
      const record = await metadata(entry.sessionId);
      return record ? { ...entry, staged: record.staged, promoted: record.promoted, disposition: record.disposition } : entry;
    })),
  };
}
