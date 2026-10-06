/** Receiver-reviewed, pinned, single-file GGUF imports. No peer-provided recipe. */
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import * as fs from 'node:fs/promises';
import { z } from 'zod';
import { canonicalStringify } from '../lib/objects.js';
import { assertNotRealDataWrite } from '../lib/testDataIsolation.js';
import { assertPeerExecutionCapability } from '../lib/maintenanceExclusive.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.number().int().min(16).max(512 * 1024 ** 3).safe();
export const peerCatalogReviewTargetSchema = z.object({ backend: z.literal('lmstudio'),
  catalogKey: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/) }).strict();
export const peerCatalogReviewSchema = peerCatalogReviewTargetSchema.extend({
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  fileName: z.string().max(180).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\.gguf$/)
    .refine(value => !/\.\.|mmproj|\d+-of-\d+/i.test(value), 'Choose one complete GGUF, without projector or shards.'),
  artifactDigest: digest, downloadBytes: bytes, license: z.string().trim().min(1).max(256),
  runtimeMemoryBytes: bytes, runtime: z.string().min(1).max(256),
  sourceLicenseReviewed: z.literal(true), runtimeCompatibilityReviewed: z.literal(true),
}).strict().refine(row => row.runtimeMemoryBytes >= row.downloadBytes, 'The reviewed memory budget must cover the weights.');
const hash = value => createHash('sha256').update(canonicalStringify(value)).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: 409 }); };
const sourceFor = entry => {
  const repo = entry?.lmstudio?.split('@')[0];
  if (!entry || !/^[a-z0-9][a-z0-9-]*$/.test(entry.key) || entry.gated || entry.appleSiliconOnly || entry.format === 'mlx'
    || entry.capabilities?.includes('vision') || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo ?? '')
    || repo.includes('..') || !/gguf/i.test(repo)) return null;
  return repo;
};
const publicReview = row => {
  const { sourceLicenseReviewed: _source, runtimeCompatibilityReviewed: _runtime, sourceRepo: _repo,
    authority: _authority, ...review } = row;
  return { ...review, modelId: row.sourceRepo, scratchBytes: 512 * 1024 ** 2 };
};
const exists = path => fs.lstat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const file = await fs.open(path, 'r');
  try { await file.sync(); } finally { await file.close(); }
}

/** Inject only receiver-owned probes/settings and an offline fixture transport in tests. */
export function _createPeerCatalogInstaller({ catalog, readReviews, writeReviews, inspectRuntime,
  fetchImpl = fetch, download = args => downloadPinned({ ...args, fetchImpl }),
  afterInstall = async () => {}, assertWrite = assertNotRealDataWrite } = {}) {
  const read = async () => {
    const value = await readReviews();
    // Parse the input portion independently because input is intentionally strict.
    const rows = z.array(z.record(z.string(), z.unknown())).max(32).parse(value);
    return rows.map(row => {
      const { sourceRepo, destinationDigest, reviewRevision, authority, ...input } = row;
      const parsed = peerCatalogReviewSchema.parse(input);
      const metadata = z.object({ sourceRepo: z.string(), destinationDigest: digest, reviewRevision: digest,
        authority: z.enum(['operator-session', 'local-operator']) }).strict().parse({ sourceRepo, destinationDigest, reviewRevision, authority });
      return { ...parsed, ...metadata };
    });
  };
  const target = raw => {
    const input = peerCatalogReviewTargetSchema.parse(raw);
    const entry = catalog.find(row => row.key === input.catalogKey);
    const sourceRepo = sourceFor(entry);
    if (!sourceRepo) fail('PEER_EXECUTION_CATALOG_UNSUPPORTED', 'Only catalog-backed, non-gated, single-file GGUF imports are supported.');
    return { ...input, sourceRepo, name: entry.name };
  };
  const observed = async () => {
    const runtime = await inspectRuntime();
    if (!runtime?.modelsRoot || !runtime.runtime) fail('PEER_EXECUTION_RUNTIME_UNKNOWN', 'The installed local LM Studio runtime and models directory must be known.');
    const root = await fs.realpath(runtime.modelsRoot);
    const rootStat = await fs.stat(root);
    if (!rootStat.isDirectory()) fail('PEER_EXECUTION_DESTINATION_UNKNOWN', 'The actual models volume is unavailable.');
    return { ...runtime, modelsRoot: root, destinationDigest: hash({ root, dev: rootStat.dev, ino: rootStat.ino }) };
  };
  const describe = async raw => {
    const selection = target(raw);
    const runtime = await observed();
    return { ...selection, runtime: runtime.runtime, destinationDigest: runtime.destinationDigest, modelsDirectory: runtime.modelsRoot };
  };
  const save = async (raw, authority) => {
    const input = peerCatalogReviewSchema.parse(raw);
    z.enum(['operator-session', 'local-operator']).parse(authority);
    const selection = await describe({ backend: input.backend, catalogKey: input.catalogKey });
    const quant = catalog.find(row => row.key === input.catalogKey).lmstudio.split('@')[1];
    if (quant && !input.fileName.toLowerCase().includes(quant.toLowerCase()))
      fail('PEER_EXECUTION_CATALOG_QUANT_CHANGED', 'The reviewed file must match the catalog quantization.');
    if (input.runtime !== selection.runtime) fail('PEER_EXECUTION_RUNTIME_CHANGED', 'Refresh and review the current installed runtime.');
    const row = { ...input, sourceRepo: selection.sourceRepo, destinationDigest: selection.destinationDigest, authority };
    const review = { ...row, reviewRevision: hash(row) };
    const previous = await read();
    const next = previous.filter(row => row.catalogKey !== input.catalogKey);
    if (next.length >= 32) fail('PEER_EXECUTION_CATALOG_LIMIT', 'The bounded review store is full.');
    await writeReviews([...next, review]);
    return review;
  };
  const list = async () => ({ candidates: catalog.filter(sourceFor).map(row => ({ catalogKey: row.key,
    backend: 'lmstudio', name: row.name })), reviews: await read() });
  const resolve = async intent => {
    const selection = target({ backend: intent.backend, catalogKey: intent.catalogKey });
    const row = (await read()).find(item => item.catalogKey === selection.catalogKey);
    if (!row) fail('PEER_EXECUTION_CATALOG_UNREVIEWED', 'Review this exact source, license and runtime locally first.');
    if (row.sourceRepo !== selection.sourceRepo) fail('PEER_EXECUTION_CATALOG_CHANGED', 'The reviewed source changed.');
    const { reviewRevision, ...reviewed } = row;
    if (hash(reviewed) !== reviewRevision) fail('PEER_EXECUTION_CATALOG_CHANGED', 'The stored review is inconsistent.');
    return resolveLocation(row);
  };
  const resolveLocation = async row => {
    const runtime = await observed();
    if (row.runtime !== runtime.runtime || row.destinationDigest !== runtime.destinationDigest)
      fail('PEER_EXECUTION_CATALOG_CHANGED', 'The reviewed runtime or destination changed.');
    const directory = join(runtime.modelsRoot, ...row.sourceRepo.split('/'));
    // The root itself may deliberately be a configured symlink. Descendants
    // cannot redirect the receiver-reviewed destination to another volume.
    for (const path of [join(runtime.modelsRoot, row.sourceRepo.split('/')[0]), directory]) {
      const entry = await fs.lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (entry && !entry.isDirectory()) fail('PEER_EXECUTION_DESTINATION_CHANGED', 'Model destination contains a symlink or non-directory.');
    }
    return { row, runtime, directory, destination: join(directory, row.fileName) };
  };
  const probe = async intent => {
    const { row, runtime, destination } = await resolve(intent);
    if (await exists(destination)) fail('PEER_EXECUTION_MODEL_EXISTS', 'The reviewed model file already exists; it will not be overwritten.');
    return { review: publicReview(row), resources: { destinationFreeBytes: runtime.destinationFreeBytes,
      availableMemoryBytes: runtime.availableMemoryBytes, runtime: runtime.runtime, destinationDigest: runtime.destinationDigest } };
  };
  const install = async ({ operation, evidence, evidenceDigest, capability }) => {
    // The dispatcher holds the shared identity mutex through this recheck and
    // launch; downloads then run outside it, so grants may still be revoked.
    const resolved = await resolve(evidence.intent);
    if (hash({ version: 1, intent: evidence.intent, target: publicReview(resolved.row) }) !== evidenceDigest)
      fail('PEER_EXECUTION_CATALOG_CHANGED', 'The reviewed artifact changed before launch.');
    assertPeerExecutionCapability(capability, evidence.intent, evidenceDigest);
    const id = z.string().uuid().parse(operation.operationId);
    const { row, runtime, directory, destination } = resolved;
    assertWrite(directory, 'peer catalog model installation');
    if (await exists(destination)) fail('PEER_EXECUTION_MODEL_EXISTS', 'Existing model files are never replaced.');
    if (runtime.destinationFreeBytes < row.downloadBytes + 512 * 1024 ** 2 || runtime.availableMemoryBytes < row.runtimeMemoryBytes)
      fail('PEER_EXECUTION_RESOURCES_INSUFFICIENT', 'The actual model destination or runtime has insufficient capacity.');
    await fs.mkdir(directory, { recursive: true });
    // Re-resolve after directory creation and before launching the write.
    if (await fs.realpath(directory) !== directory) fail('PEER_EXECUTION_DESTINATION_CHANGED', 'Model destination changed before launch.');
    const staging = join(directory, `.portos-peer-${id}`);
    await fs.mkdir(staging, { mode: 0o700 }); // no reuse/resume of an earlier launch
    assertPeerExecutionCapability(capability, evidence.intent, evidenceDigest);
    let published = false;
    const complete = async () => {
      const artifact = join(staging, 'artifact');
      const result = await download({ url: `https://huggingface.co/${row.sourceRepo}/resolve/${row.sourceRevision}/${encodeURIComponent(row.fileName)}`,
        artifact, expectedBytes: row.downloadBytes, expectedDigest: row.artifactDigest });
      if (result.bytes !== row.downloadBytes || result.digest !== row.artifactDigest)
        fail('PEER_EXECUTION_ARTIFACT_MISMATCH', 'Downloaded bytes do not match the reviewed artifact.');
      const currentRuntime = await observed();
      if (currentRuntime.destinationDigest !== row.destinationDigest || currentRuntime.runtime !== row.runtime
        || await fs.realpath(directory) !== directory)
        fail('PEER_EXECUTION_CATALOG_CHANGED', 'The runtime or model destination changed during download.');
      // Never replace a file installed concurrently outside PortOS. Same-volume
      // hardlink is atomic and preserves the verified bytes without another copy.
      await fs.link(artifact, destination);
      published = true;
      await syncDirectory(directory);
      await fs.rm(staging, { recursive: true });
      await syncDirectory(directory);
      await afterInstall(row);
      return { state: 'succeeded', code: 'PEER_EXECUTION_CATALOG_INSTALLED', evidenceDigest: hash({ operationId: id,
        evidenceDigest, artifactDigest: row.artifactDigest, bytes: row.downloadBytes, cleanup: true }) };
    };
    // A failure never claims clean terminal persistence. Reconciliation can
    // verify a published artifact after a crash, otherwise ownership stays held.
    return { completion: complete().catch(async error => {
      if (published) throw error;
      await fs.rm(staging, { recursive: true });
      await syncDirectory(directory);
      return { state: 'failed', code: /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'PEER_EXECUTION_CATALOG_DOWNLOAD_FAILED',
        evidenceDigest: hash({ operationId: id, evidenceDigest, published: false, cleanup: true }) };
    }) };
  };
  const reconcile = async (operation, evidence) => {
    if (hash(evidence) !== operation.binding.evidenceDigest
      || canonicalStringify(evidence.intent) !== canonicalStringify(operation.binding.intent)) return null;
    // The immutable launch snapshot, not today's replaceable review, owns the
    // artifact after a crash. A later local review cannot erase completion proof.
    const target = evidence.target;
    const row = { ...peerCatalogReviewSchema.parse({ backend: target.backend, catalogKey: target.catalogKey,
      sourceRevision: target.sourceRevision, fileName: target.fileName, artifactDigest: target.artifactDigest,
      downloadBytes: target.downloadBytes, license: target.license, runtimeMemoryBytes: target.runtimeMemoryBytes,
      runtime: target.runtime, sourceLicenseReviewed: true, runtimeCompatibilityReviewed: true }),
      sourceRepo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/)
        .refine(value => !value.includes('..')).parse(target.modelId),
      destinationDigest: digest.parse(target.destinationDigest) };
    const { destination, directory } = await resolveLocation(row);
    const entry = await fs.lstat(destination).catch(() => null);
    if (!entry?.isFile() || entry.size !== row.downloadBytes) return null;
    const { sha256File } = await import('../lib/fileCore.js');
    if (await sha256File(destination) !== row.artifactDigest) return null;
    const staging = join(directory, `.portos-peer-${z.string().uuid().parse(operation.operationId)}`);
    assertWrite(staging, 'peer catalog completed stage cleanup');
    if (await exists(staging)) {
      if (!(await fs.lstat(staging)).isDirectory()) return null;
      const names = await fs.readdir(staging);
      if (names.some(name => name !== 'artifact')) return null;
      await fs.rm(staging, { recursive: true });
      await syncDirectory(directory);
    }
    await afterInstall(row);
    return { state: 'succeeded', code: 'PEER_EXECUTION_CATALOG_VERIFIED', evidenceDigest: hash({ operationId: operation.operationId,
      evidenceDigest: operation.binding.evidenceDigest, artifactDigest: row.artifactDigest, bytes: row.downloadBytes, cleanup: true }) };
  };
  return { describe, save, list, probe, install, reconcile };
}

async function downloadPinned({ url, artifact, expectedBytes, expectedDigest, fetchImpl = fetch }) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30 * 60_000), headers: { 'Accept-Encoding': 'identity' } });
  if (!response.ok || !response.body) fail('PEER_EXECUTION_DOWNLOAD_FAILED', 'Pinned artifact download failed.');
  const file = await fs.open(artifact, 'wx', 0o600);
  const hasher = createHash('sha256');
  let count = 0;
  let header = Buffer.alloc(0);
  try {
    for await (const chunk of response.body) {
      count += chunk.length;
      if (count > expectedBytes) fail('PEER_EXECUTION_ARTIFACT_MISMATCH', 'Artifact exceeds reviewed size.');
      if (header.length < 8) header = Buffer.concat([header, Buffer.from(chunk).subarray(0, 8 - header.length)]);
      hasher.update(chunk);
      await file.writeFile(chunk);
    }
    const actual = hasher.digest('hex');
    if (count !== expectedBytes || actual !== expectedDigest || header.length < 8
      || header.subarray(0, 4).toString('ascii') !== 'GGUF' || ![2, 3].includes(header.readUInt32LE(4)))
      fail('PEER_EXECUTION_ARTIFACT_MISMATCH', 'Downloaded GGUF does not match the reviewed bytes.');
    await file.sync();
    return { bytes: count, digest: actual };
  } finally { await file.close(); }
}

let singleton;
async function production() {
  if (singleton) return singleton;
  const [{ LOCAL_LLM_CATALOG }, { PATHS, readJSONFile, atomicWrite }, manager, { findCommandOnPath }, { bufferedSpawn }, os] = await Promise.all([
    import('../lib/localLlmCatalog.js'), import('../lib/fileUtils.js'), import('./lmStudioManager.js'),
    import('../lib/processEnv.js'), import('../lib/bufferedSpawn.js'), import('node:os'),
  ]);
  const path = join(PATHS.data, 'peer-execution-catalog.json');
  singleton = _createPeerCatalogInstaller({ catalog: LOCAL_LLM_CATALOG,
    readReviews: () => readJSONFile(path, [], { strict: true, logError: false }), writeReviews: rows => atomicWrite(path, rows),
    inspectRuntime: async () => {
      const binary = findCommandOnPath('lms');
      if (!binary) fail('PEER_EXECUTION_RUNTIME_UNKNOWN', 'Install and configure LM Studio locally first.');
      // Documented read-only inventory; never runtime get/select/update.
      const result = await bufferedSpawn(binary, ['runtime', 'ls'], { timeoutMs: 10000, shell: false });
      if (!result.success || !/llama.cpp/i.test(result.stdout) || result.stdout.length > 16384)
        fail('PEER_EXECUTION_RUNTIME_UNKNOWN', 'The installed GGUF runtime inventory is unavailable.');
      // A conventional folder may be stale after the app's GUI directory was
      // changed. Require the receiver's explicit model-root configuration.
      const configuredRoot = process.env.LM_STUDIO_MODELS_DIR;
      if (!configuredRoot || !isAbsolute(configuredRoot))
        fail('PEER_EXECUTION_DESTINATION_UNKNOWN', 'Set LM_STUDIO_MODELS_DIR to the Models directory configured in LM Studio before reviewing peer imports.');
      const modelsRoot = await fs.realpath(configuredRoot);
      if (modelsRoot !== await fs.realpath(await manager.getModelsDir()))
        fail('PEER_EXECUTION_DESTINATION_CHANGED', 'LM Studio model destination could not be verified.');
      const disk = await fs.statfs(modelsRoot);
      return { modelsRoot, runtime: `lmstudio:${hash({ binary: await fs.realpath(binary), inventory: result.stdout.trim() })}`,
        destinationFreeBytes: disk.bavail * disk.bsize, availableMemoryBytes: os.freemem() };
    }, download: downloadPinned, afterInstall: async row => {
      manager.resetCache();
      const [{ recordModelInstall }, { localModelInventoryRow }, { invalidateModelObservation }] = await Promise.all([
        import('./modelManifest.js'), import('../lib/modelInventory.js'), import('./modelObservation.js'),
      ]);
      await recordModelInstall({ ...localModelInventoryRow({ backend: 'lmstudio', modelId: row.sourceRepo }), source: 'download' });
      invalidateModelObservation('loaded-models');
      invalidateModelObservation('provider-readiness');
    },
  });
  return singleton;
}
export const describePeerCatalogReview = async input => (await production()).describe(input);
export const listPeerCatalogReviews = async () => (await production()).list();
export async function savePeerCatalogReview(input, req) {
  const [{ withInstanceIdentityLock }, { requestHasHostControl }] = await Promise.all([import('./instanceIdentity.js'), import('./authGate.js')]);
  const method = req?.portosAuthContext?.method;
  if (!req || method === 'peer' || !requestHasHostControl(req)) fail('PEER_EXECUTION_REVIEW_AUTHORITY', 'A receiver operator must review model installation.');
  return withInstanceIdentityLock(async () => (await production()).save(input, method === 'session' ? 'operator-session' : 'local-operator'));
}
export const probePeerCatalog = async intent => (await production()).probe(intent);
export const installPeerCatalog = async context => (await production()).install(context);
export const reconcilePeerCatalog = async (operation, evidence) => (await production()).reconcile(operation, evidence);
