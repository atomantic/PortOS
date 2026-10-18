#!/usr/bin/env node

/**
 * Post the pregate attestation for a pushed commit.
 *
 * `npm run pregate` leaves a receipt (`.cache/pregate/report.json`) that names
 * the stages it ran and the hash of the exact working tree it validated. This
 * script turns a green receipt into a commit status — context `pregate`, state
 * `success`, description `tree=<hash> stages=<…>` — on the commit that carries
 * that same tree, so the pull request's impact planner can skip the attested
 * stages (`applyAttestation` in scripts/ci-test-plan.js). It runs AFTER the
 * push: GitHub only accepts a status on a commit it has.
 *
 *   node scripts/pregate-attest.js [--sha <40-hex>] [--dry-run] [--target-url <url>]
 *
 * Refuses, with the command to rerun, when the receipt did not pass or the
 * tree changed while pregate ran, when the commit's tree is not the receipt's
 * tree (something changed after pregate: rerun it on this exact state), when
 * the commit is not on the upstream remote yet, or when no stage qualifies.
 * Only stages that ran and passed are attested; a skipped or uncovered suite
 * is CI's to prove, exactly as the pregate summary said.
 *
 * Authentication is the operator's own `gh` login; nothing here reads or asks
 * for the PortOS instance password. Builtins only, like the other pregate
 * scripts, so it runs from any checkout without an install.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import {
  attestedStagesFromReceipt, encodeAttestation, parseRemoteRepository, PREGATE_STATUS_CONTEXT,
} from './lib/pregateAttestation.js';
import { PREGATE_REPORT_PATH } from './lib/pregateReport.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHA_RE = /^[0-9a-f]{40}$/;
const RERUN = 'rerun `npm run pregate` on this exact tree, then push and attest again';

export const USAGE = `Usage: node scripts/pregate-attest.js [--sha <40-hex>] [--dry-run] [--target-url <url>]

  --sha <40-hex>      attest this commit instead of HEAD (must carry the receipt's tree)
  --dry-run           print the status payload without posting it
  --target-url <url>  optional link to show beside the status
  -h, --help          display this usage

Run it AFTER \`git push\`: a commit status can only be created on a pushed commit.`;

/** Parse argv before any Git inspection. */
export function parseArgs(argv) {
  const options = { sha: null, dryRun: false, targetUrl: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--sha': {
        const value = argv[index + 1];
        if (!value || !SHA_RE.test(value)) throw new Error('--sha requires a full 40-character hex commit id.');
        options.sha = value;
        index += 1;
        break;
      }
      case '--target-url': {
        const value = argv[index + 1];
        if (!value || value.startsWith('-')) throw new Error('--target-url requires a value.');
        options.targetUrl = value;
        index += 1;
        break;
      }
      case '--dry-run': options.dryRun = true; break;
      case '--help':
      case '-h': options.help = true; break;
      default: throw new Error(`Unknown option: ${flag}.`);
    }
  }
  return options;
}

/** A refusal the operator can act on; `runAttest` prints it and returns 1. */
const refusal = (message) => Object.assign(new Error(message), { refusal: true });

/**
 * What to attest, given the receipt and the commit's own facts. Pure: the
 * caller supplies the tree lookup and the push check so this is testable
 * without a repository.
 *
 * @param {object} report - the parsed receipt
 * @param {{sha: string, treeOf: (sha: string) => string|null, isPushed: (sha: string) => boolean, remote: string}} commit
 * @returns {{sha: string, tree: string, stages: string[], description: string}}
 */
export function planAttestation(report, { sha, treeOf, isPushed, remote }) {
  if (!report || typeof report !== 'object') throw refusal(`no receipt at ${PREGATE_REPORT_PATH}; ${RERUN}`);
  if (typeof report.plan?.downgraded !== 'boolean') {
    throw refusal(`receipt at ${PREGATE_REPORT_PATH} predates attestation (no plan.downgraded); ${RERUN}`);
  }
  if (report.passed !== true) throw refusal(`receipt at ${PREGATE_REPORT_PATH} did not pass; fix the failure and ${RERUN}`);
  if (report.treeStable !== true) {
    throw refusal(`the working tree changed while pregate ran (${String(report.tree).slice(0, 12)} → ${String(report.treeAfterRun).slice(0, 12)}); ${RERUN}`);
  }
  const tree = treeOf(sha);
  if (!tree) throw refusal(`cannot resolve ${sha}^{tree}: is ${sha.slice(0, 9)} a commit in this checkout?`);
  if (tree !== report.tree) {
    throw refusal(`commit ${sha.slice(0, 9)} has tree ${tree.slice(0, 12)} but the receipt validated tree ${String(report.tree).slice(0, 12)} — something changed after pregate; ${RERUN}`);
  }
  if (!isPushed(sha)) {
    throw refusal(`commit ${sha.slice(0, 9)} is not on ${remote} yet: push it first (\`git push\`), then attest. A status can only be posted on a pushed commit.`);
  }
  const stages = attestedStagesFromReceipt(report);
  if (stages.length === 0) throw refusal(`the receipt attests no stage: nothing ran and passed beyond what CI must prove itself; ${RERUN}`);
  return { sha, tree, stages, description: encodeAttestation({ tree, stages }) };
}

/** The `gh api` invocation that creates the status; exported so tests can pin it. */
export function statusRequest({ owner, repo, host }, { sha, description, targetUrl }) {
  const args = [
    'api', '--method', 'POST', `repos/${owner}/${repo}/statuses/${sha}`,
    '-f', 'state=success', '-f', `context=${PREGATE_STATUS_CONTEXT}`, '-f', `description=${description}`,
  ];
  if (targetUrl) args.push('-f', `target_url=${targetUrl}`);
  if (host && host !== 'github.com') args.push('--hostname', host);
  return { command: 'gh', args };
}

/**
 * Run the attestation. `exec` is `spawnSync`-shaped and injectable so the
 * tests drive git and gh without a repository or a network.
 *
 * @returns {number} the process exit code
 */
export function runAttest({ argv = [], cwd = REPO_ROOT, exec = spawnSync, log = console.log, error = console.error, readReceipt = defaultReadReceipt } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (parseError) {
    error(`❌ ${parseError.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }

  const run = (command, args) => {
    const result = exec(command, args, { cwd, encoding: 'utf8' });
    return { ok: !result.error && result.status === 0, stdout: String(result.stdout ?? '').trim(), stderr: String(result.stderr ?? result.error?.message ?? '').trim() };
  };
  const git = (args) => {
    const result = run('git', args);
    return result.ok ? result.stdout : null;
  };

  try {
    const sha = options.sha ?? git(['rev-parse', 'HEAD']);
    if (!sha || !SHA_RE.test(sha)) throw refusal('cannot resolve HEAD; pass --sha <40-hex>.');
    const branch = git(['symbolic-ref', '--short', '-q', 'HEAD']);
    const remote = branch ? git(['config', '--get', `branch.${branch}.remote`]) : null;
    if (!remote) {
      throw refusal(`branch ${branch ?? '(detached HEAD)'} has no upstream remote; push it with \`git push -u <remote> ${branch ?? '<branch>'}\` first.`);
    }
    const remoteUrl = git(['remote', 'get-url', remote]);
    const repository = parseRemoteRepository(remoteUrl ?? '');
    if (!repository) throw refusal(`remote ${remote} has no owner/repo URL this script can read.`);

    const treeOf = (commit) => git(['rev-parse', '--verify', '--quiet', `${commit}^{tree}`]);
    // Remote-tracking refs are current right after a push; a commit nothing
    // under `<remote>/` contains has not been pushed (or not fetched back).
    const isPushed = (commit) => {
      const branches = git(['branch', '-r', '--contains', commit, '--format=%(refname:short)']);
      return branches !== null && branches.split('\n').some((name) => name.startsWith(`${remote}/`));
    };
    const attestation = planAttestation(readReceipt(cwd), { sha, treeOf, isPushed, remote });
    const request = statusRequest(repository, { ...attestation, targetUrl: options.targetUrl });
    const target = `${repository.owner}/${repository.repo}`;

    if (options.dryRun) {
      log(JSON.stringify({ repository: target, sha, context: PREGATE_STATUS_CONTEXT, state: 'success', description: attestation.description, target_url: options.targetUrl, command: [request.command, ...request.args] }, null, 2));
      log(`ℹ️ Dry run: no status posted for ${sha.slice(0, 9)} (tree ${attestation.tree.slice(0, 12)}, stages ${attestation.stages.join(',')}).`);
      return 0;
    }

    const posted = run(request.command, request.args);
    if (!posted.ok) {
      throw refusal(`gh could not create the status on ${target}: ${posted.stderr || posted.stdout || 'gh api failed'} (is \`gh auth status\` logged in with write access?)`);
    }
    log(`✅ Attested ${sha} tree=${attestation.tree} stages=${attestation.stages.join(',')} — status "${PREGATE_STATUS_CONTEXT}" on ${target}; the pull request's CI skips those stages.`);
    return 0;
  } catch (failure) {
    if (failure?.refusal === true) {
      error(`⛔ Not attested: ${failure.message}`);
      return 1;
    }
    throw failure;
  }
}

function defaultReadReceipt(root) {
  let raw;
  try {
    raw = readFileSync(join(root, PREGATE_REPORT_PATH), 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw refusal(`receipt at ${PREGATE_REPORT_PATH} is not JSON; ${RERUN}`);
  }
}

if (isDirectlyInvoked(import.meta.url)) {
  process.exitCode = runAttest({ argv: process.argv.slice(2) });
}
