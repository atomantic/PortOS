/**
 * Reference Repos service.
 *
 * Each PortOS-managed app can list upstream repos it borrows code from
 * (e.g., PortOS itself watches `phosphene` for video-gen ideas). The
 * `reference-watch` scheduled task asks this service to fetch each ref
 * and find commits since `lastReviewedSha`. The CoS sub-agent then
 * produces a REFERENCE_REVIEW.md proposal in the target app's repo.
 *
 * Storage: refs live inline on each app in data/apps.json under the
 * `referenceRepos` array — fits the existing per-app config model and
 * keeps the schedule task's per-app dispatch simple.
 *
 * Clones: managed under data/cos/reference-repos/<refId>/. The user
 * never has to clone manually; first `check` initializes the clone.
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { ensureDir, PATHS } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { execGit } from '../lib/execGit.js';
import {
  getAppById,
  updateApp,
} from './apps.js';

// `path.join(homedir(), '/.foo')` discards the homedir because of the leading
// slash, so we strip the `~/` prefix (or `~`) before joining. Same shape as
// the helper in lib/mediaModels.js — kept inline here to avoid pulling in the
// rest of that module just for one helper.
const expandHome = (p) => {
  if (!p || typeof p !== 'string' || !p.startsWith('~')) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
};

const REFERENCE_REPOS_ROOT = join(PATHS.data, 'cos', 'reference-repos');

// 40-char hex SHA the same way git outputs it. Used by every callsite that
// reads a SHA back from `git rev-parse` — git is supposed to give us 40 hex
// chars, but if the working tree is corrupt we should fail loud rather than
// quietly write garbage to apps.json.
const SHA_RE = /^[0-9a-f]{40}$/i;

const SHORT_SHA = (sha) => (sha && SHA_RE.test(sha) ? sha.slice(0, 8) : null);

const cloneDir = (refId) => join(REFERENCE_REPOS_ROOT, refId);

// scp-style remotes: `user@host:owner/repo[.git]`. Different from a Windows
// path like `C:\foo` because the part before `:` must be `user@host` shaped
// (no slash, must contain `@`), and the part after `:` must NOT start with
// `\` (which would make it a Windows drive). This matches how git itself
// detects scp-like syntax in `connect.c`.
const SCP_REMOTE_RE = /^[^/@:]+@[^/@:]+:[^\\].*/;

const isLocalPath = (urlOrPath) => {
  if (!urlOrPath) return false;
  // scheme:// and scp-style `user@host:path` are remote; everything else
  // (including ~ and absolute paths) is local. The user can pass
  // `/Users/.../phosphene` to skip the clone and reuse an existing
  // working tree.
  if (urlOrPath.includes('://')) return false;
  if (SCP_REMOTE_RE.test(urlOrPath)) return false;
  return true;
};

// Strip userinfo (`user:token@`) from URL-shaped args so a bad HTTPS remote
// doesn't surface its embedded PAT in the persisted `lastError` field (which
// the UI renders verbatim). Also catches scp-style `user@host:path` — but
// keeps the host so the user can still see what failed.
const redactUrlCreds = (s) => {
  if (typeof s !== 'string') return s;
  // scheme://user:token@host/...  → scheme://host/...
  let out = s.replace(/(\w+:\/\/)[^\s/@]+@/g, '$1');
  // user@host:path  → host:path  (scp-style only, no scheme)
  if (!out.includes('://')) {
    out = out.replace(/(^|\s)[^\s/@:]+@([^\s/@:]+:[^\s]+)/g, '$1$2');
  }
  return out;
};
const redactArgsForError = (args) => args.map(redactUrlCreds);

// Wrap the shared execGit helper so the rest of this module gets the same
// `(cwd, args) => stdout` shape it had before — and so any git failure here
// surfaces as a typed ServerError instead of a bare Error.
const runGit = async (cwd, args, { timeoutMs = 60_000 } = {}) => {
  const result = await execGit(args, cwd, { timeout: timeoutMs }).catch((err) => ({ error: err }));
  if (result.error) {
    // Redact `user:token@host` userinfo and scp-style `user@host` from BOTH
    // the persisted/thrown message AND the server log line — credentials
    // embedded in repoUrl must not land anywhere they could later be read
    // (logs, persisted lastError, or API responses).
    const safeArgs = redactArgsForError(args);
    const safeMessage = redactUrlCreds(String(result.error.message || ''));
    console.error(`❌ git ${safeArgs.join(' ')} (cwd=${cwd}) failed: ${safeMessage}`);
    throw new ServerError(`git ${safeArgs.join(' ')}: ${safeMessage}`, { status: 500, code: 'REFERENCE_REPO_GIT_FAILED' });
  }
  return String(result.stdout || '').trim();
};

/**
 * Resolve the working directory for a ref. For URL-based refs we use the
 * managed clone path under data/cos/reference-repos/<refId>/; for local
 * refs (user-supplied path), we shell directly into that path so the user
 * can keep using their normal working tree. `~` in a local path is
 * expanded so cwd ends up on the actual filesystem path.
 */
const workingDirectory = (ref) => (
  isLocalPath(ref.repoUrl) ? expandHome(ref.repoUrl) : cloneDir(ref.id)
);

/**
 * Make sure the managed clone exists for a URL-based ref. No-op for local
 * refs (the user maintains those themselves).
 */
const ensureClone = async (ref) => {
  if (isLocalPath(ref.repoUrl)) {
    const localPath = expandHome(ref.repoUrl);
    if (!existsSync(localPath)) {
      throw new ServerError(`Local reference path not found: ${ref.repoUrl}`, { status: 400, code: 'REFERENCE_REPO_LOCAL_MISSING' });
    }
    return localPath;
  }
  await ensureDir(REFERENCE_REPOS_ROOT);
  const dest = cloneDir(ref.id);
  if (existsSync(join(dest, '.git'))) return dest;
  // No clone yet → bring one down. --depth 1 would lose the diff window we
  // need for `git log lastReviewedSha..HEAD`, so do a full clone.
  console.log(`📦 Cloning reference repo "${ref.name}" → ${dest}`);
  await runGit(REFERENCE_REPOS_ROOT, ['clone', ref.repoUrl, ref.id], { timeoutMs: 600_000 });
  return dest;
};

/**
 * Fetch the latest commits for a ref's branch (or its remote-tracking
 * default if no branch was set). Returns the head SHA after fetch.
 */
const fetchHead = async (ref) => {
  const cwd = await ensureClone(ref);
  const branch = ref.branch || 'main';
  // Use `git fetch origin <branch>` and read the new ref via FETCH_HEAD.
  // For local-path refs we still need fetch to be a no-op-safe call.
  if (!isLocalPath(ref.repoUrl)) {
    await runGit(cwd, ['fetch', '--prune', 'origin', branch]);
  }
  const headRef = isLocalPath(ref.repoUrl) ? branch : `origin/${branch}`;
  const head = await runGit(cwd, ['rev-parse', headRef]);
  if (!SHA_RE.test(head)) {
    throw new ServerError(`git rev-parse returned non-SHA for ${headRef}: "${head}"`, { status: 500, code: 'REFERENCE_REPO_GIT_FAILED' });
  }
  return { cwd, head, headRef };
};

/**
 * Build a structured commit list since `sinceSha` (exclusive) up to the
 * ref tip. Returned shape is JSON-friendly so the UI / agent prompt can
 * render it directly.
 */
const listCommits = async (cwd, sinceSha, headRef) => {
  if (!sinceSha) {
    // No prior review — surface only the most recent 25 commits to keep
    // the agent prompt bounded. The UI tells the user they can pin a
    // SHA manually if they want to start from a specific point.
    const out = await runGit(cwd, ['log', '-n', '25', '--pretty=format:%H%x09%an%x09%ae%x09%aI%x09%s', headRef]);
    return parseCommitLog(out);
  }
  const out = await runGit(cwd, ['log', '--pretty=format:%H%x09%an%x09%ae%x09%aI%x09%s', `${sinceSha}..${headRef}`]);
  return parseCommitLog(out);
};

const parseCommitLog = (raw) => {
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => {
    const [sha, author, email, date, ...rest] = line.split('\t');
    return { sha, author, email, date, subject: rest.join('\t') };
  });
};

/**
 * Public API ─────────────────────────────────────────────────────────────
 */

export async function listReferenceRepos(appId) {
  const app = await getAppById(appId);
  if (!app) throw new ServerError(`App not found: ${appId}`, { status: 404, code: 'APP_NOT_FOUND' });
  return Array.isArray(app.referenceRepos) ? app.referenceRepos : [];
}

export async function addReferenceRepo(appId, { name, repoUrl, branch, notes }) {
  const app = await getAppById(appId);
  if (!app) throw new ServerError(`App not found: ${appId}`, { status: 404, code: 'APP_NOT_FOUND' });
  const existing = Array.isArray(app.referenceRepos) ? app.referenceRepos : [];
  const ref = {
    id: uuidv4(),
    name: name.trim(),
    repoUrl: repoUrl.trim(),
    branch: (branch || 'main').trim(),
    notes: (notes || '').trim(),
    lastReviewedSha: null,
    lastCheckedAt: null,
    status: 'needs-clone',
    lastError: null,
    createdAt: new Date().toISOString(),
  };
  await updateApp(appId, { referenceRepos: [...existing, ref] });
  return ref;
}

export async function updateReferenceRepo(appId, refId, patch) {
  const app = await getAppById(appId);
  if (!app) throw new ServerError(`App not found: ${appId}`, { status: 404, code: 'APP_NOT_FOUND' });
  const refs = Array.isArray(app.referenceRepos) ? app.referenceRepos : [];
  const idx = refs.findIndex((r) => r.id === refId);
  if (idx < 0) throw new ServerError(`Reference repo not found: ${refId}`, { status: 404, code: 'REFERENCE_REPO_NOT_FOUND' });
  // Allow only known fields through — guards against a bad client payload
  // resetting status/lastError/etc. Trim the same string fields that
  // addReferenceRepo() trims so we don't end up with mismatched shapes
  // (e.g. " main " as a branch name causing confusing git failures).
  // lastReviewedSha is a regex-validated 40-char SHA, no trim.
  const TRIMMED_KEYS = new Set(['name', 'repoUrl', 'branch', 'notes']);
  const updated = { ...refs[idx] };
  for (const key of ['name', 'repoUrl', 'branch', 'notes', 'lastReviewedSha']) {
    if (patch[key] !== undefined) {
      updated[key] = (TRIMMED_KEYS.has(key) && typeof patch[key] === 'string')
        ? patch[key].trim()
        : patch[key];
    }
  }
  // Manual SHA pin counts as a review — record the time so "last reviewed"
  // doesn't silently lie. Skip the bump when the SHA is being CLEARED
  // (lastReviewedSha=null), otherwise "last checked" would look fresh
  // immediately after a reset.
  if (typeof patch.lastReviewedSha === 'string' && SHA_RE.test(patch.lastReviewedSha)) {
    updated.lastCheckedAt = new Date().toISOString();
  }
  const next = [...refs];
  next[idx] = updated;
  await updateApp(appId, { referenceRepos: next });
  return updated;
}

export async function deleteReferenceRepo(appId, refId) {
  const app = await getAppById(appId);
  if (!app) throw new ServerError(`App not found: ${appId}`, { status: 404, code: 'APP_NOT_FOUND' });
  const refs = Array.isArray(app.referenceRepos) ? app.referenceRepos : [];
  const next = refs.filter((r) => r.id !== refId);
  if (next.length === refs.length) {
    throw new ServerError(`Reference repo not found: ${refId}`, { status: 404, code: 'REFERENCE_REPO_NOT_FOUND' });
  }
  await updateApp(appId, { referenceRepos: next });
  // Clone is best-effort to leave on disk — user might re-add the ref by
  // URL and we'd save them the re-clone. UI offers a "purge clones" action
  // separately if disk pressure becomes a thing.
  return { ok: true };
}

/**
 * Fetch the ref, compute commits since lastReviewedSha, and return a
 * structured snapshot. Does NOT update lastReviewedSha — that happens
 * after the user / scheduled task has reviewed the proposal.
 */
export async function checkReferenceRepo(appId, refId) {
  const app = await getAppById(appId);
  if (!app) throw new ServerError(`App not found: ${appId}`, { status: 404, code: 'APP_NOT_FOUND' });
  const refs = Array.isArray(app.referenceRepos) ? app.referenceRepos : [];
  const ref = refs.find((r) => r.id === refId);
  if (!ref) throw new ServerError(`Reference repo not found: ${refId}`, { status: 404, code: 'REFERENCE_REPO_NOT_FOUND' });

  const checkedAt = new Date().toISOString();
  let snapshot;
  let nextStatus = 'ok';
  let nextError = null;
  let originalError = null;
  try {
    const { cwd, head, headRef } = await fetchHead(ref);
    const commits = await listCommits(cwd, ref.lastReviewedSha, headRef);
    snapshot = {
      head,
      headShort: SHORT_SHA(head),
      sinceSha: ref.lastReviewedSha,
      sinceShort: SHORT_SHA(ref.lastReviewedSha),
      commitCount: commits.length,
      commits,
      cwd,
      branch: ref.branch || 'main',
    };
  } catch (err) {
    nextStatus = 'error';
    nextError = err instanceof ServerError ? err.message : String(err.message || err);
    originalError = err;
  }
  // Persist status + lastCheckedAt regardless of success — UI surfaces the
  // error inline so the user can fix bad URL / branch.
  const next = refs.map((r) => (r.id === refId
    ? { ...r, status: nextStatus, lastError: nextError, lastCheckedAt: checkedAt }
    : r));
  await updateApp(appId, { referenceRepos: next });
  if (nextStatus === 'error') {
    // Preserve the original ServerError's status/code (e.g. 400
    // REFERENCE_REPO_LOCAL_MISSING) so user-fixable config problems don't
    // become opaque 500s. Fall back to a generic 500 only for truly
    // unexpected errors.
    if (originalError instanceof ServerError) {
      throw new ServerError(originalError.message, {
        status: originalError.status,
        code: originalError.code || 'REFERENCE_REPO_CHECK_FAILED',
      });
    }
    throw new ServerError(nextError, { status: 500, code: 'REFERENCE_REPO_CHECK_FAILED' });
  }
  return snapshot;
}

/**
 * Mark a ref as reviewed up to the given SHA — called after a CoS
 * sub-agent finishes producing REFERENCE_REVIEW.md, or by the UI's
 * "mark as reviewed" button. SHA must match a real commit visible from
 * the ref's working tree (verified via `git cat-file -e <sha>^{commit}`
 * against the managed clone or the user-supplied local path).
 */
export async function markReferenceRepoReviewed(appId, refId, sha) {
  if (!SHA_RE.test(sha || '')) {
    throw new ServerError(`Invalid SHA: ${sha}`, { status: 400, code: 'REFERENCE_REPO_BAD_SHA' });
  }
  const app = await getAppById(appId);
  if (!app) throw new ServerError(`App not found: ${appId}`, { status: 404, code: 'APP_NOT_FOUND' });
  const refs = Array.isArray(app.referenceRepos) ? app.referenceRepos : [];
  const ref = refs.find((r) => r.id === refId);
  if (!ref) throw new ServerError(`Reference repo not found: ${refId}`, { status: 404, code: 'REFERENCE_REPO_NOT_FOUND' });
  // Make sure the clone exists, then verify the SHA resolves to a real
  // commit object. `cat-file -e <sha>^{commit}` exits non-zero (and our
  // execGit wrapper rejects) if the object is missing or not a commit.
  const cwd = await ensureClone(ref);
  const verify = await execGit(['cat-file', '-e', `${sha}^{commit}`], cwd, { timeout: 10_000 })
    .catch((err) => ({ error: err }));
  if (verify && verify.error) {
    throw new ServerError(
      `SHA ${sha.slice(0, 8)} not found in reference repo "${ref.name}"`,
      { status: 400, code: 'REFERENCE_REPO_SHA_NOT_FOUND' },
    );
  }
  return updateReferenceRepo(appId, refId, { lastReviewedSha: sha });
}

/**
 * Render a reference's commit list + notes into a Markdown chunk that
 * the reference-watch task injects into its agent prompt. Kept here
 * (not in the prompt template) so we can iterate the format without
 * touching cos.js.
 */
export function formatReferenceForPrompt(ref, snapshot) {
  const lines = [];
  lines.push(`## Reference: ${ref.name}`);
  lines.push(`- Repo: ${ref.repoUrl}`);
  lines.push(`- Branch: ${ref.branch || 'main'}`);
  lines.push(`- Last reviewed: ${SHORT_SHA(ref.lastReviewedSha) || '(none — first scan)'}`);
  lines.push(`- Current head: ${snapshot.headShort} (${snapshot.commitCount} new commits)`);
  if (ref.notes) {
    lines.push('');
    lines.push(`### What we use from this repo`);
    lines.push(ref.notes);
  }
  if (snapshot.commits.length === 0) {
    lines.push('');
    lines.push('_No new commits since last review._');
    return lines.join('\n');
  }
  lines.push('');
  lines.push('### Commits to review');
  for (const c of snapshot.commits) {
    lines.push(`- \`${c.sha.slice(0, 8)}\` ${c.subject} _(by ${c.author}, ${c.date.slice(0, 10)})_`);
  }
  lines.push('');
  lines.push(`Source clone is at: \`${snapshot.cwd}\` — use \`git -C ${snapshot.cwd} show <sha>\` to read each commit's diff.`);
  return lines.join('\n');
}

// Exported for tests + reference-watch task type lookup.
export const __test = {
  REFERENCE_REPOS_ROOT,
  cloneDir,
  isLocalPath,
  workingDirectory,
  parseCommitLog,
};
