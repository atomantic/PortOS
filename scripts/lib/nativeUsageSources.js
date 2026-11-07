/** Detached native histories only. Fixed roles never discover a home or configuration root. */
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, open, opendir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { nativeUsageCanonicalJson } from '../../server/lib/nativeUsageContract.js';
import { buildNativeUsageStage } from '../../server/lib/nativeUsageStaging.js';
import { refuseNativeUsageRehearsal as refuse } from '../../server/lib/nativeUsageRehearsal.js';
import { inspectNativeUsageRegular } from './nativeUsageSnapshot.js';
import { replayNativeUsageSources } from './nativeUsageSourceReplay.js';
import { NATIVE_USAGE_SOURCE_ROLES, NATIVE_USAGE_SOURCE_MAX_ENTRIES as MAX_ENTRIES, NATIVE_USAGE_SOURCE_MAX_BYTES as MAX_BYTES,
  nativeUsageSourcesRequestSchema, nativeUsageSourcesSidecarSchema as sidecarSchema,
  nativeUsageSourcesManifestSchema as manifestSchema } from '../../server/lib/nativeUsageSources.js';

const MAX_DEPTH = 64;
const MAX_MILLISECONDS = 15 * 60 * 1000;
const SIDECAR = 'native-sources.json';
const REPORT = 'participant-report.json';
const REPLAY_ROLES = { claude: ['claudeProjects'], grok: ['grokSessions'],
  agy: ['agyCliConversations', 'agyLegacyBrain', 'agyAppConversations', 'agyIdeConversations'] };
const same = (a, b) => nativeUsageCanonicalJson(a) === nativeUsageCanonicalJson(b);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const budgetFor = () => ({ bytes: MAX_BYTES, deadline: Date.now() + MAX_MILLISECONDS });
const state = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
const checkTime = budget => { if (Date.now() >= budget.deadline) refuse('sources-time-limit-exceeded'); };
const within = (parent, child) => { const path = relative(parent, child); return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); };

function sourcePath(name) {
  if (typeof name !== 'string' || name.length > 4096 || name.normalize('NFC') !== name || /[\\\x00-\x1f\x7f:]/.test(name)
    || name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) refuse('sources-path-invalid');
  return name;
}

// Check ancestors too: O_NOFOLLOW protects only the final path component.
async function directoryChain(path) {
  const root = resolve(path);
  let current = parse(root).root;
  const states = [];
  for (const part of relative(current, root).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory()) refuse('sources-directory-invalid');
    states.push([current, info.dev, info.ino]);
  }
  return states;
}

// A selected root itself may not be a link. Canonicalize its ancestors once
// (macOS /tmp and /var are aliases), then operate only on the bound real path.
async function canonicalDirectory(path) {
  const selected = resolve(path);
  const before = await lstat(selected);
  if (!before.isDirectory()) refuse('sources-directory-invalid');
  const canonical = await realpath(selected);
  const after = await lstat(canonical);
  if (before.dev !== after.dev || before.ino !== after.ino) refuse('sources-input-changed');
  return canonical;
}

async function boundedNames(directory, budget, maximum) {
  const names = [];
  for await (const entry of await opendir(directory)) {
    checkTime(budget);
    if (names.length >= maximum) refuse('sources-entry-limit-exceeded');
    names.push(entry.name);
  }
  return names.sort();
}

async function inventory(root, budget) {
  const ancestors = await directoryChain(root);
  const directories = [];
  const files = [];
  const states = [];
  let entries = 0;
  async function walk(directory, prefix = '', depth = 0) {
    checkTime(budget);
    if (depth > MAX_DEPTH) refuse('sources-depth-limit-exceeded');
    const before = await lstat(directory);
    if (!before.isDirectory()) refuse('sources-directory-invalid');
    states.push([prefix, ...state(before)]);
    const aliases = new Set();
    for (const name of await boundedNames(directory, budget, MAX_ENTRIES + 2 - entries)) {
      checkTime(budget);
      if (++entries > MAX_ENTRIES + 2) refuse('sources-entry-limit-exceeded');
      sourcePath(name);
      const alias = name.toLowerCase();
      if (aliases.has(alias)) refuse('sources-path-alias');
      aliases.add(alias);
      const path = prefix ? `${prefix}/${name}` : name;
      sourcePath(path);
      const info = await lstat(join(directory, name));
      states.push([path, ...state(info)]);
      if (info.isDirectory()) { directories.push(path); await walk(join(directory, name), path, depth + 1); }
      else if (!info.isFile() || info.nlink !== 1) refuse('sources-link-or-special-file');
      else files.push(path);
    }
    if (!same(state(before), state(await lstat(directory)))) refuse('sources-input-changed');
  }
  await walk(root);
  if (!same(ancestors, await directoryChain(root))) refuse('sources-input-changed');
  return { directories: directories.sort(), files: files.sort(), states, ancestors };
}

function boundReport(stage, request) {
  const report = stage.inputs.reports.find(value => value.contentHash === request.reportHash && value.participantKey === request.participantKey);
  if (!report || report.contractVersion !== 4) refuse('sources-report-not-bound');
  return report;
}

function roleInventory(roles, found) {
  const present = NATIVE_USAGE_SOURCE_ROLES.filter(role => roles[role] === 'provided').sort();
  if (!same(found.directories.filter(path => !path.includes('/')), present)
    || found.files.some(path => !path.includes('/') || !present.includes(path.split('/')[0]))) refuse('sources-role-inventory-mismatch');
}

async function writePrivate(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function freshDestination(path, source) {
  const selected = resolve(path);
  const target = join(await realpath(dirname(selected)), basename(selected));
  if (within(source, target) || within(target, source)) refuse('sources-output-overlaps-input');
  await directoryChain(dirname(target));
  await mkdir(target, { mode: 0o700 }).catch(error => { if (error.code === 'EEXIST') refuse('sources-destination-exists'); throw error; });
  await writePrivate(join(target, '.in-progress'), 'native-sources\n');
  await mkdir(join(target, 'data'), { mode: 0o700 });
  return target;
}

async function copyInventory(source, target, found, budget) {
  for (const path of found.directories) {
    checkTime(budget);
    await mkdir(join(target, ...path.split('/')), { mode: 0o700 });
  }
  const files = {};
  const byteLengths = {};
  for (const path of found.files) {
    await directoryChain(dirname(join(source, ...path.split('/'))));
    await directoryChain(dirname(join(target, ...path.split('/'))));
    const result = await inspectNativeUsageRegular(join(source, ...path.split('/')), { budget, copyTo: join(target, ...path.split('/')) });
    files[path] = result.sha256;
    byteLengths[path] = result.sizeBytes;
  }
  return { files, byteLengths };
}

async function verifyBytes(root, files, byteLengths, budget) {
  for (const [path, expected] of Object.entries(files)) {
    checkTime(budget);
    await directoryChain(dirname(join(root, ...path.split('/'))));
    const read = await inspectNativeUsageRegular(join(root, ...path.split('/')), { budget });
    if (read.sha256 !== expected || read.sizeBytes !== byteLengths[path]) refuse('sources-file-mismatch');
  }
}

async function jsonFile(path, budget) {
  await directoryChain(dirname(path));
  if ((await lstat(path)).nlink !== 1) refuse('sources-link-or-special-file');
  const read = await inspectNativeUsageRegular(path, { collect: true, budget });
  let value;
  try { value = JSON.parse(read.bytes.toString('utf8')); } catch { refuse('sources-json-invalid'); }
  return { ...read, value };
}

async function publishManifest(root, manifest) {
  // The marker remains until a complete synced manifest is linked without overwrite.
  // A killed call can leave private partial bytes, never a usable bundle verdict.
  const pending = join(root, '.manifest-pending');
  await writePrivate(pending, nativeUsageCanonicalJson(manifest));
  await link(pending, join(root, 'manifest.json'));
  await rm(pending);
  await rm(join(root, '.in-progress'));
}

function parseSidecar(value) {
  const parsed = sidecarSchema.safeParse(value);
  if (!parsed.success) refuse('sources-sidecar-invalid');
  const sidecar = parsed.data;
  for (const name of [...sidecar.directories, ...Object.keys(sidecar.byteLengths)]) {
    sourcePath(name);
    if (!NATIVE_USAGE_SOURCE_ROLES.includes(name.split('/')[0])) refuse('sources-role-layout-invalid');
  }
  if (!same(sidecar.directories, [...new Set(sidecar.directories)].sort())) refuse('sources-directory-inventory-invalid');
  if (Object.keys(sidecar.byteLengths).length + sidecar.directories.length > MAX_ENTRIES) refuse('sources-entry-limit-exceeded');
  roleInventory(sidecar.roles, { directories: sidecar.directories, files: Object.keys(sidecar.byteLengths) });
  return sidecar;
}

async function verifyBundle(stage, root, budget, expectedReplay = null) {
  const ancestors = await directoryChain(root);
  const names = await boundedNames(root, budget, 4);
  if (!same(names, expectedReplay ? ['data', 'manifest.json', 'replay.json'] : ['data', 'manifest.json'])) refuse('sources-incomplete-or-unexpected-files');
  const manifestRead = await jsonFile(join(root, 'manifest.json'), budget);
  const parsed = manifestSchema.safeParse(manifestRead.value);
  if (!parsed.success) refuse('sources-manifest-invalid');
  const manifest = parsed.data;
  if (!Number.isFinite(Date.parse(manifest.generatedAt)) || new Date(manifest.generatedAt).toISOString() !== manifest.generatedAt
    || manifest.fileCount !== Object.keys(manifest.files).length) refuse('sources-manifest-invalid');
  for (const name of Object.keys(manifest.files)) sourcePath(name);
  const data = join(root, 'data');
  const found = await inventory(data, budget);
  if (!same(found.files, Object.keys(manifest.files).sort())) refuse('sources-file-inventory-mismatch');
  const sidecarRead = await jsonFile(join(data, SIDECAR), budget);
  const sidecar = parseSidecar(sidecarRead.value);
  if (sidecar.stageHash !== stage.contentHash) refuse('sources-stage-mismatch');
  const report = boundReport(stage, sidecar);
  const reportRead = await jsonFile(join(data, REPORT), budget);
  if (!same(report, reportRead.value)) refuse('sources-report-mismatch');
  if (!same(found.directories, sidecar.directories)
    || !same(found.files, [...Object.keys(sidecar.byteLengths), SIDECAR, REPORT].sort())) refuse('sources-layout-mismatch');
  const lengths = { ...sidecar.byteLengths, [SIDECAR]: sidecarRead.sizeBytes, [REPORT]: reportRead.sizeBytes };
  await verifyBytes(data, manifest.files, lengths, budget);
  if (!same(found, await inventory(data, budget)) || !same(ancestors, await directoryChain(root))
    || (await jsonFile(join(root, 'manifest.json'), budget)).sha256 !== manifestRead.sha256
    || !same(names, await boundedNames(root, budget, 4))) refuse('sources-input-changed');
  if (expectedReplay && (await jsonFile(join(root, 'replay.json'), budget)).bytes.toString('utf8') !== nativeUsageCanonicalJson(expectedReplay)) {
    refuse('sources-replay-receipt-mismatch');
  }
  return { manifest, manifestHash: manifestRead.sha256, sidecar, report, found, lengths };
}

const limitations = {
  inventoryScope: 'supplied-detached-roots-only', historicalAccountMembership: 'unknown', historicalCompleteness: 'unknown',
  fullStoreInventoryVerified: false, fullRecoveryBackup: false, activationReady: false,
  holdReasons: ['native-source-preservation-not-verified', 'source-inventory-and-exclusions-not-verified',
    'matched-code-schema-and-migrations-not-verified', 'matched-runtime-restore-not-verified',
    'runtime-not-registered', 'live-barrier-not-verified', 'fenced-interval-not-verified', 'source-freshness-not-verified-at-cutover'],
};
function receipt(checked) {
  const { sidecar, manifestHash } = checked;
  return { version: 1, stageHash: sidecar.stageHash, reportHash: sidecar.reportHash, manifestSha256: manifestHash,
    sourceFiles: Object.keys(sidecar.byteLengths).length, sourceDirectories: sidecar.directories.length,
    sourceBytes: Object.values(sidecar.byteLengths).reduce((total, bytes) => total + bytes, 0), roles: sidecar.roles,
    codex: { evidence: 'preserved-account-report', accountHistoryReplayed: false },
    antigravityAppAndIde: 'opaque-preservation-only', ...limitations };
}

export async function backupNativeUsageSources(stage, request, sourcePathname, destination) {
  const parsed = nativeUsageSourcesRequestSchema.safeParse(request);
  if (!parsed.success) refuse('sources-request-invalid');
  const report = boundReport(stage, parsed.data);
  const source = await canonicalDirectory(sourcePathname);
  const budget = budgetFor();
  const found = await inventory(source, budget);
  roleInventory(parsed.data.roles, found);
  if (found.files.length + found.directories.length > MAX_ENTRIES) refuse('sources-entry-limit-exceeded');
  const root = await freshDestination(destination, source);
  const data = join(root, 'data');
  const copied = await copyInventory(source, data, found, budget);
  if (!same(found, await inventory(source, budget))) refuse('sources-input-changed');
  await verifyBytes(source, copied.files, copied.byteLengths, budget);
  if (!same(found, await inventory(source, budget))) refuse('sources-input-changed');
  const sidecar = { ...parsed.data, kind: 'native-usage-sources', stageHash: stage.contentHash,
    directories: found.directories, byteLengths: { ...copied.byteLengths } };
  for (const [name, value] of [[SIDECAR, sidecar], [REPORT, report]]) {
    const bytes = nativeUsageCanonicalJson(value);
    await writePrivate(join(data, name), bytes);
    copied.files[name] = hash(bytes);
    copied.byteLengths[name] = Buffer.byteLength(bytes);
  }
  await verifyBytes(data, copied.files, copied.byteLengths, budget);
  const output = await inventory(data, budget);
  if (!same(output.directories, found.directories) || !same(output.files, Object.keys(copied.files).sort())) refuse('sources-copy-inventory-mismatch');
  if (!same(found, await inventory(source, budget))) refuse('sources-input-changed');
  const manifest = { generatedAt: new Date().toISOString(), fileCount: Object.keys(copied.files).length, files: copied.files };
  await publishManifest(root, manifest);
  const checked = await verifyBundle(stage, root, budget);
  return { status: 'detached-native-sources-backed-up', sourceBytesVerified: true, ...receipt(checked) };
}

export async function restoreNativeUsageSources(stage, sourcePathname, destination) {
  const source = await canonicalDirectory(sourcePathname);
  const budget = budgetFor();
  const checked = await verifyBundle(stage, source, budget);
  const root = await freshDestination(destination, source);
  const copied = await copyInventory(join(source, 'data'), join(root, 'data'), checked.found, budget);
  if (!same(copied.files, checked.manifest.files) || !same(copied.byteLengths, checked.lengths)) refuse('sources-copy-mismatch');
  if (!same(checked, await verifyBundle(stage, source, budget))) refuse('sources-input-changed');
  await verifyBytes(join(root, 'data'), copied.files, copied.byteLengths, budget);
  const restored = await inventory(join(root, 'data'), budget);
  if (!same(restored.files, checked.found.files) || !same(restored.directories, checked.found.directories)) refuse('sources-copy-inventory-mismatch');
  const roots = Object.fromEntries(NATIVE_USAGE_SOURCE_ROLES.map(role => [role, join(root, 'data', role)]));
  const replay = await replayNativeUsageSources(checked.report, roots, { deadline: budget.deadline });
  for (const provider of replay.providers) {
    if (REPLAY_ROLES[provider.family].some(role => checked.sidecar.roles[role] === 'not-supplied/unknown')) provider.status = 'not-supplied';
  }
  replay.matched = replay.providers.every(({ status }) => status === 'matched');
  await verifyBytes(join(root, 'data'), copied.files, copied.byteLengths, budget);
  if (!same(restored, await inventory(join(root, 'data'), budget))) refuse('sources-input-changed');
  let stageRebuilt = false;
  if (replay.matched) {
    const providers = checked.report.providers.map(entry => replay.providers.find(value => value.family === entry.family)?.entry ?? entry);
    const report = { ...checked.report, providers };
    const rebuilt = buildNativeUsageStage({ request: stage.inputs.request,
      reports: stage.inputs.reports.map(value => value.contentHash === report.contentHash ? report : value) });
    stageRebuilt = same(stage, rebuilt);
    if (!stageRebuilt) refuse('sources-rebuilt-stage-mismatch');
  }
  const result = { status: replay.matched ? 'detached-native-sources-restored' : 'detached-native-source-replay-mismatch',
    sourceBytesVerified: true, retainedReplayVerified: replay.matched, stageRebuiltWithPreservedCodexEvidence: stageRebuilt,
    retainedProviders: Object.fromEntries(replay.providers.map(({ family, status }) => [family, status])), ...receipt(checked) };
  await writePrivate(join(root, 'replay.json'), nativeUsageCanonicalJson(result));
  await publishManifest(root, checked.manifest);
  await verifyBundle(stage, root, budget, result);
  return result;
}
