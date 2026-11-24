/**
 * One in-memory view of the repository for the structural guard runners (#16996).
 *
 * Every check in a structural guard runner's directory (GUARD_CHECK_DIRS in
 * guardScanners.js) runs inside that runner's Vitest worker. Separately, each one
 * listed the tree with its own `git ls-files`, stat'd every entry and re-read the
 * same sources; together they read the tree dozens of times per run. A corpus lists
 * the tree once, matches pathspecs in memory, and reads each file once, so checks
 * share that work instead of repeating it.
 *
 * The cache lives for one process and assumes the tree does not change under it:
 * a self-test that builds a fixture tree gets its own `createGuardCorpus(fixtureRoot)`
 * (or the uncached `trackedFiles()` helper) and never writes into the real checkout.
 *
 * Pathspecs follow git's default (non-glob) semantics: a literal names a file or a
 * leading directory, `*` and `?` also match `/`, `[...]` is a character class, and
 * `:!` / `:(exclude)` subtracts. Any other magic or a path outside the listed root
 * falls back to running git, so an unusual pathspec costs a spawn rather than a
 * wrong answer. `guardCorpus.test.js` pins the in-memory matcher against git itself.
 *
 * Builtins only, so a check in any workspace can import it.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedFiles as gitTrackedFiles, workingTreeFiles as gitWorkingTreeFiles } from './trackedFiles.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const toPosix = (path) => path.split(sep).join('/');
const GLOB_CHARS = /[*?[]/;
// Pathspec magic other than exclusion, escapes, and parent segments need git's own parser.
const UNSUPPORTED = /^:(?!!|\(exclude\))|\\|(?:^|\/)\.\.(?:\/|$)/;

const escapeRegExp = (text) => text.replace(/[.+^${}()|\\]/g, '\\$&');

/** git's default wildcard matching (no `:(glob)`): `*` and `?` cross `/`, `[...]` is one character. */
function wildcardRegExp(spec) {
  let out = '';
  for (let i = 0; i < spec.length; i += 1) {
    const c = spec[i];
    if (c === '*') out += '.*';
    else if (c === '?') out += '.';
    else if (c === '[') {
      const close = spec.indexOf(']', i + 2);
      if (close < 0) return null;
      let body = spec.slice(i + 1, close);
      if (body.startsWith('[:')) return null;
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      out += `[${body.replace(/\\/g, '\\\\')}]`;
      i = close;
    } else out += escapeRegExp(c);
  }
  return new RegExp(`^${out}$`);
}

/**
 * `(path) => boolean` for a pathspec list relative to the listing root, or `null`
 * when a spec needs git to interpret it. An empty positive list matches everything.
 */
export function pathspecMatcher(pathspecs) {
  const include = [];
  const exclude = [];
  for (const raw of pathspecs) {
    if (typeof raw !== 'string' || raw === '' || UNSUPPORTED.test(raw)) return null;
    const negated = raw.startsWith(':!') || raw.startsWith(':(exclude)');
    const unprefixed = raw.replace(/^:(?:!|\(exclude\))/, '').replace(/^(?:\.\/)+/, '');
    const spec = unprefixed === '.' ? '' : unprefixed.replace(/\/+$/, '');
    let test;
    if (spec === '') test = () => true;
    else if (GLOB_CHARS.test(spec)) {
      const pattern = wildcardRegExp(spec);
      if (!pattern) return null;
      // git also matches a wildcard pathspec's literal directory prefix (`src/*` lists `src/a/b`), which `.*` already covers.
      test = (path) => pattern.test(path);
    } else test = (path) => path === spec || path.startsWith(`${spec}/`);
    (negated ? exclude : include).push(test);
  }
  return (path) => (include.length === 0 || include.some((test) => test(path))) && !exclude.some((test) => test(path));
}

/**
 * A corpus over `root` (default: this repository). Paths it returns are POSIX and
 * relative to the `cwd` a call names (default: `root`), the shape `git ls-files`
 * prints, so a check that used `trackedFiles(cwd, specs)` keeps its answer.
 */
export function createGuardCorpus(root = REPO_ROOT) {
  const base = resolve(root);
  let index = null;
  let indexPaths = null;
  let workingPaths = null;
  let untracked = null;
  const presence = new Map();
  const texts = new Map();
  const buffers = new Map();
  const derived = new Map();

  const git = (args) => execFileSync('git', args, {
    cwd: base, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true,
  });

  /** `{ path, mode }` for every index entry, deduplicated, in index order. */
  const indexEntries = () => {
    if (index) return index;
    const seen = new Set();
    const records = git(['ls-files', '--stage', '-z']).split('\0');
    index = [];
    for (const record of records) {
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const path = record.slice(tab + 1);
      if (seen.has(path)) continue;
      seen.add(path);
      index.push({ path, mode: record.slice(0, record.indexOf(' ')) });
    }
    return index;
  };
  const untrackedPaths = () => (untracked ??= git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean));
  const trackedPaths = () => (indexPaths ??= indexEntries().map(({ path }) => path));
  const workingTreeCandidates = () => {
    if (!workingPaths) {
      const tracked = new Set(trackedPaths());
      workingPaths = Object.freeze([...untrackedPaths().filter((path) => !tracked.has(path)), ...tracked]);
    }
    return workingPaths;
  };

  /** The `lstat` of a root-relative path, or null when nothing is there; once per path. */
  const lstatOf = (path) => {
    let stats = presence.get(path);
    if (stats === undefined) {
      try {
        stats = lstatSync(join(base, path), { throwIfNoEntry: false }) ?? null;
      } catch (error) {
        // `throwIfNoEntry` does not cover a path that descends through a file (`a.mjs/index.js`).
        if (error.code !== 'ENOTDIR') throw error;
        stats = null;
      }
      presence.set(path, stats);
    }
    return stats;
  };
  /** `trackedFiles` drops index entries the working tree no longer has; dangling symlinks stay visible. */
  const isPresent = (path) => lstatOf(path) !== null;

  /** Root-relative prefix (`''` or `'server/'`) of a cwd inside the root, or null outside it. */
  const prefixOf = (cwd) => {
    const rel = toPosix(relative(base, resolve(base, cwd)));
    if (rel === '') return '';
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    return `${rel}/`;
  };

  const list = (paths, pathspecs, cwd, fallback) => {
    const prefix = prefixOf(cwd);
    const matches = prefix === null ? null : pathspecMatcher(pathspecs);
    if (!matches) return fallback(resolve(base, cwd), pathspecs);
    const out = [];
    for (const path of paths) {
      if (!path.startsWith(prefix)) continue;
      const rel = path.slice(prefix.length);
      if (matches(rel) && isPresent(path)) out.push(rel);
    }
    return out;
  };

  const absolute = (path) => (isAbsolute(path) ? resolve(path) : resolve(base, path));

  return {
    root: base,
    /** Present tracked paths matching `pathspecs`, relative to `cwd`: `trackedFiles(cwd, pathspecs)`. */
    tracked(pathspecs = [], { cwd = base } = {}) {
      return list(trackedPaths(), pathspecs, cwd, gitTrackedFiles);
    },
    /** Tracked and non-ignored untracked candidates. Walkers that check presence on read can skip a separate stat pass. */
    workingTreeCandidates,
    /** Present tracked plus untracked, non-ignored paths: `workingTreeFiles(cwd, pathspecs)`, untracked first as git prints them. */
    workingTree(pathspecs = [], { cwd = base } = {}) {
      return list(workingTreeCandidates(), pathspecs, cwd, gitWorkingTreeFiles);
    },
    /**
     * `{ path, mode }` index entries matching root-relative `pathspecs`, present on
     * disk or not: `git ls-files --stage`, one entry per path.
     */
    indexed(pathspecs = []) {
      const matches = pathspecMatcher(pathspecs);
      if (!matches) throw new Error(`indexed() needs git's own parser for ${JSON.stringify(pathspecs)}`);
      return indexEntries().filter(({ path }) => matches(path)).map((entry) => ({ ...entry }));
    },
    /** The working-tree `lstat` of a root-relative path (null when absent), shared with the listings' presence check. */
    lstat: lstatOf,
    /** Raw bytes of a file, read once; for scans that must see binary files as git does. */
    bytes(path) {
      const abs = absolute(path);
      let data = buffers.get(abs);
      if (data === undefined) {
        data = readFileSync(abs);
        buffers.set(abs, data);
      }
      return data;
    },
    /** UTF-8 text of a file, read once; `path` is absolute or root-relative. A read error is not cached. */
    read(path) {
      // Keyed by the caller's spelling first: resolving every lookup cost more than the reads it saved.
      let text = texts.get(path);
      if (text !== undefined) return text;
      const abs = absolute(path);
      text = texts.get(abs);
      if (text === undefined) {
        // Binary-aware checks may already have loaded the bytes.
        text = buffers.get(abs)?.toString('utf8') ?? readFileSync(abs, 'utf8');
        texts.set(abs, text);
      }
      texts.set(path, text);
      return text;
    },
    /**
     * A value computed once per (`kind`, `key`) and shared by every check in the
     * process: the comment-blanked form of a source several checks lex, say.
     */
    derive(kind, key, compute) {
      let values = derived.get(kind);
      if (!values) derived.set(kind, (values = new Map()));
      if (!values.has(key)) values.set(key, compute());
      return values.get(key);
    },
  };
}

let repoCorpus = null;
/** The process-wide corpus over this repository. */
export const guardCorpus = () => (repoCorpus ??= createGuardCorpus(REPO_ROOT));

const ROOT_PREFIX = REPO_ROOT.endsWith(sep) ? REPO_ROOT : `${REPO_ROOT}${sep}`;
const PARENT_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const insideRepo = (path) => {
  // The common case, a normalized absolute path from `join(ROOT, rel)`, needs no resolve.
  if (isAbsolute(path) && !PARENT_SEGMENT.test(path) && (sep === '/' || !path.includes('/'))) {
    return path === REPO_ROOT || path.startsWith(ROOT_PREFIX);
  }
  const rel = relative(REPO_ROOT, resolve(REPO_ROOT, path));
  return !rel.startsWith('..') && !isAbsolute(rel);
};

/** Drop-in `trackedFiles(cwd, pathspecs)` that answers from the shared corpus for paths in this repository. */
export const trackedFiles = (cwd, pathspecs = []) => (insideRepo(cwd)
  ? guardCorpus().tracked(pathspecs, { cwd }) : gitTrackedFiles(cwd, pathspecs));

/** Drop-in `workingTreeFiles(cwd, pathspecs)` backed by the shared corpus. */
export const workingTreeFiles = (cwd, pathspecs = []) => (insideRepo(cwd)
  ? guardCorpus().workingTree(pathspecs, { cwd }) : gitWorkingTreeFiles(cwd, pathspecs));

/**
 * Drop-in `readFileSync(path, 'utf8')`: a file in this repository is read once per
 * process; anything else (a self-test's temp fixture) is read fresh every time.
 */
export const readText = (path) => (insideRepo(path) ? guardCorpus().read(path) : readFileSync(path, 'utf8'));
