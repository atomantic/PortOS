import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const MANIFESTS = ['package.json', 'server/package.json', 'client/package.json'];

const readOverrides = (rel) => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));
  return pkg.overrides ?? {};
};

// PortOS pins security fixes for transitive dependencies as `overrides` in THREE
// independent manifests (root, server/, client/) — each with its own lockfile, so
// npm resolves each tree separately. The recurring failure (issue #2848) is that a
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
      'js-yaml': '4.3.0', // GHSA-52cp-r559-cp3m
      'tar': '7.5.21', // GHSA-vmf3-w455-68vh et al
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
});
