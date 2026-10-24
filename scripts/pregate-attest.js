#!/usr/bin/env node

/**
 * Post the pregate attestation for a pushed commit.
 *
 * `npm run pregate` leaves a receipt (`.cache/pregate/report.json`) that names
 * the stages it ran and the hash of the exact working tree it validated. This
 * script turns a green receipt into a commit status — context `pregate`, state
 * `success`, description `tree=<hash> os=<platform> node=<major> stages=<…>` —
 * on the commit that carries that same tree, so the pull request's impact
 * planner can skip the attested stages (`applyAttestation` in
 * scripts/ci-test-plan.js). It runs AFTER the push: GitHub only accepts a
 * status on a commit it has. When you open the pull request yourself, attest
 * before `gh pr create`, so the status exists when the `pull_request` event
 * starts the run.
 *
 *   node scripts/pregate-attest.js [--sha <40-hex>] [--dry-run] [--target-url <url>]
 *   node scripts/pregate-attest.js --revoke [<reason>] [--sha <40-hex>]
 *
 * Refuses, with the command to rerun, when the receipt did not pass or the
 * tree changed while pregate ran, when the commit's tree is not the receipt's
 * tree (something changed after pregate: rerun it on this exact state), when
 * the commit is not on the upstream remote yet, or when no stage qualifies.
 * Only stages that ran and passed are attested; a skipped or uncovered suite
 * is CI's to prove, exactly as the pregate summary said. A receipt planned
 * against a `--base` other than the default branch's merge base attests no
 * server, client or lint stage: its selection was narrower than CI's.
 *
 * `--revoke` posts a `failure` status with the reason, which withdraws every
 * earlier attestation on that commit (the planner honors only the newest
 * `pregate` status). Authentication is the operator's own `gh` login; nothing
 * here reads or asks for the PortOS instance password. Builtins only, like
 * the other pregate scripts, so it runs from any checkout without an install.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import {
  attestedStagesFromReceipt, encodeAttestation, encodeRevocation, nodeMajor, parseRemoteRepository, PREGATE_STATUS_CONTEXT,
} from './lib/pregateAttestation.js';
import { PREGATE_REPORT_PATH } from './lib/pregateReport.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHA_RE = /^[0-9a-f]{40}$/;
const RERUN = 'rerun `npm run pregate` on this exact tree, then push and attest again';
/** Stages whose selection depends on the diff base; a narrowed base under-selects them. */
const BASE_DEPENDENT_STAGES = new Set(['server', 'client', 'lint']);

export const USAGE = `Usage: node scripts/pregate-attest.js [--sha <40-hex>] [--dry-run] [--target-url <url>]
       node scripts/pregate-attest.js --revoke [<reason>] [--sha <40-hex>] [--dry-run]

  --sha <40-hex>      attest this commit instead of HEAD (must carry the receipt's tree)
  --dry-run           print the status payload without posting it
  --target-url <url>  optional link to show beside the status
  --revoke [reason]   post a failure status that withdraws earlier attestations on the commit
  -h, --help          display this usage

Run it AFTER \`git push\` (and, for a new pull request, BEFORE \`gh pr create\`):
a commit status can only be created on a pushed commit.`;

/** Parse argv before any Git inspection. */
export function parseArgs(argv) {
  const options = { sha: null, dryRun: false, targetUrl: null, help: false, revoke: null };
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
      case '--revoke': {
        const value = argv[index + 1];
        options.revoke = value && !value.startsWith('-') ? value : '';
        if (options.revoke) index += 1;
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
 * caller supplies the tree lookup, the push check and the default merge base
 * so this is testable without a repository.
 *
 * @param {object} report - the parsed receipt
 * @param {{sha: string, treeOf: (sha: string) => string|null, isPushed: (sha: string) => boolean, remote: string, defaultMergeBase?: string|null}} commit
 * @returns {{sha: string, tree: string, stages: string[], description: string, notes: string[]}}
 */
export function planAttestation(report, { sha, treeOf, isPushed, remote, defaultMergeBase = null }) {
  if (!report || typeof report !== 'object') throw refusal(`no receipt at ${PREGATE_REPORT_PATH}; ${RERUN}`);
  if (typeof report.plan?.downgraded !== 'boolean') {
    throw refusal(`receipt at ${PREGATE_REPORT_PATH} predates attestation (no plan.downgraded); ${RERUN}`);
  }
  if (report.passed !== true) throw refusal(`receipt at ${PREGATE_REPORT_PATH} did not pass; fix the failure and ${RERUN}`);
  if (report.treeStable !== true) {
    throw refusal(`the working tree changed while pregate ran (${String(report.tree).slice(0, 12)} → ${String(report.treeAfterRun).slice(0, 12)}); ${RERUN}`);
  }
  // The runtime the stages ran on is the receipt's, not the attesting process's.
  const os = report.runtime?.platform;
  const node = nodeMajor(report.runtime?.node);
  if (typeof os !== 'string' || !/^[a-z0-9]+$/.test(os) || node === null) {
    throw refusal(`receipt at ${PREGATE_REPORT_PATH} has no valid runtime (platform/node); ${RERUN}`);
  }
  const tree = treeOf(sha);
  if (!tree) throw refusal(`cannot resolve ${sha}^{tree}: is ${sha.slice(0, 9)} a commit in this checkout?`);
  if (tree !== report.tree) {
    throw refusal(`commit ${sha.slice(0, 9)} has tree ${tree.slice(0, 12)} but the receipt validated tree ${String(report.tree).slice(0, 12)} — something changed after pregate; ${RERUN}`);
  }
  if (!isPushed(sha)) {
    throw refusal(`commit ${sha.slice(0, 9)} is not on ${remote} yet: push it first (\`git push\`), then attest. A status can only be posted on a pushed commit.`);
  }
  let stages = attestedStagesFromReceipt(report);
  const notes = [];
  // The receipt's plan was computed against its recorded base. CI plans
  // against the default branch's merge base; a `--base` nearer the head (or an
  // unknown one) selected fewer tests, so the diff-selected stages are not
  // CI's stages and cannot be attested. The resource suites run whole.
  const receiptBase = typeof report.base?.sha === 'string' ? report.base.sha : null;
  if (!receiptBase || !defaultMergeBase || receiptBase !== defaultMergeBase) {
    const dropped = stages.filter((stage) => BASE_DEPENDENT_STAGES.has(stage));
    stages = stages.filter((stage) => !BASE_DEPENDENT_STAGES.has(stage));
    if (dropped.length > 0) {
      notes.push(`not attesting ${dropped.join(', ')}: the receipt was planned against base ${receiptBase ? receiptBase.slice(0, 9) : '(unknown)'} (${report.base?.ref ?? report.options?.base ?? '--base'}), not the default branch's merge base ${defaultMergeBase ? defaultMergeBase.slice(0, 9) : '(unresolved)'}; rerun pregate without --base to attest them`);
    }
  }
  if (stages.length === 0) throw refusal(`the receipt attests no stage: nothing ran and passed beyond what CI must prove itself${notes.length ? ` (${notes.join('; ')})` : ''}; ${RERUN}`);
  return { sha, tree, stages, description: encodeAttestation({ tree, stages, os, node }), notes };
}

/** The `gh api` invocation that creates a status; exported so tests can pin it. */
export function statusRequest({ owner, repo, host }, { sha, description, targetUrl, state = 'success' }) {
  const args = [
    'api', '--method', 'POST', `repos/${owner}/${repo}/statuses/${sha}`,
    '-f', `state=${state}`, '-f', `context=${PREGATE_STATUS_CONTEXT}`, '-f', `description=${description}`,
  ];
  if (targetUrl) args.push('-f', `target_url=${targetUrl}`);
  if (host && host !== 'github.com') args.push('--hostname', host);
  return { command: 'gh', args };
}

/**
 * The repository the status goes to. The upstream remote's URL is the first
 * word; when its host is an ssh alias (`git@github-acme:…`) or unparseable,
 * `gh repo view` from the checkout — which resolves the alias through the
 * same ssh config git does — names the real host and owner/repo.
 */
export function resolveRepository(remoteUrl, { ghRepoView }) {
  const parsed = parseRemoteRepository(remoteUrl ?? '');
  if (parsed?.hostIsResolvable) return parsed;
  const viewed = ghRepoView();
  const url = viewed?.url ? parseRemoteRepository(viewed.url) : null;
  const [owner, repo] = typeof viewed?.nameWithOwner === 'string' ? viewed.nameWithOwner.split('/') : [];
  if (url?.hostIsResolvable && owner && repo) return { host: url.host, owner, repo, hostIsResolvable: true };
  return parsed?.hostIsResolvable ? parsed : null;
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
    const ghRepoView = () => {
      const viewed = run('gh', ['repo', 'view', '--json', 'nameWithOwner,url']);
      if (!viewed.ok) return null;
      try {
        return JSON.parse(viewed.stdout);
      } catch {
        return null;
      }
    };
    const repository = resolveRepository(git(['remote', 'get-url', remote]), { ghRepoView });
    if (!repository) throw refusal(`remote ${remote} has no owner/repo URL this script can read, and \`gh repo view\` could not name the repository.`);
    const target = `${repository.owner}/${repository.repo}`;

    const treeOf = (commit) => git(['rev-parse', '--verify', '--quiet', `${commit}^{tree}`]);
    // Keep the local containment fast path. URL/path pushes may leave these
    // refs stale, so ask the configured remote through its existing transport
    // for exact advertised branch tips without fetching or changing the tree.
    const isPushed = (commit) => {
      const branches = git(['branch', '-r', '--contains', commit, '--format=%(refname:short)']);
      if (branches !== null && branches.split('\n').some((name) => name.startsWith(`${remote}/`))) return true;
      const advertised = git(['ls-remote', '--heads', remote]);
      if (advertised === null) throw refusal(`cannot verify publication of ${commit.slice(0, 9)} on ${remote}: remote branch tips could not be read; check remote access, then attest again.`);
      const tips = advertised ? advertised.split('\n') : [];
      if (tips.some((line) => !/^[0-9a-f]{40}\trefs\/heads\/[^\s]+$/.test(line))) {
        throw refusal(`cannot verify publication of ${commit.slice(0, 9)} on ${remote}: malformed remote branch tips; no status posted.`);
      }
      return tips.some((line) => line.startsWith(`${commit}\t`));
    };

    if (options.revoke !== null) {
      if (!isPushed(sha)) throw refusal(`commit ${sha.slice(0, 9)} is not on ${remote}: there is no status to revoke.`);
      const description = encodeRevocation(options.revoke);
      const request = statusRequest(repository, { sha, description, state: 'failure' });
      if (options.dryRun) {
        log(JSON.stringify({ repository: target, sha, context: PREGATE_STATUS_CONTEXT, state: 'failure', description, command: [request.command, ...request.args] }, null, 2));
        return 0;
      }
      const posted = run(request.command, request.args);
      if (!posted.ok) throw refusal(`gh could not create the revocation on ${target}: ${posted.stderr || posted.stdout || 'gh api failed'}`);
      log(`⛔ Revoked the pregate attestation on ${sha} — status "${PREGATE_STATUS_CONTEXT}" is now failure (${description}); the pull request's CI runs every stage.`);
      return 0;
    }

    // The default branch of the upstream remote, as `git clone` records it;
    // `<remote>/main` when the symbolic ref was never set.
    const defaultBranch = git(['symbolic-ref', '--short', '-q', `refs/remotes/${remote}/HEAD`]) || `${remote}/main`;
    const defaultMergeBase = git(['merge-base', defaultBranch, sha]);
    const attestation = planAttestation(readReceipt(cwd), { sha, treeOf, isPushed, remote, defaultMergeBase });
    attestation.notes.forEach((note) => log(`⚠️ ${note}.`));
    const request = statusRequest(repository, { ...attestation, targetUrl: options.targetUrl });

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
