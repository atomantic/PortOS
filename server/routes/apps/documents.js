/**
 * App document endpoints — browse/read/write the markdown a managed app keeps
 * in its repo, and commit edits back through git.
 *
 *   GET /:id/documents             → { documents, docs, hasPlanning, gsd }
 *   GET /:id/documents/*docPath    → { filename, content }
 *   PUT /:id/documents/*docPath    → { success, hash?, created }  (git commit)
 *
 * The browsable set is a RULE, not a fixed allowlist (#5773): every markdown
 * file in the repo root, plus everything under a `docs/` directory when the app
 * has one. `SUGGESTED_DOCUMENTS` only seeds the "create this file" affordance
 * for the conventional agent-facing docs a repo may be missing.
 */

import { Router } from 'express';
import { readdir, readFile, realpath } from 'fs/promises';
import { dirname, join } from 'path';
import { atomicWrite, listDirectoryByExtension } from '../../lib/fileUtils.js';
import { isGitStageableFilePath } from '../../lib/gitArgs.js';
import { isPathInsideDir, isSafeFilename, isTopLevelEntryName } from '../../lib/pathSafety.js';
import { documentUpdateSchema } from '../../lib/validation.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import * as git from '../../services/git.js';
import { loadApp, pathExists } from './shared.js';

const router = Router();

// Offered as "Create <file>" when absent from the repo root. Both agent-instruction
// names are listed (#4852): AGENTS.md is canonical, while a managed app's CLAUDE.md
// is either its one-line AGENTS.md bridge or its only file. PLAN.md stays here
// because it is a selectable work tracker for apps with no forge issue tracker.
const SUGGESTED_DOCUMENTS = ['AGENTS.md', 'CLAUDE.md', 'GOALS.md', 'PLAN.md', 'REVIEW.md', 'REJECTED.md'];

// Renderable text extensions. A docs/ tree also holds images and data files;
// those are skipped rather than handed to a markdown renderer as mojibake.
const DOC_EXTENSIONS = ['.md', '.markdown', '.mdx', '.txt'];

const DOCS_DIR = 'docs';
const MAX_DOCS_DEPTH = 5;   // directory levels walked below the repo root
const MAX_DOCS_FILES = 500; // guard against a pathological docs tree

const isDocFile = (name) => isSafeFilename(name, DOC_EXTENSIONS);

const byPath = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/**
 * Every renderable file under `docs/`, as repo-relative `docs/...` paths.
 * Skips dot-directories, and symlinks fall out on their own — `withFileTypes`
 * reports them as neither a file nor a directory.
 */
async function listDocsTree(repoPath) {
  const found = [];
  const walk = async (relDir, depth) => {
    if (depth > MAX_DOCS_DEPTH || found.length >= MAX_DOCS_FILES) return;
    const entries = await readdir(join(repoPath, relDir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (found.length >= MAX_DOCS_FILES) return;
      if (entry.name.startsWith('.') || !isTopLevelEntryName(entry.name)) continue;
      const rel = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) await walk(rel, depth + 1);
      else if (entry.isFile() && isDocFile(entry.name)) found.push(rel);
    }
  };
  if (await pathExists(join(repoPath, DOCS_DIR))) await walk(DOCS_DIR, 1);
  return found.sort(byPath);
}

/**
 * Shape check for a requested document path: a renderable file that is either
 * at the repo root or somewhere under `docs/`. `isSafeFilename` covers the leaf
 * (null bytes, separators, `.`/`..`, extension); the directory segments get the
 * same traversal rule via `isTopLevelEntryName`.
 */
function isAllowedDocumentPath(rel) {
  const parts = String(rel || '').split('/');
  const leaf = parts.pop();
  if (!isDocFile(leaf)) return false;
  if (parts.length === 0) return true;
  if (parts[0] !== DOCS_DIR || parts.length > MAX_DOCS_DEPTH) return false;
  return parts.every(isTopLevelEntryName);
}

/**
 * Validate `*docPath` and resolve it inside the app's repo. Throws the same
 * 400s the single-file allowlist used to, so client error handling is unchanged.
 *
 * The containment check runs TWICE, and the second pass is what makes it real:
 * `isPathInsideDir` is lexical, so a symlinked directory component inside the
 * repo (`docs/shared -> /outside`) passes the string comparison while `readFile`
 * and `atomicWrite` happily follow the link. Canonicalizing closes that escape.
 * The old six-name allowlist had no directory component to subvert; the wildcard
 * route does, so the canonical check arrived with it.
 */
async function resolveDocumentPath(app, docPath) {
  const filename = Array.isArray(docPath) ? docPath.join('/') : String(docPath || '');

  if (!isAllowedDocumentPath(filename)) {
    throw new ServerError('Document not in allowlist', { status: 400, code: 'INVALID_DOCUMENT' });
  }

  const resolved = join(app.repoPath, filename);
  const traversal = () =>
    new ServerError('Invalid document path', { status: 400, code: 'PATH_TRAVERSAL' });

  if (!isPathInsideDir(app.repoPath, resolved)) throw traversal();

  // The PARENT must canonically live in the repo (so a not-yet-created file
  // still validates), and so must the file itself when it already exists — the
  // leaf can be a symlink even when every directory above it is real.
  const realRoot = await realpath(app.repoPath);
  const realParent = await realpath(dirname(resolved)).catch(() => null);
  if (!realParent || (realParent !== realRoot && !isPathInsideDir(realRoot, realParent))) {
    throw traversal();
  }
  const realFile = await realpath(resolved).catch(() => null);
  if (realFile && !isPathInsideDir(realRoot, realFile)) throw traversal();

  return { filename, resolved };
}

/** 400s when the app has no usable checkout — shared by the read/write routes. */
async function requireRepoPath(app) {
  if (!app.repoPath || !await pathExists(app.repoPath)) {
    throw new ServerError('App repo path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }
}

// GET /api/apps/:id/documents - List root markdown + the docs/ tree
router.get('/:id/documents', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!app.repoPath || !await pathExists(app.repoPath)) {
    return res.json({ documents: [], docs: [], hasPlanning: false });
  }

  const [rootNames, docs] = await Promise.all([
    listDirectoryByExtension(app.repoPath, { extensions: DOC_EXTENSIONS, mapEntry: name => name }),
    listDocsTree(app.repoPath),
  ]);
  const rootDocs = rootNames.sort(byPath);

  const documents = [
    ...rootDocs.map(filename => ({ filename, exists: true })),
    ...SUGGESTED_DOCUMENTS.filter(f => !rootDocs.includes(f)).map(filename => ({ filename, exists: false })),
  ];

  const planningDir = join(app.repoPath, '.planning');
  const hasPlanning = await pathExists(planningDir);

  // GSD status: detect which GSD artifacts exist
  const gsd = {
    hasCodebaseMap: await pathExists(join(planningDir, 'codebase')),
    hasProject: await pathExists(join(planningDir, 'PROJECT.md')),
    hasRoadmap: await pathExists(join(planningDir, 'ROADMAP.md')),
    hasState: await pathExists(join(planningDir, 'STATE.md')),
    hasConcerns: await pathExists(join(planningDir, 'CONCERNS.md')),
  };

  res.json({ documents, docs, hasPlanning, gsd });
}));

// GET /api/apps/:id/documents/*docPath - Read a single document
router.get('/:id/documents/*docPath', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  await requireRepoPath(app);

  const { filename, resolved } = await resolveDocumentPath(app, req.params.docPath);

  if (!await pathExists(resolved)) {
    throw new ServerError('Document not found', { status: 404, code: 'NOT_FOUND' });
  }

  const content = await readFile(resolved, 'utf-8');
  res.json({ filename, content });
}));

// PUT /api/apps/:id/documents/*docPath - Update a document and git commit
router.put('/:id/documents/*docPath', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  await requireRepoPath(app);

  const { filename, resolved } = await resolveDocumentPath(app, req.params.docPath);

  // Git staging rejects a substring `..` and shell metacharacters, which
  // `isSafeFilename` allows (`docs/notes..md` is a legal filename). Refuse the
  // write up front rather than mutating the file and then 500-ing on the commit.
  if (!isGitStageableFilePath(filename)) {
    throw new ServerError('Document name cannot be committed by git', {
      status: 400, code: 'INVALID_DOCUMENT'
    });
  }

  const { content, commitMessage } = documentUpdateSchema.parse(req.body);
  const created = !await pathExists(resolved);

  await atomicWrite(resolved, content);
  await git.stageFiles(app.repoPath, [filename]);

  const status = await git.getStatus(app.repoPath);
  if (status.clean) {
    return res.json({ success: true, noChanges: true });
  }

  const message = commitMessage || `docs: update ${filename} via PortOS`;
  const result = await git.commit(app.repoPath, message);
  console.log(`📝 ${created ? 'Created' : 'Updated'} ${filename} in ${app.name} (${result.hash})`);

  res.json({ success: true, hash: result.hash, created });
}));

export default router;
