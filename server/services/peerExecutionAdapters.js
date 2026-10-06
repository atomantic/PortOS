/** Fixed receiver-side actions. Peer input never selects commands, paths or URLs. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalStringify } from '../lib/objects.js';
import { peerAdminIntentSchema } from '../lib/peerAdminValidation.js';
import { assertPeerExecutionCapability, consumePeerExecutionCapability } from '../lib/maintenanceExclusive.js';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.number().int().positive().safe();
const text = z.string().min(1).max(256);
const updateSchema = z.object({ headSha: sha, targetSha: sha, originDigest: digest,
  branch: z.literal('main'), tag: z.string().regex(/^v\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/),
  isFork: z.boolean(), forkSyncFresh: z.boolean() }).strict();
const restartSchema = z.object({ processes: z.array(z.object({ name: z.enum(['portos-server', 'portos-cos']),
  pid: z.number().int().positive(), scriptDigest: digest }).strict()).min(1).max(2) }).strict();
// A curated display entry is not a reviewed executable artifact. These facts
// must come from receiver-owned review metadata, never the request or a URL.
export const peerCatalogExecutionReviewSchema = z.object({ catalogKey: text, backend: z.enum(['ollama', 'lmstudio']),
  modelId: text, fileName: text, artifactDigest: digest, sourceRevision: text, license: text, reviewRevision: digest,
  destinationDigest: digest, downloadBytes: bytes, scratchBytes: bytes, runtimeMemoryBytes: bytes,
  runtime: text }).strict();
const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: 409 }); };
export const peerExecutionEvidenceDigest = evidence => createHash('sha256').update(canonicalStringify(evidence)).digest('hex');
const freeze = value => {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
};

/** All probes/launchers are receiver-owned dependencies; wire input is only intent. */
export function _createPeerExecutionAdapters({ probeUpdate, probeRestart, probeCatalog, launchUpdate,
  launchRestart, installCatalog, reconcileReceipt = async () => null } = {}) {
  const prepare = async raw => {
    const intent = peerAdminIntentSchema.parse(raw);
    if (intent.action === 'portos.update') {
      const target = updateSchema.parse(await probeUpdate());
      if (target.isFork && !target.forkSyncFresh) fail('PEER_EXECUTION_FORK_REVIEW_REQUIRED', 'Sync the fork locally before requesting a peer update.');
      if (target.headSha === target.targetSha) fail('PEER_EXECUTION_ALREADY_CURRENT', 'The origin target is already installed.');
      return freeze({ version: 1, intent, target });
    }
    if (intent.action === 'portos.restart') {
      const target = restartSchema.parse(await probeRestart());
      if (!target.processes.some(row => row.name === 'portos-server')
        || new Set(target.processes.map(row => row.name)).size !== target.processes.length)
        fail('PEER_EXECUTION_RESTART_UNAVAILABLE', 'PortOS process identity is unavailable.');
      return freeze({ version: 1, intent, target });
    }
    const snapshot = await probeCatalog(intent);
    const parsed = peerCatalogExecutionReviewSchema.safeParse(snapshot?.review);
    if (!parsed.success) fail('PEER_EXECUTION_CATALOG_UNREVIEWED', 'Exact source, license, destination and runtime review is required locally.');
    const review = parsed.data;
    if (review.catalogKey !== intent.catalogKey || review.backend !== intent.backend)
      fail('PEER_EXECUTION_CATALOG_CHANGED', 'The reviewed catalog target changed.');
    const resources = z.object({ destinationFreeBytes: bytes, availableMemoryBytes: bytes,
      runtime: text, destinationDigest: digest }).strict().parse(snapshot.resources);
    if (resources.runtime !== review.runtime || resources.destinationDigest !== review.destinationDigest)
      fail('PEER_EXECUTION_CATALOG_CHANGED', 'The reviewed destination or runtime changed.');
    if (resources.destinationFreeBytes < review.downloadBytes + review.scratchBytes
      || resources.availableMemoryBytes < review.runtimeMemoryBytes)
      fail('PEER_EXECUTION_RESOURCES_INSUFFICIENT', 'The actual model destination or runtime has insufficient capacity.');
    // Available capacity changes constantly; bind the checked requirements and
    // destination, then re-probe capacity at launch rather than digesting noise.
    return freeze({ version: 1, intent, target: review });
  };
  const run = async (raw, evidence, { capability } = {}) => {
    const intent = peerAdminIntentSchema.parse(raw);
    const evidenceDigest = peerExecutionEvidenceDigest(evidence);
    const operation = consumePeerExecutionCapability(capability, intent, evidenceDigest);
    const fresh = await prepare(intent);
    if (peerExecutionEvidenceDigest(fresh) !== evidenceDigest)
      fail('PEER_EXECUTION_EVIDENCE_CHANGED', 'Receiver evidence changed after preflight.');
    assertPeerExecutionCapability(capability, intent, evidenceDigest);
    const context = { capability, evidence: fresh, operation, evidenceDigest };
    if (intent.action === 'portos.update') return launchUpdate(context);
    if (intent.action === 'portos.restart') return launchRestart(context);
    if (!installCatalog) fail('PEER_EXECUTION_CATALOG_UNAVAILABLE', 'No reviewed artifact installer is available.');
    return installCatalog(context);
  };
  const reconcile = async operation => {
    // Health, elapsed time and the absence of a PID are never completion proof.
    const receipt = await reconcileReceipt(operation);
    return receipt ?? { state: 'uncertain', code: 'PEER_EXECUTION_RECEIPT_UNAVAILABLE' };
  };
  return { prepare, run, reconcile };
}

const production = _createPeerExecutionAdapters({
  probeUpdate: async () => {
    const [{ getUpdateStatus }, { checkUpdateRepoReadiness }, { execGitSafe }, { PATHS }] = await Promise.all([
      import('./updateChecker.js'), import('./updateRepoReadiness.js'), import('../lib/execGit.js'), import('../lib/paths.js'),
    ]);
    const [status, repo] = await Promise.all([getUpdateStatus(), checkUpdateRepoReadiness({ fetch: false })]);
    const canDrain = repo.repairable?.length === 0 && repo.reasons?.every(reason => reason === 'agent-at-work');
    if ((!repo.ready && !canDrain) || repo.branch !== 'main' || !status.remoteInfo?.hasOrigin)
      fail('PEER_EXECUTION_UPDATE_NOT_READY', 'A clean, fast-forwardable main checkout with origin is required.');
    const git = async args => (await execGitSafe(args, PATHS.root)).stdout.trim();
    const [headSha, targetSha, origin] = await Promise.all([
      git(['rev-parse', 'HEAD']), git(['rev-parse', 'refs/remotes/origin/main']), git(['remote', 'get-url', 'origin']),
    ]);
    const ancestor = await execGitSafe(['merge-base', '--is-ancestor', headSha, targetSha], PATHS.root, { ignoreExitCode: true });
    if (ancestor.exitCode !== 0) fail('PEER_EXECUTION_UPDATE_DIVERGED', 'The selected origin target is not a fast-forward.');
    return { headSha, targetSha, originDigest: createHash('sha256').update(origin).digest('hex'), branch: 'main',
      tag: status.latestRelease?.tag, isFork: status.remoteInfo.isFork === true, forkSyncFresh: status.forkSyncFresh === true };
  },
  probeRestart: async () => {
    const [{ listMaintenanceProcesses }, { PATHS }] = await Promise.all([import('./pm2.js'), import('../lib/paths.js')]);
    const list = await listMaintenanceProcesses();
    const selected = list.filter(row => ['portos-server', 'portos-cos'].includes(row.name));
    const scripts = { 'portos-server': join(PATHS.root, 'server/start.js'), 'portos-cos': join(PATHS.root, 'server/cos-runner/index.js') };
    if (selected.some(row => row.cwd !== PATHS.root || row.script !== scripts[row.name] || row.status !== 'online'))
      fail('PEER_EXECUTION_RESTART_UNAVAILABLE', 'PortOS process identity is unavailable.');
    return { processes: selected.map(({ name, pid, script }) => ({ name, pid,
      scriptDigest: createHash('sha256').update(script).digest('hex') })).sort((a, b) => a.name.localeCompare(b.name)) };
  },
  probeCatalog: async intent => {
    const { probePeerCatalog } = await import('./peerCatalogInstaller.js');
    return probePeerCatalog(intent);
  },
  installCatalog: async context => {
    await persistLaunch(context.operation, context.evidence);
    const { installPeerCatalog } = await import('./peerCatalogInstaller.js');
    return installPeerCatalog(context);
  },
  launchUpdate: async ({ capability, evidence, operation }) => {
    await persistLaunch(operation, evidence);
    const { startPortosSelfUpdate } = await import('./portosSelfUpdate.js');
    const result = await startPortosSelfUpdate({ peerExecution: { capability, evidence } });
    return { state: 'awaiting-reconnect', code: 'PEER_EXECUTION_UPDATE_STARTED', ...result };
  },
  launchRestart: async ({ capability, evidence, operation, evidenceDigest }) => {
    await persistLaunch(operation, evidence);
    const [{ spawnDetached }, { PATHS }, { createRequire }, { countActiveCosAgents, getPersistentMindImageWorkGuard }] = await Promise.all([
      import('../lib/detachedSpawn.js'), import('../lib/paths.js'), import('node:module'), import('./updatePreflight.js'),
    ]);
    const [agents, mind] = await Promise.all([countActiveCosAgents(), getPersistentMindImageWorkGuard()]);
    if (agents || !mind.trusted || !mind.safe) fail('PEER_EXECUTION_RESTART_BUSY', 'Existing agent or mind work must settle before restarting.');
    assertPeerExecutionCapability(capability, evidence.intent, evidenceDigest);
    const require = createRequire(import.meta.url);
    const child = await spawnDetached(process.execPath, [require.resolve('pm2/bin/pm2'), 'restart',
      ...evidence.target.processes.map(row => row.name)], { cwd: PATHS.root,
      controlDir: join(PATHS.data, 'peer-execution', operation.operationId), cleanup: false });
    child.on('error', () => console.error('❌ Peer restart launch failed; exclusive ownership remains held.'));
    return { state: 'awaiting-reconnect', code: 'PEER_EXECUTION_RESTART_STARTED' };
  },
  reconcileReceipt: reconcileProductionReceipt,
});
export const preparePeerExecution = production.prepare;
export const runPeerExecution = production.run;
export const reconcilePeerExecution = production.reconcile;


async function persistLaunch(operation, evidence) {
  const [{ mkdir, open }, { PATHS }, { assertNotRealDataWrite }] = await Promise.all([
    import('node:fs/promises'), import('../lib/paths.js'), import('../lib/testDataIsolation.js'),
  ]);
  const operationId = z.string().uuid().parse(operation.operationId);
  const directory = join(PATHS.data, 'peer-execution', operationId);
  assertNotRealDataWrite(directory, 'peer execution launch proof');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(join(directory, 'evidence.json'), 'wx', 0o600);
  try {
    await file.writeFile(canonicalStringify({ operationId, evidenceDigest: operation.evidenceDigest, evidence }));
    await file.sync();
  } finally { await file.close(); }
  if (process.platform !== 'win32') {
    const dir = await open(directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
}

/** Security boundary: only exact launch identity AND terminal facts can settle. */
export function _verifyPeerExecutionCompletion(operation, launch, facts) {
  if (!launch?.evidence?.intent || launch.operationId !== operation.operationId
    || launch.evidenceDigest !== operation.binding.evidenceDigest
    || peerExecutionEvidenceDigest(launch.evidence) !== operation.binding.evidenceDigest
    || canonicalStringify(launch.evidence.intent) !== canonicalStringify(operation.binding.intent)
    || facts?.exit !== '0') return null;
  const { intent, target } = launch.evidence;
  if (intent.action === 'portos.restart') {
    const previous = restartSchema.safeParse(target);
    const current = restartSchema.safeParse(facts.restart);
    if (!previous.success || !current.success || previous.data.processes.length !== current.data.processes.length
      || previous.data.processes.some(old => !current.data.processes.some(row => row.name === old.name
        && row.pid !== old.pid && row.scriptDigest === old.scriptDigest))) return null;
  } else if (intent.action === 'portos.update') {
    if (!updateSchema.safeParse(target).success || facts.install?.bootCommit !== target.targetSha
      || facts.install?.currentCommit !== target.targetSha || facts.install?.outOfSync !== false
      || facts.install?.staleBuild !== false || facts.install?.staleDeps?.stale !== false
      || facts.install?.submodules?.stale !== false || facts.install?.pendingMigrations?.count !== 0
      || facts.verified !== true) return null;
  } else return null;
  return { state: 'succeeded', code: 'PEER_EXECUTION_VERIFIED',
    evidenceDigest: peerExecutionEvidenceDigest({ launch, facts }) };
}

async function reconcileProductionReceipt(operation) {
  const [{ open, lstat }, { PATHS }] = await Promise.all([import('node:fs/promises'), import('../lib/paths.js')]);
  const operationId = z.string().uuid().parse(operation.operationId);
  const directory = join(PATHS.data, 'peer-execution', operationId);
  const readBounded = async (name, maxBytes) => {
    const path = join(directory, name);
    if (!(await lstat(path)).isFile()) return null;
    const file = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return bytesRead > maxBytes ? null : buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await file.close(); }
  };
  const raw = await readBounded('evidence.json', 16384).catch(() => null);
  if (!raw) return null;
  const launch = await Promise.resolve().then(() => JSON.parse(raw)).catch(() => null);
  if (!launch?.evidence || launch.operationId !== operation.operationId
    || launch.evidenceDigest !== operation.binding.evidenceDigest
    || peerExecutionEvidenceDigest(launch.evidence) !== operation.binding.evidenceDigest) return null;
  if (operation.binding.intent.action === 'catalog.install') {
    const { reconcilePeerCatalog } = await import('./peerCatalogInstaller.js');
    return reconcilePeerCatalog(operation, launch.evidence).catch(() => null);
  }
  const exit = await readBounded('exit', 32).catch(() => null);
  if (exit?.trim() !== '0') return null;
  let facts;
  if (operation.binding.intent.action === 'portos.restart') {
    // This read revalidates fixed script paths and online status.
    const current = await production.prepare({ action: 'portos.restart' }).catch(() => null);
    facts = { exit: '0', restart: current?.target };
  } else if (operation.binding.intent.action === 'portos.update') {
    const { getInstallState } = await import('./installState.js');
    const [install, log] = await Promise.all([getInstallState(), readBounded('stdout.log', 1024 * 1024)]).catch(() => [null, null]);
    facts = { exit: '0', install, verified: /(?:^|\n)STEP:verify:done:/.test(log ?? '') };
  }
  return _verifyPeerExecutionCompletion(operation, launch, facts);
}
