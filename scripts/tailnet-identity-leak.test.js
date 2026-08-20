import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Regression guard: a real Tailscale MagicDNS tailnet suffix, real device
// names, and a real CGNAT peer IP were once committed across ~14 tracked
// files (server routes/lib, client lib, several test fixtures, doc plans,
// and two changelog entries) — a violation of this repo's own CLAUDE.md
// "Sensitive Data & Privacy" section, which lists Tailscale node/MagicDNS
// names and Tailscale/LAN IPs as never-commit categories. This test fails
// the moment a real-looking value of either kind lands in a tracked file
// again, so the leak can't silently recur via a pasted log line, a doc
// example lifted from a live install, or a copy-pasted test fixture.
//
// We enumerate via `git grep` rather than walking the tree so the check
// covers exactly *tracked* files — gitignored runtime data (e.g. `data/`)
// and the `lib/slashdo` submodule (a separate upstream repo, not ours to
// police) are excluded for free.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// This file's own detector self-check (below) necessarily contains strings
// shaped like the patterns it's guarding against, so it must exclude
// itself from the repo-wide scan — otherwise it would fail on its own
// fixtures.
const SELF_PATHSPEC = ':!scripts/tailnet-identity-leak.test.js';

/**
 * Real Tailscale MagicDNS tailnet suffixes are auto-generated as the literal
 * `tail` prefix followed by a short lowercase alphanumeric token.
 *
 * Deliberately NOT gated on "the token contains a digit". The value that
 * leaked happened to have one, but Tailscale picks the token at random from
 * lowercase alphanumerics — nothing stops it from being all letters, so a
 * digit gate leaves `device.tailabcxyz.ts.net` (a perfectly real hostname)
 * passing silently. Instead this matches the shape and subtracts the fake
 * suffixes by exact name below, which fails closed: a placeholder style
 * nobody has allowlisted yet trips the guard and gets looked at, rather than
 * a real hostname slipping through because it lacks a digit.
 */
const REAL_TAILNET_SUFFIX_SOURCE = '\\btail[a-z0-9]{2,10}\\.ts\\.net';
const REAL_TAILNET_SUFFIX_RE = /\btail([a-z0-9]{2,10})\.ts\.net/gi;

/**
 * Human-chosen fake tailnet suffixes already used across this repo's tests and
 * docs, matched on the token that follows `tail`. Add to this list when you
 * introduce a new placeholder — never widen the pattern above.
 */
const ALLOWED_TAILNET_TOKENS = new Set(['net', 'network', 'scale']);

/**
 * 100.64.0.0/10 is Tailscale's CGNAT range. Every address in this range that
 * is an intentional test/doc fixture (CGNAT-detection unit tests, the
 * documented Alibaba Cloud metadata IP used in SSRF-guard tests, this
 * finding's own redacted placeholders, …) is enumerated here. Anything else
 * found in a tracked file is treated as a possible real peer address.
 */
const ALLOWED_CGNAT_IPS = new Set([
  '100.64.0.0',
  '100.64.0.1',
  '100.64.0.5',
  '100.64.0.6',
  '100.64.0.50',
  '100.64.0.99',
  '100.100.42.7',
  '100.100.50.1',
  '100.100.100.200', // documented Alibaba Cloud metadata endpoint, not a peer
  '100.127.255.254', // synthetic top-of-CGNAT boundary value in tailnetPeer.test.js
]);
const CGNAT_IP_SOURCE = '\\b100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d{1,3}\\.\\d{1,3}\\b';
const CGNAT_IP_RE = /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g;

/** Runs `git grep -inP <pattern>` over tracked files and returns matching lines. */
function gitGrepLines(patternSource) {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-n', '-i', '-P', patternSource, '--', '.', ':!lib/slashdo', SELF_PATHSPEC],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    return out.trim().split('\n').filter(Boolean);
  } catch (err) {
    // git grep exits 1 when there are zero matches — that's the success case.
    if (err.status === 1) return [];
    throw err;
  }
}

/**
 * Every `tail<token>.ts.net` occurrence in `text` whose token is not a known
 * placeholder — i.e. the ones that look like a real auto-generated suffix.
 */
function realTailnetOffenders(text) {
  return [...text.matchAll(REAL_TAILNET_SUFFIX_RE)]
    .filter(([, token]) => !ALLOWED_TAILNET_TOKENS.has(token.toLowerCase()))
    .map(([match]) => match);
}

describe('no real Tailscale identity in tracked files (see CLAUDE.md Sensitive Data & Privacy)', () => {
  it('detector matches a real-shaped tailnet suffix and not existing placeholders (self-check)', () => {
    // Synthetic values shaped like real auto-generated Tailscale suffixes
    // (never observed real ones) — proves the detector actually fires.
    expect(realTailnetOffenders('device.tail9f00c2.ts.net')).toHaveLength(1);
    // An all-letters token is just as real: Tailscale picks the token from
    // lowercase alphanumerics, so a digit is not guaranteed. This is the case
    // a digit-gated pattern would silently let through.
    expect(realTailnetOffenders('device.tailabcxyz.ts.net')).toHaveLength(1);
    // Every placeholder style already used in this repo must NOT trip it.
    expect(realTailnetOffenders('host-alpha.example-tailnet.ts.net')).toEqual([]);
    expect(realTailnetOffenders('host.tailnet.ts.net')).toEqual([]);
    expect(realTailnetOffenders('my-machine.ts.net')).toEqual([]);
    expect(realTailnetOffenders('box.tail-net.ts.net')).toEqual([]);
  });

  it('finds no real-looking tail*.ts.net MagicDNS suffix in tracked files', () => {
    const offenders = gitGrepLines(REAL_TAILNET_SUFFIX_SOURCE)
      .filter((line) => realTailnetOffenders(line).length > 0);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('finds no un-allowlisted Tailscale CGNAT (100.64.0.0/10) address in tracked files', () => {
    const lines = gitGrepLines(CGNAT_IP_SOURCE);
    const offenders = lines.filter((line) => {
      const ips = line.match(CGNAT_IP_RE) || [];
      return ips.some((ip) => !ALLOWED_CGNAT_IPS.has(ip));
    });
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
