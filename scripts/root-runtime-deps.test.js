import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Regression guard for issue #3454: root `pm2` sat in `devDependencies` while
// the root `start` script launched the *production* process with it
// (`node ./node_modules/pm2/bin/pm2 start ecosystem.config.cjs`). An install run
// with `--omit=dev` or `NODE_ENV=production` would have left `npm start`,
// `npm run pm2:*` and `npm run dev:stop` with no binary to execute.
//
// Nothing in this repo installs that way today, so the bug was latent rather
// than live — which is exactly why it needs a guard: the next slimmed Docker
// image or production CI job is where it would surface, far from the commit
// that caused it.
//
// The rule is derived from the manifest rather than hardcoding "pm2": every
// package a root script reaches into via `./node_modules/<pkg>/...` is, by
// definition, needed whenever that script runs, so it must be a real
// `dependency`. Adding a new devDependency-backed root script binary trips this.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootManifest = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')
);

// Matches `./node_modules/pkg/...` and `./node_modules/@scope/pkg/...`
const NODE_MODULES_BIN = /\.\/node_modules\/((?:@[^/\s]+\/)?[^/\s]+)/g;

function packagesInvokedByRootScripts() {
  const found = new Set();
  for (const body of Object.values(rootManifest.scripts ?? {})) {
    for (const [, pkg] of body.matchAll(NODE_MODULES_BIN)) found.add(pkg);
  }
  return [...found].sort();
}

describe('root scripts run binaries from `dependencies`, not `devDependencies` (issue #3454)', () => {
  const packages = packagesInvokedByRootScripts();

  it('finds the root-script binaries to verify', () => {
    // Sanity: if the regex stops matching, the assertions below go vacuous.
    expect(packages.length).toBeGreaterThan(0);
  });

  // Compared as key lists rather than via `toHaveProperty`, which reads a dot
  // in the name as a path separator — `socket.io` would be checked as
  // `dependencies.socket.io` and silently never match.
  const dependencies = Object.keys(rootManifest.dependencies ?? {});
  const devDependencies = Object.keys(rootManifest.devDependencies ?? {});

  it.each(packages)(
    '%s is a root `dependency` so it survives a production install',
    (pkg) => {
      expect(dependencies).toContain(pkg);
      expect(devDependencies).not.toContain(pkg);
    }
  );
});
