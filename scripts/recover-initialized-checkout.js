#!/usr/bin/env node
/**
 * Guarded bootstrap for an interrupted initialized checkout transaction.
 * Run reviewed code from an independent checkout when its install's durable
 * retirement cut prevents the normal update. Never edits the install's code.
 *
 * node scripts/recover-initialized-checkout.js <action> request.json \
 *   --install-root /absolute/install --output /absolute/new-private-record.jsonl
 * Actions: review, restore, review-finalization, finalize,
 * review-quarantine, resume-quarantine, cancel-preservation.
 *
 * Output is an exclusive 0600 JSONL journal: a durable pending intent precedes
 * the service call; a completed response is appended. A lone pending line means
 * inspect the transaction before retrying. Full transition evidence stays in
 * the service's private transaction artifact; stdout contains a small summary.
 */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_REQUEST_BYTES = 16 * 1024;
// Two patches and a path inventory each have a 4 MiB Git output budget.
// JSON escaping can expand these sixfold (72 MiB); reserve another 24 MiB for
// native/forge evidence and the envelope. Refuse larger records, never truncate.
const MAX_RESPONSE_BYTES = 96 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ACTIONS = {
  review: { method: 'reviewMetadataRestore', acceptedReview: false },
  restore: { method: 'restoreMetadata', acceptedReview: true },
  'review-finalization': { method: 'reviewRestoredFinalization', acceptedReview: false },
  finalize: { method: 'finalizeRestored', acceptedReview: true },
  'review-quarantine': { method: 'reviewQuarantineResumption', acceptedReview: false },
  'resume-quarantine': { method: 'resumeQuarantine', acceptedReview: true, supersession: true },
  'cancel-preservation': { method: 'cancelPreservation', acceptedReview: false },
};
const fail = code => { throw Object.assign(new Error(code), { recoveryCode: code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

export function parseRecoveryArgs(argv) {
  const [action, requestPath, ...options] = argv;
  if (!Object.hasOwn(ACTIONS, action) || !requestPath || requestPath.startsWith('--')) fail('recovery-usage');
  const parsed = { action, requestPath };
  for (let i = 0; i < options.length; i += 2) {
    const key = { '--install-root': 'installRoot', '--output': 'outputPath' }[options[i]];
    if (!key || parsed[key] || !options[i + 1] || options[i + 1].startsWith('--')) fail('recovery-usage');
    parsed[key] = options[i + 1];
  }
  if (!parsed.installRoot || !parsed.outputPath || !isAbsolute(parsed.installRoot) || !isAbsolute(parsed.outputPath)) fail('recovery-absolute-path-required');
  return parsed;
}

async function canonicalDirectory(path) {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path || !(await lstat(path)).isDirectory()) fail('recovery-path-not-canonical');
  return path;
}

async function readJson(path, limit) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) fail('recovery-json-file-invalid');
    const raw = await handle.readFile('utf8');
    const after = await handle.stat();
    if (Buffer.byteLength(raw) > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('recovery-json-file-changed');
    try { return JSON.parse(raw); } catch { fail('recovery-json-invalid'); }
  } finally { await handle.close(); }
}

function validateRequest(action, request) {
  const acceptedReview = ACTIONS[action].acceptedReview;
  const keys = ['appId', 'transactionId', 'journalDigest', ...(acceptedReview ? ['review'] : [])];
  const hasSupersession = ACTIONS[action].supersession && object(request?.review)
    && Object.hasOwn(request.review, 'acceptSuperseded');
  const reviewKeys = ['digest', ...(hasSupersession ? ['acceptSuperseded'] : [])];
  if (!exactKeys(request, keys) || typeof request.appId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.appId)
    || typeof request.transactionId !== 'string' || !ID.test(request.transactionId)
    || typeof request.journalDigest !== 'string' || !HASH.test(request.journalDigest)
    || (acceptedReview && (!exactKeys(request.review, reviewKeys)
      || typeof request.review.digest !== 'string' || !HASH.test(request.review.digest)
      || (hasSupersession && typeof request.review.acceptSuperseded !== 'boolean')))) fail('recovery-request-invalid');
  return request;
}

async function prepareInstall(installRoot, appId) {
  await canonicalDirectory(installRoot);
  // The safety reader calls ensureDirectories. Requiring every existing input
  // prevents this bootstrap from initializing an empty or mistyped install.
  for (const relative of ['data', 'data/cos', 'data/cos/agents', 'data/cos/reports', 'data/cos/scripts', 'data/cos/initialized-checkout-retirements']) {
    await canonicalDirectory(join(installRoot, relative));
  }
  const state = await readJson(join(installRoot, 'data/cos/state.json'), 64 * 1024 * 1024);
  if (!object(state) || !object(state.agents)) fail('recovery-ownership-unreadable');
  const context = async requestedId => {
    if (requestedId !== appId) fail('recovery-app-changed');
    const apps = await readJson(join(installRoot, 'data/apps.json'), 16 * 1024 * 1024);
    const app = object(apps?.apps) && Object.hasOwn(apps.apps, appId) ? apps.apps[appId] : null;
    if (!object(app) || (Object.hasOwn(app, 'id') && app.id !== appId) || app.repoPath !== installRoot) fail('recovery-app-install-mismatch');
    await canonicalDirectory(app.repoPath);
    if (app.forgeAccount != null && typeof app.forgeAccount !== 'string') fail('recovery-app-invalid');
    return { repoPath: app.repoPath, forgeAccount: app.forgeAccount ?? null };
  };
  await context(appId);
  return { context, root: () => join(installRoot, 'data/cos/initialized-checkout-retirements') };
}

async function loadRecovery(deps, installRoot) {
  // No PATHS-dependent import occurs until the explicit pin is in place.
  const { PATHS } = await import('../server/lib/paths.js');
  if (await realpath(PATHS.installRoot) !== installRoot || await realpath(PATHS.root) !== await realpath(CODE_ROOT)) fail('recovery-data-root-pin-refused');
  const { _createInitializedCheckoutRecovery } = await import('../server/services/initializedCheckoutRecovery.js');
  return _createInitializedCheckoutRecovery(deps);
}

const safeReason = value => typeof value === 'string' && /^[a-z0-9:-]{1,160}$/.test(value) ? value : 'recovery-failed';

/** IO/factory injection lets tests exercise the CLI boundary without live data. */
export async function runRecovery(argv, { load = loadRecovery, stdout = value => process.stdout.write(value) } = {}) {
  let output;
  let record;
  const previousRoot = process.env.PORTOS_DATA_ROOT;
  try {
    const options = parseRecoveryArgs(argv);
    const request = validateRequest(options.action, await readJson(resolve(options.requestPath), MAX_REQUEST_BYTES));
    const deps = await prepareInstall(options.installRoot, request.appId);
    await canonicalDirectory(dirname(options.outputPath));
    if (resolve(options.outputPath) !== options.outputPath) fail('recovery-path-not-canonical');
    output = await open(options.outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    record = { startedAt: new Date().toISOString(), action: options.action, installRoot: options.installRoot,
      codeRoot: CODE_ROOT, request, outcome: 'pending-or-uncertain' };
    await output.writeFile(`${JSON.stringify(record)}\n`);
    await output.sync();
    if (process.platform !== 'win32') {
      const parent = await open(dirname(options.outputPath), constants.O_RDONLY);
      try { await parent.sync(); } finally { await parent.close(); }
    }
    process.env.PORTOS_DATA_ROOT = options.installRoot;
    const service = await load(deps, options.installRoot);
    const response = await service[ACTIONS[options.action].method](request);
    const completion = { completedAt: new Date().toISOString(), outcome: 'response-recorded', response };
    const serialized = JSON.stringify(completion);
    if (Buffer.byteLength(serialized) > MAX_RESPONSE_BYTES) fail('recovery-response-exceeds-budget');
    await output.writeFile(`${serialized}\n`);
    await output.sync();
    const summary = { ok: response?.ok === true, output: options.outputPath, transactionId: request.transactionId };
    if (response?.reason) summary.reason = safeReason(response.reason);
    for (const key of ['phase', 'journalDigest']) if (typeof response?.[key] === 'string' && response[key].length <= 128) summary[key] = response[key];
    if (HASH.test(response?.review?.digest ?? '')) summary.reviewDigest = response.review.digest;
    stdout(`${JSON.stringify(summary)}\n`);
    return response?.ok === true ? 0 : 1;
  } catch (error) {
    const reason = error.recoveryCode || (error.code === 'EEXIST' ? 'recovery-output-already-exists' : 'recovery-failed');
    if (output && record) {
      await output.writeFile(`${JSON.stringify({ completedAt: new Date().toISOString(), outcome: 'inspect-before-any-retry', reason })}\n`).catch(() => {});
      await output.sync().catch(() => {});
    }
    stdout(`${JSON.stringify({ ok: false, reason })}\n`);
    return 1;
  } finally {
    await output?.close();
    if (previousRoot === undefined) delete process.env.PORTOS_DATA_ROOT;
    else process.env.PORTOS_DATA_ROOT = previousRoot;
  }
}

if (isDirectlyInvoked(import.meta.url)) process.exitCode = await runRecovery(process.argv.slice(2));
