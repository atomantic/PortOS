#!/usr/bin/env node
/**
 * Block a change that hides content from the human reviewing it.
 *
 * This runs BEFORE any reviewer — human or model — reads the diff: plain
 * pattern matching over the added lines, so it costs no provider call and
 * cannot be argued out of a verdict by the content it is reading. A finding is
 * a hard failure, because each shape it looks for (invisible Unicode, a
 * cluster of otherwise-ordinary invisible characters, an encoded or compressed
 * payload) means the diff a reviewer approves is not the change that lands.
 *
 * Runs in the CI `impact` job before any dependency install, so it stays on
 * Node builtins plus pure `server/lib` modules (see
 * scripts/pre-install-entrypoints.test.js).
 *
 * Usage:
 *   node scripts/scan-diff-hidden-content.js              # vs CI_BASE_SHA, else origin/main
 *   node scripts/scan-diff-hidden-content.js --base <ref>
 *   git diff | node scripts/scan-diff-hidden-content.js --stdin
 *
 * Exit codes: 0 clean, 1 findings, 2 the diff could not be read.
 */

import { execFileSync } from 'node:child_process';
import { gitRevParse } from './ci-base-sha.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import {
  formatHiddenContentFindings,
  HIDDEN_CONTENT_ALLOW_MARKER,
  scanDiffForHiddenContent,
} from '../server/lib/diffHiddenContentScan.js';

// A diff this size is already past every other limit in CI; the bound exists
// so a runaway input fails loudly instead of exhausting the box.
const MAX_DIFF_BYTES = 256 * 1024 * 1024;

const readStdin = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks.map(Buffer.from)).toString('utf8');
};

/**
 * The commit to diff against, or null when this run has none.
 *
 * Resolution order is the same one `ci-test-plan.js` uses, through the same
 * `gitRevParse`, so the gate and the planner cannot end up scanning and
 * testing different diffs.
 */
export function resolveBase(explicit) {
  const candidates = explicit
    ? [explicit]
    : [process.env.CI_BASE_SHA, 'origin/main', 'main'].filter(Boolean);
  for (const candidate of candidates) {
    const sha = gitRevParse(candidate);
    if (sha) return sha;
  }
  return null;
}

/**
 * Run the gate. Returns the process exit code and the lines to print, so the
 * suite can exercise the real verdict in-process rather than through a spawn.
 */
export async function runHiddenContentScan({
  argv = [],
  stdin = null,
  env = process.env,
  resolveDiffBase = resolveBase,
} = {}) {
  const baseFlag = argv.indexOf('--base');
  const explicit = baseFlag === -1 ? null : argv[baseFlag + 1];
  let diff;

  if (argv.includes('--stdin')) {
    diff = typeof stdin === 'string' ? stdin : await readStdin(stdin || process.stdin);
  } else {
    const base = resolveDiffBase(explicit);
    if (!base) {
      // A pull request always has a base, so failing to find one there means
      // the gate would scan nothing — the one outcome a gate must not report
      // as success. Elsewhere (a scheduled run, a local checkout) there is
      // genuinely no diff to scan.
      const onPullRequest = env.GITHUB_EVENT_NAME === 'pull_request';
      return {
        code: explicit || onPullRequest ? 2 : 0,
        lines: [explicit || onPullRequest
          ? `❌ Hidden-content scan could not resolve a diff base${explicit ? `: ${explicit}` : ''}`
          : '⏭️  Hidden-content scan skipped: this run has no pull-request diff base'],
      };
    }
    // Three-dot: only what this branch added, not what the base moved on to.
    diff = execFileSync('git', ['diff', '--unified=0', '--no-color', `${base}...HEAD`], {
      encoding: 'utf8',
      maxBuffer: MAX_DIFF_BYTES,
    });
  }

  const findings = scanDiffForHiddenContent(diff);
  if (findings.length === 0) {
    return { code: 0, lines: ['✅ Hidden-content scan clean: no invisible Unicode or encoded payloads in the added lines'] };
  }
  return {
    code: 1,
    lines: [
      `❌ Hidden-content scan found ${findings.length} blocking issue(s):`,
      ...formatHiddenContentFindings(findings).map((line) => `   ${line}`),
      `   Remove the content, or — when the bytes are deliberate — mark the line with "${HIDDEN_CONTENT_ALLOW_MARKER}".`,
    ],
  };
}

async function main() {
  const { code, lines } = await runHiddenContentScan({ argv: process.argv.slice(2) });
  for (const line of lines) (code === 0 ? console.log : console.error)(line);
  process.exitCode = code;
}

if (isDirectlyInvoked(import.meta.url)) {
  main().catch((error) => {
    console.error(`❌ Hidden-content scan failed: ${error.message}`);
    process.exitCode = 2;
  });
}
