#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, platform, arch } from 'node:os';
import { runNpm, toRunnerPath } from './run-ci-tests.js';
import { BROWSER_FIDELITY_FILES, browserTestProfileArgs, assertBrowserProfileExecuted } from './lib/browserTestProfiles.js';
import { browserFidelityTarget, browserFidelityContext, browserReceiptDigest, browserFidelityActor } from './lib/browserFidelity.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { sweepStaleRunRoots, writeOwnerFile } from './lib/vitestStaleRunRoots.js';
import { safeFailureReason } from './lib/fidelityDiagnostic.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function gh(args, input) {
  try { return execFileSync('gh', args, { encoding: 'utf8', input, timeout: 15000, maxBuffer: 2 * 1024 * 1024 }); }
  catch { throw Error('GitHub CLI request failed; existing authentication/permissions are required.'); }
}

async function ghRequest(path, body) {
  const args = ['api', path];
  if (body) args.push('--method', 'POST', '--input', '-');
  try { return JSON.parse(gh(args, body ? JSON.stringify(body) : undefined)); }
  catch { throw Error('GitHub CLI evidence/status request failed.'); }
}

const gitRead = args => {
  try { return execFileSync('git', args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'], cwd: repoRoot }).trim(); }
  catch { throw Error('Git checkout identity unavailable.'); }
};

export function fidelityChildEnv(env, diagnostics) {
  const child = Object.fromEntries(Object.entries(env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|COOKIE|CREDENTIAL/i.test(key)));
  delete child.PORTOS_CI_BROWSER_OWNER;
  return { ...child, PORTOS_CI_DIAGNOSTICS_DIR: diagnostics, PORTOS_REQUIRE_BROWSER_SUITES: '1',
    PORTOS_BROWSER_TEST_PROFILE: 'fidelity', PORTOS_PREGATE_MAX_WORKERS: '1' };
}

async function fidelityToolchain(env) {
  const { findFfmpeg } = await import('../server/lib/ffmpeg.js');
  const { _testChromeCaptureArgs } = await import('../server/services/htmlComposition/testBrowserCleanup.js');
  const chromePath = resolveTestChrome(env);
  const ffmpegPath = await findFfmpeg();
  if (!chromePath || !ffmpegPath) throw Error('Fidelity Chrome/FFmpeg toolchain unavailable.');
  // Surface the structured probe cause here: the suite's own prerequisite gate
  // reports through vitest output, which this command's refusal never relays.
  const { probeChromeH264, describeH264Probe, resolveTestChrome } = await import('../server/lib/browserSuiteGate.js');
  const probe = await probeChromeH264(chromePath);
  if (!probe.ok) throw Error(describeH264Probe(probe));
  const version = (path, args) => {
    const text = execFileSync(path, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
      stdio: ['ignore', 'pipe', 'ignore'], env: fidelityChildEnv(env, '') });
    const line = text.split(/\r?\n/)[0].replace(/[^\x20-\x7E]/g, '').slice(0, 240);
    if (!line) throw Error('Native tool version unavailable.');
    return line;
  };
  return { chromePath, receipt: { node: process.version, os: platform(), arch: arch(),
    chrome: version(chromePath, ['--version']), ffmpeg: version(ffmpegPath, ['-version']),
    renderBackend: { kind: 'unknown', reason: 'Existing profile does not report runtime graphics backend.',
      launchFlags: _testChromeCaptureArgs('receipt').filter(arg => arg.startsWith('--') && !arg.startsWith('--user-data-dir=')) } } };
}

function assertCheckout(git, target) {
  if (git(['status', '--porcelain=v1', '--untracked-files=all'])) throw Error('Browser fidelity requires a clean checkout.');
  if (git(['rev-parse', 'HEAD']) !== target.head) throw Error('Checkout must match the current PR head.');
  if (git(['rev-parse', 'HEAD^{tree}']) !== target.tree) throw Error('Checkout tree differs from the current PR head tree.');
}

function readCompletedProfile(root) {
  const attempts = readdirSync(root).filter(name => /^portos-vitest-[\w-]+$/.test(name));
  if (attempts.length !== 1) throw Error('Expected one complete fidelity invocation, without retry.');
  const directory = join(root, attempts[0]);
  const read = (name, limit) => {
    const path = join(directory, name);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw Error('Fidelity report is unavailable or exceeds its bound.');
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  const invocation = read('invocation.json', 100000);
  const run = read('run.json', 160000);
  if (invocation.completed !== true || invocation.status !== 0 || invocation.signal
    || run.reason !== 'passed' || run.errorCount !== 0 || !Array.isArray(run.errors) || run.errors.length || run.teardownTimeout
    || !Number.isSafeInteger(run.completedCount) || run.completedCount < BROWSER_FIDELITY_FILES.length
    || !Array.isArray(run.activeModules) || run.activeModules.length) throw Error('Fidelity invocation/teardown did not complete cleanly.');
  const report = read('failures.json', 32 * 1024 * 1024);
  if (report.success !== true || Number(report.numFailedTests) !== 0 || Number(report.numFailedTestSuites) !== 0) {
    throw Error('Fidelity structured result did not pass.');
  }
  return assertBrowserProfileExecuted('fidelity', report);
}

export async function publishBrowserFidelity({ pr, repository, receiptPath, env = process.env,
  request = ghRequest, git = gitRead, run = runNpm, toolchain = fidelityToolchain, deadlineMs = 15 * 60_000,
} = {}) {
  // gh resolves the configured repository/host; never assume an upstream owner.
  repository ??= JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
  const target = await browserFidelityTarget(repository, pr, request);
  assertCheckout(git, target);
  const user = await request('user');
  if (user?.login?.toLowerCase() !== browserFidelityActor(repository)) throw Error('Existing GitHub authentication is not a trusted fidelity publisher.');
  const context = browserFidelityContext(target);
  // Rejected runs retain diagnostics; reclaim those from dead or aged prior runs.
  sweepStaleRunRoots(tmpdir(), { prefix: 'portos-browser-fidelity-' });
  const root = mkdtempSync(join(tmpdir(), 'portos-browser-fidelity-'));
  writeOwnerFile(root);
  const diagnostics = join(root, 'diagnostics');
  mkdirSync(diagnostics);
  const output = receiptPath ? resolve(receiptPath) : join(root, 'receipt.json');
  const statusPath = `repos/${repository}/statuses/${target.head}`;
  const post = async (state, description) => {
    const status = await request(statusPath, { state, context, description });
    if (status?.state !== state || status?.context !== context
      || status?.creator?.login?.toLowerCase() !== browserFidelityActor(repository)) throw Error('Fidelity status publication is unconfirmed.');
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const startedAt = new Date().toISOString();
  try {
    await post('pending', 'Required local browser fidelity is running.');
    const tools = await toolchain(env);
    const childEnv = fidelityChildEnv(env, diagnostics);
    childEnv.CHROME_PATH = tools.chromePath;
    const result = await run('server', 'test:ci', [
      ...BROWSER_FIDELITY_FILES.map(file => toRunnerPath('server', file)), ...browserTestProfileArgs('fidelity'),
    ], { env: childEnv, signal: controller.signal });
    controller.signal.throwIfAborted();
    if (result.status !== 0 || result.error || result.interrupted) throw Error('Browser fidelity failed or owned cleanup is unverified.');
    const executed = readCompletedProfile(diagnostics);
    assertCheckout(git, target);
    const current = await browserFidelityTarget(repository, pr, request);
    if (browserFidelityContext(current) !== context) throw Error('PR head, head tree, or fidelity policy changed during execution.');
    controller.signal.throwIfAborted();
    const receipt = { version: 1, target, context, startedAt, completedAt: new Date().toISOString(),
      toolchain: tools.receipt,
      profile: { files: BROWSER_FIDELITY_FILES, args: browserTestProfileArgs('fidelity'), executed },
      result: 'passed' };
    // The receipt remains local. No cloud artifact or remotely verified log is
    // implied by the status; its trusted publisher attests this completed run.
    writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    assertCheckout(git, target);
    controller.signal.throwIfAborted();
    await post('success', `receipt sha256=${browserReceiptDigest(receipt)}`);
    // Admitted: only the receipt is kept. A root holding nothing else goes too.
    rmSync(diagnostics, { recursive: true, force: true });
    if (dirname(output) !== root) rmSync(root, { recursive: true, force: true });
    return { receiptPath: output, diagnosticsPath: diagnostics, context, executed };
  } catch (cause) {
    await post('failure', 'Required browser fidelity failed, changed, or did not complete.').catch(() => {});
    throw Object.assign(Error('Browser fidelity was not admitted; local diagnostics were retained.'),
      { diagnosticsPath: diagnostics, reason: safeFailureReason(cause) });
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

if (isDirectlyInvoked(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  try {
    if (args.some((arg, index) => index % 2 === 0 && !['--pr', '--repo', '--receipt'].includes(arg))
      || args.length % 2 || !/^\d+$/.test(value('--pr') ?? '')) throw Error('Invalid browser fidelity arguments.');
    const result = await publishBrowserFidelity({ pr: Number(value('--pr')), repository: value('--repo'), receiptPath: value('--receipt') });
    console.log(`✅ Browser fidelity receipt saved locally (${result.executed} executed tests); trusted status published.`);
    console.log(`Receipt: ${result.receiptPath}`);
    console.log(`Local diagnostics: ${result.diagnosticsPath}`);
  } catch (error) {
    console.error('❌ Browser fidelity was not admitted. Use --pr N on its clean current head with existing trusted gh authentication.');
    const reason = error.reason ?? safeFailureReason(error);
    if (reason) console.error(`Reason: ${reason}`);
    if (error.diagnosticsPath) console.error(`Local diagnostics retained: ${error.diagnosticsPath}`);
    process.exitCode = 1;
  }
}
