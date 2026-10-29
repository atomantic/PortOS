/**
 * Contract for the runtime write backstop (#6176).
 *
 * The sibling `testDataIsolation.guards.test.js` is the static half — it scans
 * test SOURCE for a forbidden path spelling. This file exercises the runtime
 * half: the primitive actually refuses the write, and only the writes it should.
 *
 * The assertions deliberately go through the real `atomicWrite`/`ensureDir`/
 * `appendJSONLine` rather than calling `assertNotRealDataWrite` alone, because
 * "the helper throws" is not the product behavior — "the write primitive every
 * store funnels through throws, before it produces bytes" is. And they assert
 * the thrown MESSAGE, not merely that something threw: a guard whose error
 * doesn't name the offending path and the escape hatch sends the next reader
 * hunting, which is most of the cost of hitting it.
 */

import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, relative, sep } from 'path';
import { appendFileGuarded, atomicWrite, copyFileGuarded, createWriteStreamGuarded, ensureDir, renameGuarded, rmGuarded, unlinkGuarded, writeFileGuarded } from './fileCore.js';
import { appendJSONLine } from './jsonIo.js';
import { createCollectionStore } from './collectionStore.js';
import { assertNotNewRealDataDir, assertNotRealDataWrite, isInsideRealDataRoot, _resolveGuardRoots } from './testDataIsolation.js';
import { resolveCodeRootForModule } from './dataRoot.js';
import { canonicalizePath, isPathAtOrInsideDir } from './pathContainment.js';
import { isTestRunner } from './runtimeEnv.js';
import { PATHS } from './paths.js';

// The real tree this guard defends, derived the way the guard derives it. Inside
// a CoS worktree that is the primary install's data/, not PATHS.data (which is
// the worktree's own exempt scratch tree), so PATHS is deliberately not used.
const REAL_DATA = _resolveGuardRoots(resolveCodeRootForModule(import.meta.url)).root;
const tempRoot = mkdtempSync(join(tmpdir(), 'portos-test-isolation-'));

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

afterEach(() => vi.unstubAllEnvs());

describe('isTestRunner', () => {
  it('is armed by VITEST even when NODE_ENV was dropped by a wrapper', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(process.env.VITEST).toBeDefined();
    expect(isTestRunner()).toBe(true);
  });

  it('is disarmed when neither signal is present', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', undefined);
    expect(isTestRunner()).toBe(false);
  });
});

describe('isInsideRealDataRoot', () => {
  it('accepts the real data root itself and anything beneath it', () => {
    expect(isInsideRealDataRoot(REAL_DATA)).toBe(true);
    expect(isInsideRealDataRoot(join(REAL_DATA, 'brain', 'entries.json'))).toBe(true);
  });

  it('rejects a temp data root — the sanctioned escape hatch', () => {
    expect(isInsideRealDataRoot(join(tempRoot, 'brain', 'entries.json'))).toBe(false);
  });

  it('rejects a sibling that merely shares the prefix', () => {
    // `startsWith(root)` would match this; `relative()` yields `../data-archive`.
    expect(isInsideRealDataRoot(`${REAL_DATA}-archive/x.json`)).toBe(false);
  });

  it('catches a `..` climb back into the real tree', () => {
    // Concatenated, NOT join()'d: `path.join` normalizes its arguments, so a
    // join()-built path arrives already collapsed and the case would pass even
    // if the function dropped its own `resolve()`.
    expect(isInsideRealDataRoot(`${REAL_DATA}/brain/../../data/sneaky.json`)).toBe(true);
  });

  it('catches a relative path that resolves into the real tree', () => {
    const rel = relative(process.cwd(), join(REAL_DATA, 'relative.json'));
    expect(isAbsolute(rel)).toBe(false);
    expect(isInsideRealDataRoot(rel)).toBe(true);
  });

  it('follows a symlinked destination — the write lands where the link points', () => {
    // writeFile/appendFile/copyFile follow a symlinked final component, so a
    // fixture link inside a temp root can reach live data even though the link
    // itself sits outside. atomicWrite replaces the link instead, which is why
    // BOTH landing sites are checked.
    const link = join(tempRoot, 'looks-safe.json');
    symlinkSync(join(REAL_DATA, 'provider-quotas.json'), link);
    expect(isInsideRealDataRoot(link)).toBe(true);
    rmSync(link, { force: true });
  });

  it('catches a target whose PARENT directory is a symlink into the real tree', () => {
    // The final component does not exist and is not a link, so only the
    // ancestor walk can see where the write would land.
    const linkedParent = join(tempRoot, 'linked-parent');
    symlinkSync(REAL_DATA, linkedParent);
    try {
      expect(isInsideRealDataRoot(join(linkedParent, 'new-file.json'))).toBe(true);
    } finally {
      rmSync(linkedParent, { force: true });
    }
  });

  it('is not fooled by a non-string or empty target', () => {
    expect(isInsideRealDataRoot(undefined)).toBe(false);
    expect(isInsideRealDataRoot('')).toBe(false);
  });
});

describe('isPathAtOrInsideDir (the containment primitive behind it)', () => {
  it('treats a filesystem root as containing its children', () => {
    // `root + sep` is '//' for '/', so a naive anchor matched nothing at all —
    // harmless for today's `<install>/data` root, wrong for the next caller.
    expect(isPathAtOrInsideDir(sep, join(sep, 'etc'))).toBe(true);
    expect(isPathAtOrInsideDir(sep, sep)).toBe(true);
  });

  it('still rejects a sibling that merely shares the prefix', () => {
    expect(isPathAtOrInsideDir('/data/uploads', '/data/uploads-evil/x')).toBe(false);
  });
});

describe('assertNotRealDataWrite', () => {
  it('is inert outside the test runner, so production writes are unaffected', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', undefined);
    expect(() => assertNotRealDataWrite(join(REAL_DATA, 'x.json'), 'atomicWrite')).not.toThrow();
  });
});

describe('atomicWrite', () => {
  it('writes to a temp data root untouched', async () => {
    const target = join(tempRoot, 'nested', 'ok.json');
    await atomicWrite(target, { ok: true });
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ ok: true });
  });

  it('refuses a write into the real data tree, naming the path and the escape hatch', async () => {
    const target = join(REAL_DATA, 'portos-guard-probe.json');
    await expect(atomicWrite(target, { leaked: true })).rejects.toThrow(
      /atomicWrite refused[\s\S]*portos-guard-probe\.json[\s\S]*createTempDataRoot\(\)/,
    );
    // Refused BEFORE any bytes were produced — no target and no stranded temp file.
    expect(existsSync(target)).toBe(false);
  });
});

describe('ensureDir', () => {
  it('refuses to materialize a new directory in the real data tree', async () => {
    const target = join(REAL_DATA, 'portos-guard-probe-dir');
    await expect(ensureDir(target)).rejects.toThrow(/ensureDir refused[\s\S]*portos-guard-probe-dir/);
    expect(existsSync(target)).toBe(false);
  });

  it('exposes the create-only check as assertNotNewRealDataDir', () => {
    expect(() => assertNotNewRealDataDir(join(REAL_DATA, 'portos-guard-probe-dir'))).toThrow(/ensureDir refused/);
    expect(() => assertNotNewRealDataDir(PATHS.installRoot)).not.toThrow();
  });

  it('stays silent on a directory that already exists — mkdir -p mutates nothing there', async () => {
    // Read-only suites routinely ensureDir a real data subdirectory on their way
    // to reading it. That is a no-op on disk, so faulting it would be noise, not
    // a leak. `PATHS.data`'s own parent (the install root) is always present.
    await expect(ensureDir(PATHS.installRoot)).resolves.toBeUndefined();
  });
});

describe('the guarded raw-fs wrappers', () => {
  // These exist so a writer that genuinely cannot use atomicWrite (an append,
  // an exclusive `wx` create, a copy, a NAME_MAX-clamped name) still inherits
  // the guard instead of having to remember an import.
  it('writeFileGuarded refuses the real tree and allows a temp root', async () => {
    await expect(writeFileGuarded(join(REAL_DATA, 'probe.txt'), 'x')).rejects.toThrow(/writeFile refused/);
    const target = join(tempRoot, 'raw.txt');
    await writeFileGuarded(target, 'x');
    expect(readFileSync(target, 'utf8')).toBe('x');
  });

  it('appendFileGuarded refuses the real tree', async () => {
    await expect(appendFileGuarded(join(REAL_DATA, 'probe.log'), 'x')).rejects.toThrow(/appendFile refused/);
  });

  it('copyFileGuarded judges the DESTINATION, not the source', async () => {
    const src = join(tempRoot, 'src.txt');
    await writeFileGuarded(src, 'payload');
    // Source inside the real tree would be a read, which this guard does not police.
    await expect(copyFileGuarded(src, join(REAL_DATA, 'copied.txt'))).rejects.toThrow(/copyFile refused/);
    await copyFileGuarded(src, join(tempRoot, 'dest.txt'));
    expect(readFileSync(join(tempRoot, 'dest.txt'), 'utf8')).toBe('payload');
  });

  it('renameGuarded judges the DESTINATION and leaves the source in place', async () => {
    const src = join(tempRoot, 'rename-src.txt');
    await writeFileGuarded(src, 'payload');
    await expect(renameGuarded(src, join(REAL_DATA, 'renamed.txt'))).rejects.toThrow(/rename refused/);
    expect(readFileSync(src, 'utf8')).toBe('payload');
    const dest = join(tempRoot, 'rename-dest.txt');
    await renameGuarded(src, dest);
    expect(readFileSync(dest, 'utf8')).toBe('payload');
  });

  it('rmGuarded refuses the real tree and allows a temp root', async () => {
    await expect(rmGuarded(join(REAL_DATA, 'probe.txt'))).rejects.toThrow(/rm refused/);
    const target = join(tempRoot, 'to-rm.txt');
    await writeFileGuarded(target, 'x');
    await rmGuarded(target);
    expect(existsSync(target)).toBe(false);
  });

  it('unlinkGuarded refuses the real tree and allows a temp root', async () => {
    await expect(unlinkGuarded(join(REAL_DATA, 'probe.txt'))).rejects.toThrow(/unlink refused/);
    const target = join(tempRoot, 'to-unlink.txt');
    await writeFileGuarded(target, 'x');
    await unlinkGuarded(target);
    expect(existsSync(target)).toBe(false);
  });

  it('createWriteStreamGuarded refuses the real tree and allows a temp root', async () => {
    await expect(createWriteStreamGuarded(join(REAL_DATA, 'probe.txt'))).rejects.toThrow(/createWriteStream refused/);
    const target = join(tempRoot, 'streamed.txt');
    const ws = await createWriteStreamGuarded(target);
    await new Promise((res, rej) => {
      ws.write('streamed content', (err) => (err ? rej(err) : ws.end(res)));
    });
    expect(readFileSync(target, 'utf8')).toBe('streamed content');
  });
});

describe('appendJSONLine', () => {
  it('appends to a temp data root untouched', async () => {
    const target = join(tempRoot, 'log.jsonl');
    await appendJSONLine(target, { n: 1 });
    expect(readFileSync(target, 'utf8')).toBe('{"n":1}\n');
  });

  it('refuses an append into the real data tree', async () => {
    const target = join(REAL_DATA, 'portos-guard-probe.jsonl');
    // Names the PRIMITIVE (appendJSONLine delegates to appendFileGuarded), and
    // the offending path is what identifies the caller.
    await expect(appendJSONLine(target, { leaked: true })).rejects.toThrow(
      /appendFile refused[\s\S]*portos-guard-probe\.jsonl/,
    );
    expect(existsSync(target)).toBe(false);
  });
});

describe('collectionStore recursive delete', () => {
  it('refuses a record directory that resolves into the real data tree', async () => {
    const dir = join(tempRoot, 'guarded-collection');
    mkdirSync(dir, { recursive: true });
    const recordLink = join(dir, 'rec-1');
    symlinkSync(join(REAL_DATA, 'guard-probe-record'), recordLink);
    const store = createCollectionStore({ dir, type: 'guard-probe', schemaVersion: 1 });
    try {
      await expect(store.deleteOne('rec-1')).rejects.toThrow(/collectionStore delete refused/);
      expect(lstatSync(recordLink).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(recordLink, { force: true });
    }
  });
});

describe('_resolveGuardRoots (#14074)', () => {
  const primary = realpathSync(mkdtempSync(join(tmpdir(), 'portos-guard-roots-')));
  const worktree = join(primary, 'data', 'cos', 'worktrees', 'claim-example');
  mkdirSync(join(worktree, 'data'), { recursive: true });
  afterAll(() => rmSync(primary, { recursive: true, force: true }));

  it('protects the install data/ and exempts only the executing worktree checkout', () => {
    const { root, exempt } = _resolveGuardRoots(worktree);
    expect(isPathAtOrInsideDir(root, join(primary, 'data', 'brain', 'x.json'))).toBe(true);
    expect(isPathAtOrInsideDir(root, join(worktree, 'data', 'x.json'))).toBe(true);
    expect(isPathAtOrInsideDir(exempt, join(worktree, 'data', 'x.json'))).toBe(true);
    // a sibling checkout is real data from this worktree's point of view
    expect(isPathAtOrInsideDir(exempt, join(primary, 'data', 'cos', 'worktrees', 'other', 'x.json'))).toBe(false);
    expect(isPathAtOrInsideDir(exempt, join(primary, 'data', 'brain', 'x.json'))).toBe(false);
  });

  it('matches whole path components and a root-level install', () => {
    const lookalike = join(primary, 'data', 'cos', 'worktrees-backup', 'x');
    expect(_resolveGuardRoots(lookalike).exempt).toBeNull();
    const rootLevel = _resolveGuardRoots(`${sep}data${sep}cos${sep}worktrees${sep}claim-example`);
    expect(rootLevel.root).toBe(canonicalizePath(`${sep}data`));
    expect(rootLevel.exempt).toBe(canonicalizePath(`${sep}data${sep}cos${sep}worktrees${sep}claim-example`));
  });

  it('exempts nothing outside a worktree', () => {
    const { root, exempt } = _resolveGuardRoots(primary);
    expect(exempt).toBeNull();
    expect(isPathAtOrInsideDir(root, join(primary, 'data', 'x.json'))).toBe(true);
  });
});
