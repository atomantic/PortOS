// Catalog of hash-pinned Python runtime locks that Node installers may apply.
// An installer picks a profile, never a loose package list: the lock is the
// complete closure, installed with `--require-hashes --no-deps`, so nothing is
// resolved at install time. A host or package request no profile covers is an
// explicit unsupported/unresolved report BEFORE anything is installed.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');

const APPLE_SILICON = { platform: 'darwin', arch: 'arm64' };

// `environments` are Node platform/arch pairs the lock's markers cover; they
// mirror the `environments` in each lock header's regeneration command.
export const LOCK_PROFILES = Object.freeze({
  mflux: {
    id: 'mflux',
    label: 'shared mflux runtime',
    lockFile: join(SCRIPTS_DIR, 'requirements-mflux-mlx.lock.txt'),
    environments: [APPLE_SILICON],
  },
  'mflux-video': {
    id: 'mflux-video',
    label: 'mflux + mlx_video + mlx_vlm runtime',
    lockFile: join(SCRIPTS_DIR, 'requirements-mflux-video-mlx.lock.txt'),
    environments: [APPLE_SILICON],
  },
  'uv-bootstrap': {
    id: 'uv-bootstrap',
    label: 'private uv bootstrap',
    lockFile: join(SCRIPTS_DIR, 'requirements-uv-bootstrap.lock.txt'),
    environments: [
      APPLE_SILICON,
      { platform: 'darwin', arch: 'x64' },
      { platform: 'linux', arch: 'x64' },
      { platform: 'linux', arch: 'arm64' },
      { platform: 'win32', arch: 'x64' },
    ],
  },
  'guard-runtime': {
    id: 'guard-runtime',
    label: 'Prompt Guard / jev classifier runtime',
    lockFile: join(SCRIPTS_DIR, 'requirements-guard-runtime.lock.txt'),
    environments: [
      APPLE_SILICON,
      { platform: 'linux', arch: 'x64' },
      { platform: 'linux', arch: 'arm64' },
      { platform: 'win32', arch: 'x64' },
    ],
  },
});

// Order matters for repair dispatch: the smallest profile that owns every
// requested package wins, so a plain mflux repair never pulls the video superset.
const APPLE_SILICON_REPAIR_PROFILES = ['mflux', 'mflux-video'];

export const canonicalPackageName = (spec) =>
  String(spec).split(/[\s<>=!~;[]/)[0].toLowerCase().replace(/[-_.]+/g, '-');

// The pinned requirement plus its --hash lines, exactly as the lock spells them,
// so a caller can force-reinstall one distribution without re-resolving or
// touching the rest of the closure. Empty when the lock has no such entry.
export function lockEntryText(profile, name) {
  let keep = false;
  const lines = [];
  for (const line of readFileSync(profile.lockFile, 'utf8').split('\n')) {
    if (/^[^\s#]/.test(line)) keep = canonicalPackageName(line) === canonicalPackageName(name) && line.includes('==');
    if (keep) lines.push(line);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

const lockEntries = (profile) => readFileSync(profile.lockFile, 'utf8').split('\n')
  .map((line) => /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;\\]+)/.exec(line))
  .filter(Boolean)
  .map(([, name, version]) => [canonicalPackageName(name), version]);

const pinnedNameCache = new Map();
function lockPinnedNames(profile) {
  if (!pinnedNameCache.has(profile.id)) pinnedNameCache.set(profile.id, new Set(lockEntries(profile).map(([name]) => name)));
  return pinnedNameCache.get(profile.id);
}

// A precise reason when the lock does not cover this host, else null.
export function lockProfileUnsupportedReason(profile, { platform, arch }) {
  if (profile.environments.some((env) => env.platform === platform && env.arch === arch)) return null;
  const supported = profile.environments.map((env) => `${env.platform}/${env.arch}`).join(', ');
  return `The ${profile.label} has no hash-pinned lock for ${platform}/${arch} (locked: ${supported}).`;
}

// Generic package repair: dispatch to the smallest Apple Silicon lock owning
// every requested package, or report each package no lock covers. Never solves
// a fresh dependency graph. `specs` are pip names or specifiers.
export function planLockedRepair(specs, { appleSilicon }) {
  const names = [...new Set(specs.map(canonicalPackageName))];
  if (!appleSilicon) {
    return { unresolved: names.map((name) => ({ name, reason: 'no hash-pinned repair lock exists for this host' })) };
  }
  for (const id of APPLE_SILICON_REPAIR_PROFILES) {
    const owned = lockPinnedNames(LOCK_PROFILES[id]);
    if (names.every((name) => owned.has(name))) return { profile: LOCK_PROFILES[id] };
  }
  const widest = lockPinnedNames(LOCK_PROFILES[APPLE_SILICON_REPAIR_PROFILES.at(-1)]);
  return { unresolved: names.filter((name) => !widest.has(name)).map((name) => ({ name, reason: 'not in any hash-pinned runtime lock' })) };
}
