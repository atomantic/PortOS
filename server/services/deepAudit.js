/** Machine-local, DB-primary coverage evidence. No timers or provider calls. */
import { join } from 'path';
import { ensureSchema, query, withTransaction } from '../lib/db.js';
import { execGit } from '../lib/execGit.js';
import { atomicWrite, PATHS } from '../lib/fileUtils.js';
import { tryReadFile } from '../lib/jsonIo.js';
import { canonicalSnapshotChecksum } from '../lib/snapshotChecksum.js';
import { normalizeAuditTaskType, isAuditTaskType } from '../lib/auditCatalog.js';
import { createDeepAuditLedger, assignDeepAuditAttempt, deepAuditProgress, deepAuditInstructions,
  mergeDeepAuditReport, refreshDeepAuditScope, DEEP_AUDIT_VERSION } from '../lib/deepAudit.js';
import { PROMPT_VERSIONS } from './taskPromptDefaults/versions.js';
import { resolveTaskHookType } from './taskTypeHooks.js';

function deepAuditId(task) {
  const meta = task.metadata || {};
  return meta.deepAuditId || meta.quotaBurnStepId || (meta.app
    ? `deep-${canonicalSnapshotChecksum({ app: meta.app, category: resolveTaskHookType(task) || 'code-quality', job: meta.jobId || null, fileIssues: meta.fileIssues === true || meta.fileIssues === 'true' }).slice(0, 32)}`
    : task.id);
}

function deepAuditPaths(_workspacePath, agentId) {
  const prefix = `.portos-deep-${canonicalSnapshotChecksum(agentId).slice(0, 24)}`;
  const directory = join(PATHS.cos, 'deep-audit-checkpoints');
  return { ledgerPath: join(directory, `${prefix}-ledger.json`), reportPath: join(directory, `${prefix}-report.json`) };
}

async function inventoryDeepAudit(workspacePath, { promptHash, category }) {
  if ((await execGit(['rev-parse', '--show-prefix'], workspacePath)).stdout.trim()) throw new Error('Deep inventory requires an initialized repository root');
  const revision = (await execGit(['rev-parse', 'HEAD'], workspacePath)).stdout.trim();
  const tree = (await execGit(['ls-tree', '-rz', '--full-tree', revision], workspacePath)).stdout;
  let files = tree.split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t');
    const [mode, kind, blob] = entry.slice(0, tab).split(' ');
    return { path: entry.slice(tab + 1), blob, mode, kind };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const nested = [];
  for (const entry of files.filter(file => file.kind === 'commit')) {
    try {
      const snapshot = await inventoryDeepAudit(join(workspacePath, entry.path), { promptHash, category });
      if (snapshot.revision !== entry.blob) throw new Error('Submodule revision does not match pin');
      nested.push(...snapshot.files.map(file => ({ ...file, path: `${entry.path}/${file.path}` })));
      entry.expanded = true;
    } catch { /* An unreadable submodule stays in scope as an explicit blocker. */ }
  }
  files = [...files.filter(file => !file.expanded), ...nested].sort((a, b) => a.path.localeCompare(b.path));
  const dirty = (await execGit(['diff', '--name-only', 'HEAD', '--'], workspacePath)).stdout.trim();
  const untracked = (await execGit(['ls-files', '--others', '--exclude-standard', '-z'], workspacePath)).stdout
    .split('\0').filter(path => path && !/^\.agent-done(?:-[a-zA-Z0-9_-]+)?(?:\.json)?$/.test(path));
  if (dirty || untracked.length) throw new Error('Deep audit needs a clean source snapshot; tracked or untracked changes require a fresh inventory');
  if (!files.length) throw new Error('Deep audit cannot certify an empty inventory');
  // Submodules are kept in the inventory and require an explicit blocker or nested-repo evidence.
  const { detectRepoCapabilities } = await import('./appQualitySchedule.js');
  const detected = await detectRepoCapabilities({ repoPath: workspacePath }, { refresh: true });
  const capabilities = { ...detected.capabilities, git: true, trackedFiles: files.length, submodules: files.filter(file => file.kind === 'commit').map(file => file.path) };
  return { revision, inventoryHash: canonicalSnapshotChecksum(files), files, capabilities,
    exclusions: ['Git-ignored files are outside the tracked-source inventory; required runtime evidence must be reported blocked when unavailable.'],
    promptVersions: { contract: DEEP_AUDIT_VERSION, category: PROMPT_VERSIONS[category] ?? null }, promptHash };
}

async function mutateLedger(id, initial, mutate) {
  await ensureSchema();
  return withTransaction(async client => {
    if (initial) await client.query(`INSERT INTO deep_audit_ledgers (id, app_id, category, ledger)
      VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO NOTHING`, [id, initial.appId, initial.category, JSON.stringify(initial)]);
    const { rows } = await client.query('SELECT ledger FROM deep_audit_ledgers WHERE id=$1 FOR UPDATE', [id]);
    if (!rows.length) throw new Error('Deep audit ledger is unavailable');
    const updated = await mutate(rows[0].ledger);
    await client.query('UPDATE deep_audit_ledgers SET ledger=$2::jsonb, updated_at=NOW() WHERE id=$1', [id, JSON.stringify(updated)]);
    return updated;
  });
}

export async function getDeepAuditLedger(id) {
  await ensureSchema();
  const { rows } = await query('SELECT ledger FROM deep_audit_ledgers WHERE id=$1', [id]);
  return rows[0]?.ledger ?? null;
}

/** Inject at the common spawn boundary, after all saved/custom/legacy task rendering. */
export async function prepareDeepAudit({ task, agentId, workspacePath }, deps = {}) {
  if (task.metadata?.auditDepth !== 'deep') return null;
  if (!agentId || !workspacePath || !task.metadata?.app || !deepAuditId(task)) throw new Error('Deep audit needs an identified agent, app and workspace');
  const category = isAuditTaskType(resolveTaskHookType(task)) ? normalizeAuditTaskType(resolveTaskHookType(task)) : 'code-quality';
  const promptHash = canonicalSnapshotChecksum({ description: task.description, prompt: task.metadata?.prompt, context: task.metadata?.context });
  const scope = await (deps.inventory || inventoryDeepAudit)(workspacePath, { promptHash, category });
  const initial = createDeepAuditLedger({ id: deepAuditId(task), appId: task.metadata.app, category, scope,
    delivery: task.metadata.fileIssues === true || task.metadata.fileIssues === 'true' ? 'file-issues' : 'fix' });
  const ledger = await (deps.mutate || mutateLedger)(initial.id, initial, current => {
    if (current.appId !== initial.appId || current.category !== initial.category || current.delivery !== initial.delivery) {
      throw new Error('Deep audit resume must keep the same app, category and delivery mode');
    }
    const refreshed = refreshDeepAuditScope(current, scope);
    assignDeepAuditAttempt(refreshed, agentId);
    return refreshed;
  });
  const paths = deepAuditPaths(workspacePath, agentId);
  await (deps.write || atomicWrite)(paths.ledgerPath, ledger);
  return deepAuditInstructions({ ledger, attempt: ledger.attempts[agentId], ...paths });
}

/** Import even on failure; absent/malformed output preserves a partial, resumable ledger. */
export async function checkpointDeepAudit({ task, agentId, workspacePath, success }, deps = {}) {
  if (task.metadata?.auditDepth !== 'deep') return null;
  const id = deepAuditId(task);
  const ledger = await (deps.mutate || mutateLedger)(id, null, async current => {
    if (current.appId !== task.metadata.app) throw new Error('Deep audit app mismatch');
    const attempt = current.attempts[agentId];
    if (!attempt) return { ...current, reason: 'No server-assigned Deep audit attempt; resume required' };
    if (attempt.reportHash) return current; // Durable idempotence after files have been cleaned.
    try {
      if (!workspacePath) throw new Error('Checkpoint workspace is unavailable');
      const pass = attempt.pass;
      let validationRevision = null;
      if (pass === 'post-fix') {
        const validationScope = await (deps.inventory || inventoryDeepAudit)(workspacePath, { promptHash: current.scope.promptHash, category: current.category });
        validationRevision = validationScope.revision;
      } else {
        const scope = await (deps.inventory || inventoryDeepAudit)(workspacePath, {
          promptHash: current.scope.promptHash, category: current.category,
        });
        if (canonicalSnapshotChecksum(scope) !== current.scopeHash) throw new Error('Source changed during review; resume to invalidate and re-inventory');
      }
      const contents = await (deps.read || tryReadFile)(deepAuditPaths(workspacePath, agentId).reportPath);
      if (!contents) throw new Error('Deep audit checkpoint missing; no coverage credited');
      return mergeDeepAuditReport(current, agentId, JSON.parse(contents), { deliverySuccess: success === true, validationRevision });
    } catch (err) {
      return { ...current, invalidReason: /Source changed|clean source snapshot/.test(err.message) ? err.message : current.invalidReason,
        reason: `Partial: ${err.message}` };
    }
  });
  return { id, revision: ledger.scope.revision, ...deepAuditProgress(ledger) };
}


export async function settleDeepAuditDelivery({ task, agentId, success, validationPassed }, deps = {}) {
  const ledger = await (deps.mutate || mutateLedger)(deepAuditId(task), null, current => {
    const attempt = current.attempts[agentId];
    if (!attempt?.reportHash || attempt.generation !== current.generation || current.lastReportAgent !== agentId) return current;
    const deliverablePass = current.delivery === 'fix' ? 'post-fix' : 'challenge';
    if (attempt.pass !== deliverablePass) return current;
    return { ...current, deliveryVerified: success === true && (current.delivery !== 'fix' || validationPassed === true) };
  });
  return { id: ledger.id, revision: ledger.scope.revision, ...deepAuditProgress(ledger) };
}
