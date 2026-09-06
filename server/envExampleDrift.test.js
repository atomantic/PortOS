/**
 * Repo-wide guard: `.env.example` and the variables the server actually reads
 * must not drift apart (#5706).
 *
 * ## Why this exists
 *
 * `.env.example` is the only discovery surface a fresh install has for "what can
 * I configure". Every one of these variables is read lazily at first use with a
 * silent fallback, so an undocumented one is invisible: the feature just quietly
 * uses its default and nothing ever says otherwise. That made the file rot in
 * both directions before this guard existed —
 *
 *   - FORWARD drift: `signalSync.js` reads `SIGNAL_DIR`, `SIGNAL_CONFIG_PATH` and
 *     `SIGNAL_DB_PATH` in one three-line block, and only the middle one was
 *     documented — so a user relocating a Signal install configured half of it.
 *   - REVERSE drift: `.env.example` still advertised `PORTOS_UI_MAX_MEMORY` long
 *     after #5322 made the Vite ceiling a fixed constant. Setting it did nothing.
 *
 * Both directions are checked below.
 *
 * ## The rule
 *
 * 1. Every `process.env.NAME` read in tracked, non-test server runtime source
 *    appears as a `NAME=` line in `.env.example` — commented out is fine, that is
 *    how the whole file documents an optional override.
 * 2. Every `NAME=` documented in `.env.example` is mentioned somewhere in the
 *    tracked code PortOS actually runs — any language, anywhere in the repo.
 *
 * ## Allowlist
 *
 * `INHERITED_ENV` below is the one escape hatch, and it is a *category* list with
 * a reason per entry rather than a snapshot of today's diff — so it keeps meaning
 * something as the tree grows. An entry belongs there only if a user would never
 * put it in `.env`: the OS provides it, a toolchain (npm, PM2, Hugging Face, XDG)
 * injects it, or it exists purely for the test harness. A new *product* setting
 * is not an allowlist entry; document it in `.env.example` instead.
 *
 * ## What this guard CANNOT see
 *
 *   - `process.env['NAME']` / `process.env[dynamicKey]` — only the dotted form is
 *     matched. Write `process.env.NAME` and this guard covers you.
 *   - A destructured read (`const { FOO } = process.env`, or a helper taking an
 *     `env` object, as `interactiveShellResolver.js` does with `PORTOS_SHELL`).
 *     Forward drift on those shapes goes unnoticed; the reverse check still
 *     covers them because it matches the bare name anywhere in the source.
 *   - Anything outside the server RUNTIME tree in the forward direction. Both
 *     `scripts/` and `server/scripts/` are standalone CLIs — CI plumbing
 *     (`CI_SHARD`, `GITHUB_SHA`, …) and one-off dev explorers (`MAZE_SEED`, …)
 *     that document their own env in their file headers and would be noise in a
 *     user-facing example file. They stay a reverse-only surface.
 *   - A reference to a name in prose. The reverse direction matches bare names,
 *     so a variable nothing reads any more still counts as alive while a code
 *     COMMENT mentions it. `.md` files are excluded from that surface for the
 *     same reason, but an in-code comment cannot be told from a real read here.
 *
 * String and comment CONTENT is blanked before the forward scan (`blankLiterals`
 * from `lib/sourceScan.js`), so a `process.env.X` written inside a code sample
 * PortOS *generates* for someone else — `routes/apps/viteTls.js` emits exactly
 * that for a user's vite config — is correctly not treated as a PortOS setting.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { blankLiterals } from './lib/sourceScan.js';

const SERVER_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SERVER_ROOT);
const ENV_EXAMPLE = join(REPO_ROOT, '.env.example');

/**
 * Names a user never sets in `.env`, with the reason each is exempt. Grouped by
 * category on purpose — see the Allowlist note in the header before adding one.
 */
const INHERITED_ENV = {
  // Provided by the operating system / shell.
  HOME: 'OS-provided home directory',
  PATH: 'OS-provided executable search path',
  PWD: 'OS-provided working directory',
  USER: 'OS-provided account name',
  TZ: 'OS/pm2-provided timezone (ecosystem.config.cjs pins it to UTC)',
  LOCALAPPDATA: 'Windows-provided per-user app data root',
  ProgramFiles: 'Windows-provided install root',
  SystemDrive: 'Windows-provided system drive letter',
  DYLD_LIBRARY_PATH: 'macOS dynamic-loader path, passed through to child processes',
  LD_LIBRARY_PATH: 'Linux dynamic-loader path, passed through to child processes',
  XDG_CACHE_HOME: 'XDG base-directory spec, set by the desktop environment',

  // Injected by a toolchain PortOS runs under.
  NODE_ENV: 'set by the launcher (pm2) and forced to "test" by vitest.config.js',
  npm_config_cache: 'injected by npm when it runs a script',
  npm_lifecycle_event: 'injected by npm when it runs a script',
  PM2_HOME: 'injected by pm2',
  PM2_ID: 'injected by pm2',
  pm_exec_path: 'injected by pm2',
  pm_id: 'injected by pm2',
  BUN_INSTALL: 'set by the Bun installer; PortOS only reads it to find the binary',
  HF_HOME: 'Hugging Face toolchain convention, shared with the Python side',
  HF_HUB_CACHE: 'Hugging Face toolchain convention, shared with the Python side',

  // Test-harness only — setting any of these on a real install is meaningless.
  VITEST: 'set by the vitest runner',
  VITEST_FAST: 'opt-in fast-suite selector, CI/local test runs only',
  CI_EXPECT_SLASHDO_SUBMODULE: 'CI flag that turns a skipped slashdo adapter contract into a failure',
  TEST_DB_OK: 'test-harness flag for the DB-backed suites',
  PGTESTDATABASE: 'test-harness override naming portos_test',
  PORTOS_REQUIRE_DB: 'CI flag that turns a skipped DB suite into a failure',
  PORTOS_TEST_PYTHON: 'test-harness interpreter override',
  PORTOS_TEST_QUIET: 'test-harness log silencer',
};

/**
 * `git ls-files --stage`, minus gitlinks. `--stage` so the mode is visible:
 * `lib/slashdo` is a submodule, and git lists that gitlink as one path that is a
 * DIRECTORY on disk (mode 160000), which would blow the reader up. Its contents
 * are not tracked in this repo anyway.
 */
const trackedFiles = (...args) => execFileSync('git', ['ls-files', '--stage', ...args], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
}).split('\n').filter(Boolean).flatMap((line) => {
  const [meta, path] = line.split('\t');
  return meta.startsWith('160000 ') ? [] : [path];
});

/** Tracked, non-test server RUNTIME modules — the forward-scan surface. */
const serverRuntimeSources = () => trackedFiles('server').filter((f) => (
  /\.(?:js|mjs|cjs)$/.test(f) && !f.includes('.test.') && !f.startsWith('server/scripts/')
));

// Everything a variable can reach the running system through. Deliberately wide
// — a false "this is dead" would block CI over a real setting — but `.md` and
// other prose is left out so a doc mention alone cannot keep a dead key alive.
const CODE_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|sh|ps1|bat|cmd|py|rb|swift|yml|yaml|json|toml|sql|html|npmrc)$/;

/**
 * Tracked code PortOS actually runs — the reverse-scan surface. Extensionless
 * files are kept (an executable shim like `server/lib/agentGuard/bin/pm2` is
 * exactly the kind of place a variable is consumed). Two things are not: tests,
 * which exercise the code rather than being it — this very file names
 * `PORTOS_UI_MAX_MEMORY` in its header and would otherwise vouch for the dead
 * key it was written to catch — and `.env.example`, which would document itself.
 */
const runtimeCodeSources = () => trackedFiles().filter((f) => (
  f !== '.env.example' && !f.includes('.test.') && (CODE_EXT.test(f) || !f.includes('.'))
));

const ENV_READ = /process\.env\.([A-Za-z_$][A-Za-z0-9_$]*)/g;

/**
 * Every `process.env.NAME` read in one file's source, literals blanked first.
 * Most of the tree never touches `process.env`, and blanking is the expensive
 * step, so skip it entirely for a file with nothing to find — this guard is on
 * the always-run CI list and pays that cost on every PR.
 */
export function envReadsIn(src) {
  if (!src.includes('process.env.')) return [];
  return [...blankLiterals(src).matchAll(ENV_READ)].map((m) => m[1]);
}

// A key line is `NAME=`, optionally commented and optionally behind a platform
// label — `# Windows: PORTOS_SHELL=…` documents PORTOS_SHELL just as well.
const ENV_KEY_LINE = /^[ \t]*(?:#[ \t]*)?(?:[A-Za-z][A-Za-z0-9 ]*:[ \t]*)?([A-Za-z_][A-Za-z0-9_]*)=/gm;

/** Every variable `.env.example` documents, commented or not. */
export function documentedKeys(text) {
  return [...text.matchAll(ENV_KEY_LINE)].map((m) => m[1]);
}

describe('.env.example stays in sync with the environment the server reads (#5706)', () => {
  it('scans a real tree', () => {
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise let
    // both directions below pass by comparing two empty sets.
    expect(serverRuntimeSources().length).toBeGreaterThan(500);
    expect(runtimeCodeSources().length).toBeGreaterThan(500);
    expect(documentedKeys(readFileSync(ENV_EXAMPLE, 'utf8')).length).toBeGreaterThan(50);
  });

  it('extracts reads and documented keys from the shapes that matter', () => {
    expect(envReadsIn('const a = process.env.FOO || 1;')).toEqual(['FOO']);
    // Bracket access is a known blind spot — pinned so the limitation in the
    // header stays true rather than quietly becoming wrong.
    expect(envReadsIn("const a = process.env['FOO'];")).toEqual([]);
    // A sample PortOS generates for someone ELSE's config is not a PortOS setting.
    expect(envReadsIn('const line = `const D = process.env.FOO;`;')).toEqual([]);
    expect(envReadsIn('// legacy: process.env.FOO\nconst a = process.env.BAR;')).toEqual(['BAR']);

    expect(documentedKeys('# FOO=bar\n')).toEqual(['FOO']);
    expect(documentedKeys('FOO=bar\n')).toEqual(['FOO']);
    expect(documentedKeys('# Windows: FOO=C:\\bar\n')).toEqual(['FOO']);
    expect(documentedKeys('# Prose about FOO=bar in a sentence\n')).toEqual([]);
  });

  it('documents every environment variable the server reads', () => {
    const documented = new Set(documentedKeys(readFileSync(ENV_EXAMPLE, 'utf8')));
    const undocumented = new Map();

    for (const file of serverRuntimeSources()) {
      for (const name of envReadsIn(readFileSync(join(REPO_ROOT, file), 'utf8'))) {
        // hasOwn, not `in`: `process.env.constructor` would otherwise hit
        // Object.prototype and silently skip enforcement.
        if (documented.has(name) || Object.hasOwn(INHERITED_ENV, name)) continue;
        if (!undocumented.has(name)) undocumented.set(name, file);
      }
    }

    // Sorted `NAME (first read here)` lines so a failure says what to add and where.
    expect([...undocumented].sort().map(([n, f]) => `${n} (${f})`)).toEqual([]);
  });

  it('documents nothing the code has stopped reading', () => {
    // Bare-name match, not `process.env.NAME`: a variable can legitimately reach
    // the code destructured, through an `env` object, or via a shell script, and
    // this direction only needs to know that SOMETHING still knows the name.
    // One alternation over the documented names per file — `\b` makes the longer
    // name win, so PORTOS_HOST never counts as a sighting of PORT — and the scan
    // stops as soon as every name has been accounted for.
    const dead = new Set(documentedKeys(readFileSync(ENV_EXAMPLE, 'utf8')));
    const anyName = new RegExp(`\\b(?:${[...dead].join('|')})\\b`, 'g');

    for (const file of runtimeCodeSources()) {
      if (dead.size === 0) break;
      const src = readFileSync(join(REPO_ROOT, file), 'utf8');
      for (const [name] of src.matchAll(anyName)) dead.delete(name);
    }

    expect([...dead].sort()).toEqual([]);
  });
});
