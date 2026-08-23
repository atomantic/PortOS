/**
 * Marks a node_modules tree as having been through the trusted rebuild, and
 * checks that mark later.
 *
 * Why a mark and not an inspection: CI caches `server/node_modules` between
 * jobs, and a tree is only safe to reuse if it was saved *after*
 * `scripts/trusted-rebuilds.js` ran — `server/.npmrc` pins
 * `ignore-scripts=true`, so npm alone leaves the allowlisted packages
 * un-built. But "was this rebuilt?" is not answerable by looking at the tree.
 * With today's versions the rebuild is close to a no-op: node-pty and sharp
 * ship prebuilt bindings inside their tarballs (there is no `build/` directory
 * even in a fully rebuilt tree), onnxruntime-node bundles its CPU binaries and
 * only fetches the CUDA execution provider, and protobufjs only regenerates a
 * bundle nothing requires. So `require()`-ing the packages proves nothing — it
 * succeeds on a never-rebuilt tree, which is exactly the false confidence this
 * module replaced.
 *
 * That is a property of the current dependency versions, not a guarantee. A
 * release that drops a prebuild for the runner's platform, or an install under
 * `npm_config_build_from_source` (which makes node-pty's install script *delete*
 * the prebuilds), puts the rebuild back on the critical path. An extrinsic mark
 * keeps the check honest across that change instead of quietly going vacuous
 * with it.
 *
 * The mark records what would invalidate the tree even at an unchanged cache
 * key: the allowlist it was built against, and the platform/ABI it was built
 * for. Any mismatch reads as "not rebuilt" and the caller reinstalls.
 *
 *   node scripts/trusted-rebuild-stamp.js write server   # after a rebuild
 *   node scripts/trusted-rebuild-stamp.js check server   # after a cache restore
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { isDirectlyInvoked } from './lib/directInvocation.js';
import { TRUSTED_REBUILDS, discoverWorkspaces, workspaceDir } from './trusted-rebuilds.js';

export const STAMP_FILE = '.portos-trusted-rebuild.json';

const stampPath = (label) => join(workspaceDir(label), 'node_modules', STAMP_FILE);

/**
 * What the tree must match to count as rebuilt. The allowlist is hashed rather
 * than embedded so that regrouping or renaming a package invalidates the mark;
 * `modules` is NODE_MODULE_VERSION, which is what a compiled addon is actually
 * bound to.
 */
export function expectedStamp(label, { platform = process.platform, arch = process.arch, modules = process.versions.modules } = {}) {
  return {
    label,
    allowlist: createHash('sha256').update(JSON.stringify(TRUSTED_REBUILDS[label] ?? null)).digest('hex').slice(0, 16),
    platform,
    arch,
    modules: String(modules),
  };
}

/** Returns the mismatched field names — empty means the tree is usable. */
export function compareStamp(expected, found) {
  if (!found) return ['missing'];
  return Object.keys(expected).filter((key) => found[key] !== expected[key]);
}

/**
 * CLI body, returning an exit code instead of calling process.exit, so every
 * branch is assertable. Mirrors the shape of scripts/trusted-rebuilds.js.
 */
export function runCli(argv, { read = tryRead, write = writeFileSync, expected = expectedStamp } = {}) {
  const [action, label] = argv;
  const workspaces = discoverWorkspaces();
  if (!['write', 'check'].includes(action) || !workspaces.includes(label)) {
    console.error(`❌ usage: node scripts/trusted-rebuild-stamp.js <write|check> <${workspaces.join('|')}>`);
    return 1;
  }
  const stamp = expected(label);
  if (action === 'write') {
    write(stampPath(label), `${JSON.stringify(stamp, null, 2)}\n`);
    console.log(`🔖 ${label}: marked node_modules as trusted-rebuilt (${stamp.platform}-${stamp.arch}, abi ${stamp.modules})`);
    return 0;
  }
  const mismatched = compareStamp(stamp, read(stampPath(label)));
  if (mismatched.length) {
    console.error(`❌ ${label}: node_modules is not a trusted-rebuilt tree (${mismatched.join(', ')})`);
    console.error('   It was cached before the rebuild, or built for a different allowlist or ABI.');
    return 1;
  }
  console.log(`✅ ${label}: node_modules carries a matching trusted-rebuild mark`);
  return 0;
}

function tryRead(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    // A truncated restore is "not rebuilt", not a crash — the caller reinstalls.
    return null;
  }
}

if (isDirectlyInvoked(import.meta.url)) process.exit(runCli(process.argv.slice(2)));
