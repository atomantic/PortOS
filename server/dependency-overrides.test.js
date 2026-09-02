import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { discoverWorkspaces } from '../scripts/trusted-rebuilds.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const MANIFESTS = [
  'package.json',
  'server/package.json',
  'client/package.json',
  'autofixer/package.json'
];

const readOverrides = (rel) => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));
  return pkg.overrides ?? {};
};

// Tracked, not on-disk. `browser/package-lock.json` is deliberately gitignored
// (.gitignore) yet appears the moment anyone runs an install there, so an
// existsSync() probe would make these assertions depend on the developer's
// working tree. What ships in the repo is the thing under governance.
const trackedLockfiles = () =>
  new Set(
    execFileSync('git', ['ls-files', '--', '*package-lock.json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    })
      .split('\n')
      .filter(Boolean)
  );

const workspacePrefix = (label) => (label === 'root' ? '' : `${label}/`);

// PortOS pins security fixes for transitive dependencies as `overrides` in FOUR
// independent manifests (root, server/, client/, autofixer/) — each with its own
// lockfile, so npm resolves each tree separately. The recurring failure (issue #2848) is that a
// CVE gets pinned in one manifest and the others quietly keep the vulnerable
// version: `brace-expansion` sat at the patched 5.0.6 in server/ while root and
// client/ stayed on the vulnerable 5.0.5, so `npm audit` stayed red in two of three
// workspaces long after the fix "landed".
//
// These are source-level assertions (parse the manifests, compare the pins) rather
// than a live `npm audit` shell-out: audit needs the network and its output drifts
// as new advisories publish, which would make this suite flaky and time-dependent.
// The point is narrower and stable — when a package is pinned in more than one
// manifest, every manifest must agree on the version.
describe('dependency override parity across manifests (#2848)', () => {
  it('pins the same version wherever a package is overridden in more than one manifest', () => {
    const byPackage = new Map();
    for (const rel of MANIFESTS) {
      for (const [name, version] of Object.entries(readOverrides(rel))) {
        // Nested overrides (`"minimatch@3": { ... }`) are scoped to one consumer's
        // subtree and are intentionally manifest-specific — compare only flat pins.
        if (typeof version !== 'string') continue;
        if (!byPackage.has(name)) byPackage.set(name, new Map());
        byPackage.get(name).set(rel, version);
      }
    }

    const mismatches = [];
    for (const [name, pins] of byPackage) {
      const versions = new Set(pins.values());
      if (pins.size > 1 && versions.size > 1) {
        const detail = [...pins].map(([rel, v]) => `${rel}=${v}`).join(', ');
        mismatches.push(`${name}: ${detail}`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('pins no override to a version known to be vulnerable', () => {
    // Minimum patched versions for advisories this repo has already remediated.
    // Add a row here when a new CVE is pinned, so a later careless downgrade of the
    // override (or a copy-paste of a stale pin into a new manifest) fails loudly.
    //
    // Each entry is scoped to the MAJOR LINE the flat override pins. `brace-expansion`
    // is also pinned on the 1.x line, but only inside client/'s nested `minimatch@3`
    // override — which this check skips along with every other nested pin, so the 5.x
    // minimum below is never compared against a legitimate 1.1.x value. If a 1.x pin
    // ever becomes a flat override, this table needs a per-major shape first.
    const MINIMUM_SAFE = {
      'brace-expansion': '5.0.7', // GHSA-3jxr-9vmj-r5cp (5.x line)
      'protobufjs': '7.6.5', // GHSA-j3f2-48v5-ccww
      'body-parser': '2.3.0', // GHSA-v422-hmwv-36x6
      // GHSA-52cp-r559-cp3m, then GHSA-5p4m-2wfm-xmqj (quadratic CPU in !!omap
      // resolution, CVE-2026-59870) which covers 4.0.0–4.3.0 — the previous 4.3.0
      // floor is itself vulnerable, so the 4.x line must be at least 4.3.1.
      'js-yaml': '4.3.1',
      'tar': '7.5.21', // GHSA-vmf3-w455-68vh et al
      // GHSA-2v37-7h3g-55p8 (zero-size custom generators loop forever). Only reachable
      // via postcss, which asks for ^3.3.16 — the 3.x line is the one to floor.
      'nanoid': '3.3.17',
      // GHSA-f88m-g3jw-g9cj (libvips CVE-2026-33327/33328/35590/35591). Pinned in
      // server/ only, so the parity assertion above never sees it — this floor is
      // the sole guard against a downgrade back onto the vulnerable 0.34.x line
      // that @huggingface/transformers still requests.
      'sharp': '0.35.0'
    };

    const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

    const cmp = (a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i += 1) {
        if (pa[i] !== pb[i]) return pa[i] - pb[i];
      }
      return 0;
    };

    const stale = [];
    for (const rel of MANIFESTS) {
      for (const [name, version] of Object.entries(readOverrides(rel))) {
        if (typeof version !== 'string') continue;
        const min = MINIMUM_SAFE[name];
        if (!min) continue;
        // A security override must be an EXACT pin. A range (`^5.0.7`, `~5.0.7`,
        // `>=5.0.7`) lets npm resolve anywhere in the range on a fresh install, which
        // defeats the point of pinning a patched version — and would parse to NaN
        // below and silently compare as "safe". Reject it outright.
        if (!EXACT_VERSION.test(version)) {
          stale.push(`${rel}: ${name}@${version} is not an exact version pin`);
          continue;
        }
        if (cmp(version, min) < 0) stale.push(`${rel}: ${name}@${version} < ${min}`);
      }
    }

    expect(stale).toEqual([]);
  });

  // The three mechanisms that govern a dependency tree — the manifest `overrides`
  // block, a Dependabot entry, and the assertions above — were all hardcoded to
  // root/server/client, so `autofixer/` (a fourth npm install prefix with its own
  // tracked lockfile) sat outside every one of them and quietly resolved
  // path-to-regexp@8.4.0 / qs@6.15.2 while server/ enforced 8.4.2 / 6.15.3
  // (issue #5658). MANIFESTS is a hand-written list; this derives the roster from
  // the same `discoverWorkspaces()` the install-script allowlist uses, so a fifth
  // workspace added later fails here instead of silently inheriting no governance.
  it('governs every workspace manifest that ships its own lockfile', () => {
    const tracked = trackedLockfiles();
    const ungoverned = discoverWorkspaces()
      .map(workspacePrefix)
      .filter((prefix) => tracked.has(`${prefix}package-lock.json`))
      .map((prefix) => `${prefix}package.json`)
      .filter((manifest) => !MANIFESTS.includes(manifest));

    expect(ungoverned).toEqual([]);
  });

  // The source-level assertions above compare manifest against manifest and so
  // cannot see a pin that was declared but never applied: adding an `overrides`
  // entry without regenerating that workspace's lockfile leaves the vulnerable
  // version installed while the manifest reads as remediated. Reading the
  // lockfiles closes that gap in both directions — a workspace that resolves a
  // package another workspace has pinned must land on the pinned version, whether
  // it declares the pin itself or has simply never noticed it needs one.
  it('resolves every pinned package to its pinned version in all tracked lockfiles', () => {
    const pins = new Map();
    for (const rel of MANIFESTS) {
      for (const [name, version] of Object.entries(readOverrides(rel))) {
        // Nested overrides are scoped to one consumer's subtree — same exclusion
        // as the parity assertion above.
        if (typeof version !== 'string') continue;
        if (!pins.has(name)) pins.set(name, new Set());
        pins.get(name).add(version);
      }
    }

    const NESTED = 'node_modules/';
    const drift = [];
    for (const lockRel of [...trackedLockfiles()].sort()) {
      const packages = JSON.parse(readFileSync(join(REPO_ROOT, lockRel), 'utf8')).packages ?? {};
      for (const [path, meta] of Object.entries(packages)) {
        // '' is the workspace itself, workspace-link entries carry no
        // `node_modules/` segment, and `link: true` entries carry no version.
        if (!path?.includes(NESTED) || !meta?.version) continue;
        const name = path.slice(path.lastIndexOf(NESTED) + NESTED.length);
        const pinned = pins.get(name);
        // A package with disagreeing pins is already reported by the parity
        // assertion above; don't double-report it as drift here.
        if (!pinned || pinned.size > 1 || pinned.has(meta.version)) continue;
        drift.push(`${lockRel}: ${name}@${meta.version} != pinned ${[...pinned][0]}`);
      }
    }

    expect(drift).toEqual([]);
  });
});
