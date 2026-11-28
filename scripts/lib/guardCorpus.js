/** Checkout-scoped wrappers for the shared repository corpus. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardCorpus as createCorpus } from '../../lib/guardCorpus.js';
import { trackedFiles as gitTrackedFiles, workingTreeFiles as gitWorkingTreeFiles } from './trackedFiles.js';

export { pathspecMatcher } from '../../lib/guardCorpus.js';
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Babel belongs to the server workspace. Resolve it only when an AST check runs
// so standalone scripts and the pre-install CI planner can still use the corpus.
const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
let parse;

export function parseGuardSource(source, { tokens = false } = {}) {
  parse ??= requireServer('@babel/parser').parse;
  return parse(source, {
    sourceType: 'module',
    errorRecovery: true,
    attachComment: false,
    locations: false,
    tokens,
  });
}

export const createGuardCorpus = (root = REPO_ROOT) => {
  const corpus = createCorpus(root);
  return {
    ...corpus,
    /** Shared read-only AST. Strict consumers must reject recovered errors. */
    parseAst(path, { tokens = true } = {}) {
      const absolute = resolve(corpus.root, path);
      const kind = tokens ? 'babelAstWithTokens' : 'babelAst';
      return corpus.derive(kind, absolute, () => parseGuardSource(corpus.read(absolute), { tokens }));
    },
  };
};

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
