// Exercises scripts/db.sh ensure_pgvector_for_pg17 through `setup-native` using
// stubbed macOS Homebrew/git/make executables and a temporary build root.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '../../../../scripts');
const PINNED_0_8_7 = 'f37c13f68b57d2c3472b2214fbcff699d6d34876';

function executable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

describe.skipIf(process.platform === 'win32')('scripts/db.sh pgvector commit SHA verification', () => {
  let root;
  let tmpRoot;
  let pkglibdir;
  let stubLog;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'portos-db-pgvector-'));
    tmpRoot = join(root, 'tmp');
    const binDir = join(root, 'bin');
    const pg17Bin = join(root, 'brew-pg17', 'bin');
    pkglibdir = join(root, 'brew-pg17', 'lib');
    stubLog = join(root, 'stub.log');

    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(pg17Bin, { recursive: true });
    mkdirSync(pkglibdir, { recursive: true });

    copyFileSync(join(here, 'db.sh'), join(root, 'scripts', 'db.sh'));
    copyFileSync(join(here, 'lib', 'envFile.cjs'), join(root, 'scripts', 'lib', 'envFile.cjs'));
    copyFileSync(join(here, 'lib', 'databaseSettings.cjs'), join(root, 'scripts', 'lib', 'databaseSettings.cjs'));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, '.env'), 'PGMODE=native\n');
    writeFileSync(stubLog, '');

    symlinkSync(process.execPath, join(binDir, 'node'));
    executable(join(binDir, 'uname'), '#!/bin/sh\necho Darwin\n');
    executable(join(binDir, 'pg_isready'), '#!/bin/sh\nexit 0\n');
    executable(join(binDir, 'psql'), `#!/bin/sh
input="$(cat)"
case "$*" in
  *"SHOW server_version_num"*) echo 170006 ;;
esac
case "$input" in
  *pg_roles*|*pg_database*) echo 1 ;;
esac
exit 0
`);

    executable(join(pg17Bin, 'pg_config'), `#!/bin/sh
case "$1" in
  --pkglibdir) echo "${pkglibdir}" ;;
  --version) echo "PostgreSQL 17.6" ;;
  *) exit 1 ;;
esac
`);

    executable(join(binDir, 'brew'), `#!/bin/sh
echo "brew $*" >> "$STUB_LOG"
case "$1 $2 $3" in
  "--prefix postgresql@17 ") echo "${join(root, 'brew-pg17')}" ;;
  "list postgresql@17 ") exit 0 ;;
  "list pgvector ") exit 0 ;;
  "list --versions pgvector") printf '%s\\n' "\${STUB_PGVECTOR_VERSIONS-pgvector 0.8.7_1}" ;;
  "services list ") exit 0 ;;
  *) exit 0 ;;
esac
`);

    executable(join(binDir, 'git'), `#!/bin/bash
set -eu
echo "git $*" >> "$STUB_LOG"
repo_dir=""
if [ "\${1:-}" = "-C" ]; then
  repo_dir="$2"
  shift 2
fi
cmd="$1"
shift
case "$cmd" in
  init)
    target="\${!#}"
    mkdir -p "$target/.git"
    ;;
  remote)
    exit 0
    ;;
  fetch)
    [ "\${STUB_GIT_FETCH_RC:-0}" = "0" ] || exit "$STUB_GIT_FETCH_RC"
    target_sha="\${!#}"
    printf '%s\\n' "$target_sha" > "$repo_dir/.git/FETCH_HEAD"
    echo "all:" > "$repo_dir/Makefile"
    ;;
  checkout)
    cp "$repo_dir/.git/FETCH_HEAD" "$repo_dir/.git/HEAD"
    ;;
  rev-parse)
    if [ -n "\${STUB_ACTUAL_SHA:-}" ]; then
      printf '%s\\n' "$STUB_ACTUAL_SHA"
    else
      cat "$repo_dir/.git/HEAD"
    fi
    ;;
  *)
    echo "unexpected git command: $cmd" >&2
    exit 99
    ;;
esac
`);

    executable(join(binDir, 'make'), `#!/bin/bash
set -eu
echo "make $*" >> "$STUB_LOG"
src_dir=""
install_mode=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -C) src_dir="$2"; shift 2 ;;
    install) install_mode=1; shift ;;
    *) shift ;;
  esac
done
[ -f "$src_dir/Makefile" ] || exit 2
if [ "$install_mode" -eq 1 ]; then
  touch "${pkglibdir}/vector.dylib"
fi
`);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const runSetupNative = (overrides = {}) => spawnSync('bash', [join(root, 'scripts', 'db.sh'), 'setup-native'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
      HOME: root,
      TMPDIR: tmpRoot,
      PGMODE: 'native',
      PGHOST: 'localhost',
      PGPORT: '5432',
      PGPASSWORD: 'test-only',
      PORTOS_BREW_PG_PREFIXES: join(root, 'no-brew-prefix'),
      STUB_LOG: stubLog,
      ...overrides,
    },
  });

  it('fetches, verifies, and compiles the pinned commit SHA for a supported pgvector release', () => {
    const result = runSetupNative();

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('pgvector 0.8.7 built and installed for PostgreSQL 17');
    expect(existsSync(join(pkglibdir, 'vector.dylib'))).toBe(true);

    const log = readFileSync(stubLog, 'utf8');
    expect(log).not.toMatch(/^git clone\b/m);
    expect(log).not.toContain('v0.8.7');
    expect(log).toContain(`fetch --quiet --depth 1 origin ${PINNED_0_8_7}`);

    const lines = log.trim().split('\n');
    const revParseIdx = lines.findIndex((line) => /^git -C .* rev-parse HEAD$/.test(line));
    const makeIdx = lines.findIndex((line) => line.startsWith('make '));
    expect(revParseIdx).toBeGreaterThan(-1);
    expect(makeIdx).toBeGreaterThan(revParseIdx);
    expect(lines.filter((line) => line.startsWith('make '))).toHaveLength(2);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('skips fetching and building when the PostgreSQL 17 vector library is already present', () => {
    writeFileSync(join(pkglibdir, 'vector.dylib'), '');

    const result = runSetupNative();

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('pgvector library present for PostgreSQL 17');
    const log = readFileSync(stubLog, 'utf8');
    expect(log).not.toMatch(/^(git|make) /m);
  });

  it.each([
    ['unpinned version', { STUB_PGVECTOR_VERSIONS: 'pgvector 0.99.0_1' }, '0.99.0'],
    ['missing version token', { STUB_PGVECTOR_VERSIONS: 'pgvector' }, 'Cannot determine the installed Homebrew pgvector version'],
    ['empty brew version output', { STUB_PGVECTOR_VERSIONS: '' }, 'Cannot determine the installed Homebrew pgvector version'],
  ])('fails closed before fetching or running make on %s', (_, overrides, expectedMessage) => {
    const result = runSetupNative(overrides);

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(expectedMessage);
    expect(existsSync(join(pkglibdir, 'vector.dylib'))).toBe(false);
    const log = readFileSync(stubLog, 'utf8');
    expect(log).not.toMatch(/^(git|make) /m);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('fails closed and cleans up build_dir without running make when HEAD does not match the pinned SHA', () => {
    const mismatchedSha = 'deadbeef'.repeat(5);
    const result = runSetupNative({ STUB_ACTUAL_SHA: mismatchedSha });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('commit verification failed');
    expect(result.stdout + result.stderr).toContain(PINNED_0_8_7);
    expect(result.stdout + result.stderr).toContain(mismatchedSha);
    expect(existsSync(join(pkglibdir, 'vector.dylib'))).toBe(false);
    const log = readFileSync(stubLog, 'utf8');
    expect(log).toMatch(/^git -C .* rev-parse HEAD$/m);
    expect(log).not.toMatch(/^make /m);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('fails closed and cleans up build_dir without running make when git fetch fails', () => {
    const result = runSetupNative({ STUB_GIT_FETCH_RC: '1' });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(`Could not fetch pinned pgvector 0.8.7 commit ${PINNED_0_8_7}`);
    expect(existsSync(join(pkglibdir, 'vector.dylib'))).toBe(false);
    const log = readFileSync(stubLog, 'utf8');
    expect(log).not.toMatch(/^make /m);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('maps only valid semver releases to 40-char lowercase hex commit SHAs', () => {
    const dbScript = readFileSync(join(here, 'db.sh'), 'utf8');
    const block = dbScript.match(/pinned_pgvector_commit\(\)\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(block).toBeTruthy();

    const entries = [...block.matchAll(/^\s*([^)\s*]+)\)\s*echo\s+"([^"]+)"\s*;;$/gm)]
      .map(([, version, sha]) => ({ version, sha }));
    expect(entries.length).toBeGreaterThan(0);

    const seenVersions = new Set();
    for (const { version, sha } of entries) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(seenVersions.has(version)).toBe(false);
      seenVersions.add(version);
    }
    expect(entries).toContainEqual({ version: '0.8.7', sha: PINNED_0_8_7 });
  });
});
