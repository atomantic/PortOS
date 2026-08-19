/**
 * Regression guard for #4554 — a server-suite run mutated the developer's real
 * `.git/config` (`core.bare = true`, `user.email = test@test`), because a git
 * fixture reached `spawn` with an unusable cwd and `spawn` quietly substitutes
 * `process.cwd()`.
 *
 * Each guard case is paired with a BYPASS PROBE: the same helper, same on-disk
 * directory, run once where the guard permits it. The probe proves the guarded
 * operation is genuinely destructive (it really does `git init` / really does
 * `rm -rf`), so a passing guard case means "the guard stopped it", not "this
 * call never did anything anyway".
 *
 * The "non-temp" directory is physically created under `os.tmpdir()` and only
 * LOOKS non-temp because TMPDIR is stubbed elsewhere for the duration — the
 * suite never writes outside the OS temp dir, and never near a real checkout.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir, symlink } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { isTempPath, assertTempPath } from './tempPathGuard.js';
import { execGit } from './execGit.js';
import {
  materializeGitRepo,
  destroyGitSandbox,
  attachBareOrigin,
  SKIP_HEAVY_INTEGRATION,
} from './gitTestRepo.js';

const scratches = [];

async function scratchDir(prefix = 'portos-tempguard-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratches.push(dir);
  return dir;
}

/**
 * Make `os.tmpdir()` report a DIFFERENT directory, so a path that is really in
 * the OS temp dir reads as non-temp to the guard. `os.tmpdir()` consults these
 * env vars on every call (TMPDIR on POSIX, TEMP/TMP on Windows).
 */
function pretendTmpdirIs(dir) {
  vi.stubEnv('TMPDIR', dir);
  vi.stubEnv('TMP', dir);
  vi.stubEnv('TEMP', dir);
}

afterEach(async () => {
  vi.unstubAllEnvs();
  while (scratches.length) {
    await rm(scratches.pop(), { recursive: true, force: true }).catch(() => {});
  }
});

describe('isTempPath', () => {
  it('accepts a directory created under os.tmpdir()', async () => {
    expect(isTempPath(await scratchDir())).toBe(true);
  });

  it('accepts a not-yet-created child of a temp directory', async () => {
    expect(isTempPath(join(await scratchDir(), 'primary'))).toBe(true);
  });

  it('rejects the shapes that would resolve against process.cwd()', () => {
    // `spawn({ cwd: undefined })` and a relative cwd are the exact inputs that
    // silently became "the real checkout" in #4554.
    expect(isTempPath(undefined)).toBe(false);
    expect(isTempPath(null)).toBe(false);
    expect(isTempPath('')).toBe(false);
    expect(isTempPath('relative/repo')).toBe(false);
    expect(isTempPath('.')).toBe(false);
    expect(isTempPath(42)).toBe(false);
  });

  it('rejects an absolute path outside the temp dir', async () => {
    const outside = await scratchDir();
    pretendTmpdirIs(await scratchDir());
    expect(isTempPath(outside)).toBe(false);
  });

  it('rejects the temp dir ITSELF — an rm -rf there would wipe every process\u2019s scratch', async () => {
    const root = await scratchDir();
    pretendTmpdirIs(root);
    // Bypass probe: a child of the same root is accepted, so the rejection
    // below is the strict-descendant rule and not a broken root comparison.
    expect(isTempPath(join(root, 'child'))).toBe(true);
    expect(isTempPath(root)).toBe(false);
    expect(isTempPath(tmpdir())).toBe(false);
  });

  it('judges a symlink by where it POINTS, not where it sits', async () => {
    const outside = await scratchDir();
    const root = await scratchDir();
    const escape = join(root, 'escape');
    await symlink(outside, escape, 'dir');
    pretendTmpdirIs(root);

    // Bypass probe: a real directory in exactly the same place is accepted, so
    // the rejections below are the symlink target being followed.
    expect(isTempPath(join(root, 'escape-but-real'))).toBe(true);
    expect(isTempPath(escape)).toBe(false);
    expect(isTempPath(join(escape, 'repo'))).toBe(false);
  });

  it('rejects a path that climbs out with ..', async () => {
    const root = await scratchDir();
    pretendTmpdirIs(root);
    // Built by hand: path.join would collapse the '..' before the guard sees it,
    // and a lexical collapse is exactly the wrong answer through a symlink.
    expect(isTempPath(`${root}${sep}sub${sep}..${sep}sub`)).toBe(false);
    expect(isTempPath(join(root, 'sub'))).toBe(true); // bypass probe
  });
});

describe('assertTempPath', () => {
  it('returns the path so it can wrap an argument inline', async () => {
    const dir = await scratchDir();
    expect(assertTempPath(dir, 'probe')).toBe(dir);
  });

  it('names the operation it refused', () => {
    expect(() => assertTempPath(undefined, 'git init')).toThrow(/refusing to run git init/);
  });
});

describe('execGit refuses to guess a working directory', () => {
  // BYPASS PROBE: with a real cwd the same call succeeds, so the rejections
  // below are the guard firing — not `git rev-parse` being broken.
  it('runs when handed a real directory (probe)', async () => {
    const dir = await scratchDir();
    await execGit(['init', '-q'], dir);
    const { stdout } = await execGit(['rev-parse', '--is-inside-work-tree'], dir);
    expect(stdout.trim()).toBe('true');
  });

  it.each([undefined, null, '', '   '])('rejects cwd %p instead of using process.cwd()', async (cwd) => {
    await expect(execGit(['init', '-q'], cwd)).rejects.toThrow(/requires a working directory/);
  });
});

describe.skipIf(SKIP_HEAVY_INTEGRATION)('gitTestRepo refuses non-temp targets', () => {
  it('materializeGitRepo git-inits a temp dir but leaves a non-temp dir untouched', async () => {
    // BYPASS PROBE — guard permits: the helper really does create a repo.
    const allowed = await scratchDir();
    await materializeGitRepo(allowed);
    expect(existsSync(join(allowed, '.git'))).toBe(true);

    // Guard case — same helper, a directory the guard sees as non-temp.
    const victim = await scratchDir();
    await writeFile(join(victim, 'keep.txt'), 'untouched');
    pretendTmpdirIs(await scratchDir());

    await expect(materializeGitRepo(victim)).rejects.toThrow(/refusing to run/);
    expect(existsSync(join(victim, '.git'))).toBe(false);
    expect(await readdir(victim)).toEqual(['keep.txt']);
    expect(await readFile(join(victim, 'keep.txt'), 'utf8')).toBe('untouched');
  });

  it('attachBareOrigin refuses before touching the repo it was pointed at', async () => {
    const victim = await scratchDir();
    await materializeGitRepo(victim);
    const before = await execGit(['remote'], victim);
    expect(before.stdout.trim()).toBe('');

    pretendTmpdirIs(await scratchDir());
    await expect(attachBareOrigin(victim, victim)).rejects.toThrow(/refusing to run/);

    vi.unstubAllEnvs();
    const after = await execGit(['remote'], victim);
    expect(after.stdout.trim()).toBe('');
    expect(existsSync(join(victim, 'origin.git'))).toBe(false);
  });
});

describe('destroyGitSandbox refuses to rm -rf a non-temp directory', () => {
  it('deletes a temp dir but refuses the same dir once it reads as non-temp', async () => {
    // BYPASS PROBE — guard permits: this helper really is `rm -rf`.
    const doomed = await scratchDir();
    await writeFile(join(doomed, 'file.txt'), 'x');
    await destroyGitSandbox(doomed);
    expect(existsSync(doomed)).toBe(false);

    // Guard case.
    const victim = await scratchDir();
    await writeFile(join(victim, 'file.txt'), 'x');
    pretendTmpdirIs(await scratchDir());

    await expect(destroyGitSandbox(victim)).rejects.toThrow(/refusing to run/);
    expect(existsSync(join(victim, 'file.txt'))).toBe(true);
  });
});
