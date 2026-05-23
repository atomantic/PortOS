/**
 * Reference Repos service.
 *
 * Each PortOS-managed app can list upstream repos it watches for clean-room
 * reimplementation — the agent reads upstream commits and proposes which
 * features/fixes are worth re-building in the app's OWN code, never
 * copying upstream verbatim.
 * (e.g., PortOS itself watches `phosphene` for video-gen ideas). The
 * `reference-watch` scheduled task asks this service to fetch each ref
 * and find commits since `lastReviewedSha`. The CoS sub-agent then
 * appends slug-tagged `[ref-watch-…]` checklist items to PLAN.md in the
 * target app's repo, which `/claim` / `plan-task` picks up later.
 *
 * Storage: refs live inline on each app in data/apps.json under the
 * `referenceRepos` array — fits the existing per-app config model and
 * keeps the schedule task's per-app dispatch simple.
 *
 * Clones: managed under data/cos/reference-repos/<refId>/. The user
 * never has to clone manually; first `check` initializes the clone.
 */

import { existsSync, statSync } from 'fs';
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
import { DEFAULT_REVIEWER } from '../lib/validation.js';

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

// addReferenceRepo always assigns refIds via uuidv4(), but apps.json is a
// hand-editable JSON file — a corrupted or maliciously-edited entry could
// set `id` to "../.." and have cloneDir escape REFERENCE_REPOS_ROOT,
// letting git operations read/write arbitrary paths under PATHS.data.
// Enforce a strict id format here so the assumption "refId is a safe
// path segment" holds at every callsite.
const REF_ID_RE = /^[A-Za-z0-9_-]+$/;
const cloneDir = (refId) => {
  if (typeof refId !== 'string' || !REF_ID_RE.test(refId)) {
    throw new ServerError(
      `Reference repo id has an invalid format (must match ${REF_ID_RE.source}): ${refId}`,
      { status: 500, code: 'REFERENCE_REPO_BAD_ID' },
    );
  }
  return join(REFERENCE_REPOS_ROOT, refId);
};

// scp-style remotes — git accepts both `user@host:path` and the bare
// `host:path` form. Disambiguating from a Windows drive path (`C:\foo`,
// `C:/foo`) requires the segment before `:` to be longer than one char
// (excluding Windows drive letters). The segment after `:` must NOT start
// with `\` or `/` (excluding `C:\path` / `C:/path` style local paths).
// This matches how git itself parses scp-syntax in `connect.c`. Examples:
//   git@github.com:owner/repo.git   → remote (scp with user, dotted host)
//   github.com:owner/repo.git       → remote (scp without user, dotted host)
//   gitserver:owner/repo.git        → remote (scp without user, intranet host
//                                     with no dot — common on internal forges)
//   user@gitserver:owner/repo.git   → remote (scp with user, host has no dot)
//   C:\Users\me\repo                → local (host-segment single char)
//   C:/Users/me/repo                → local (same; segment after `:` is `/`)
const SCP_REMOTE_RE = /^([^/@:]+@)?[^/@:]{2,}:[^\\/].*$/;

const isLocalPath = (urlOrPath) => {
  if (!urlOrPath) return false;
  // scheme:// and scp-style remotes (`user@host:path` and bare `host:path`)
  // are remote; everything else (including ~ and absolute paths) is local.
  // The user can pass `/Users/.../phosphene` or `~/phosphene` to skip the
  // clone and reuse an existing working tree.
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

// Reject any HTTPS URL with credentials in userinfo (e.g.
// `https://token@host/repo` or `https://user:token@host/repo`). Throws a
// 400 ServerError on rejection so route handlers don't need to repeat the
// check. scp-style `git@host:repo` is NOT credentials (SSH key auth) and
// is allowed through. Used by both addReferenceRepo (ingest) and
// updateReferenceRepo (PATCH) so a tokened URL can't sneak in either way.
const rejectCredentialedUrl = (url) => {
  if (typeof url !== 'string') return;
  if (/^\w+:\/\/[^\s/@]+@/.test(url)) {
    throw new ServerError(
      'repoUrl must not embed credentials in the URL (e.g. https://token@host/repo). Configure git credentials separately (credential helper, SSH keys).',
      { status: 400, code: 'REFERENCE_REPO_URL_HAS_CREDS' },
    );
  }
};

// Patterns that indicate the user's config is wrong (so the right HTTP
// status is 4xx, not 5xx). Order matters — first match wins. Codes here
// surface to the UI via `lastError`, so the strings are user-facing.
const GIT_USER_ERROR_PATTERNS = [
  { pattern: /authentication failed|could not read username|terminal prompts disabled/i, code: 'REFERENCE_REPO_AUTH_FAILED', status: 400 },
  { pattern: /could not resolve host|repository not found|not found\.\s*$/i, code: 'REFERENCE_REPO_NOT_FOUND_REMOTE', status: 400 },
  { pattern: /unknown revision|bad revision|unknown ref/i, code: 'REFERENCE_REPO_BAD_REF', status: 400 },
  { pattern: /not a git repository/i, code: 'REFERENCE_REPO_NOT_A_REPO', status: 400 },
];

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
    // Map well-known stderr patterns to 4xx so the UI/route layer can
    // distinguish "fix your config" from "server problem". checkReferenceRepo
    // preserves these codes when re-throwing.
    const userError = GIT_USER_ERROR_PATTERNS.find((p) => p.pattern.test(safeMessage));
    const status = userError ? userError.status : 500;
    const code = userError ? userError.code : 'REFERENCE_REPO_GIT_FAILED';
    throw new ServerError(`git ${safeArgs.join(' ')}: ${safeMessage}`, { status, code });
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
    // A regular file (or symlink to one) at the path will surface later as
    // an opaque "not a git repository" error from `git rev-parse`. Catch it
    // here with a clear message so the user knows to fix the URL.
    let stat;
    try { stat = statSync(localPath); } catch {
      throw new ServerError(`Local reference path not accessible: ${ref.repoUrl}`, { status: 400, code: 'REFERENCE_REPO_LOCAL_INACCESSIBLE' });
    }
    if (!stat.isDirectory()) {
      throw new ServerError(`Local reference path is not a directory: ${ref.repoUrl}`, { status: 400, code: 'REFERENCE_REPO_LOCAL_NOT_DIR' });
    }
    if (!existsSync(join(localPath, '.git'))) {
      throw new ServerError(`Local reference path is not a git working tree (no .git): ${ref.repoUrl}`, { status: 400, code: 'REFERENCE_REPO_LOCAL_NOT_GIT' });
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
  // For URL-based refs, fetch the latest from origin so rev-parse picks
  // up new commits. Local-path refs are the user's own working tree —
  // skip fetch (the user manages their tree directly) and read the
  // branch tip in place.
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
// Hard cap on commits returned per check. Without this, a ref left
// unreviewed for a long time (a year of upstream activity, e.g. ~3000
// commits) generates an oversized agent prompt, a huge UI payload, and
// a slow git log. 200 is plenty for the agent to prioritize commits
// against the user's notes; the user can pin lastReviewedSha forward
// to drop older items if needed.
const COMMIT_LIST_CAP = 200;

// Returns { commits, truncated, totalCommitCount } where:
//   - commits.length <= COMMIT_LIST_CAP
//   - truncated is true when totalCommitCount > COMMIT_LIST_CAP
//   - totalCommitCount is null when truncation isn't possible (no sinceSha)
const listCommits = async (cwd, sinceSha, headRef) => {
  if (!sinceSha) {
    // No prior review — surface only the most recent 25 commits to keep
    // the first-scan prompt bounded. The UI tells the user they can pin
    // a SHA manually if they want to start from a specific point.
    const out = await runGit(cwd, ['log', '-n', '25', '--pretty=format:%H%x09%an%x09%ae%x09%aI%x09%s', headRef]);
    return { commits: parseCommitLog(out), truncated: false, totalCommitCount: null };
  }
  // For incremental scans we DO know the total — check it cheaply with
  // `rev-list --count` so the UI can show "showing 200 of N" honestly,
  // then fetch only the most recent COMMIT_LIST_CAP entries.
  const range = `${sinceSha}..${headRef}`;
  const totalRaw = await runGit(cwd, ['rev-list', '--count', range]);
  const totalCommitCount = Number(totalRaw) || 0;
  const out = await runGit(cwd, ['log', '-n', String(COMMIT_LIST_CAP), '--pretty=format:%H%x09%an%x09%ae%x09%aI%x09%s', range]);
  const commits = parseCommitLog(out);
  return { commits, truncated: totalCommitCount > COMMIT_LIST_CAP, totalCommitCount };
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
  const trimmedUrl = repoUrl.trim();
  rejectCredentialedUrl(trimmedUrl);
  const existing = Array.isArray(app.referenceRepos) ? app.referenceRepos : [];
  const ref = {
    id: uuidv4(),
    name: name.trim(),
    repoUrl: trimmedUrl,
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
  //
  // Defensive SHA validation: the route's Zod schema already hex-validates
  // lastReviewedSha, but a non-route caller (CoS task runner, future
  // internal API) could bypass that and persist garbage. Re-check here so
  // the service contract is self-enforcing. null clears the SHA cleanly
  // and is allowed.
  if (patch.lastReviewedSha !== undefined && patch.lastReviewedSha !== null && !SHA_RE.test(patch.lastReviewedSha)) {
    throw new ServerError(`lastReviewedSha must be a 40-char hex SHA: ${patch.lastReviewedSha}`, { status: 400, code: 'REFERENCE_REPO_BAD_SHA' });
  }
  // PATCH must enforce the same credential-in-URL rejection as POST —
  // otherwise a user could sidestep the ingest check by editing the URL
  // afterwards and persisting `https://token@host/repo` into apps.json.
  if (typeof patch.repoUrl === 'string') {
    rejectCredentialedUrl(patch.repoUrl.trim());
  }
  // When a SHA is being pinned, verify it actually resolves to a commit
  // in the clone. Without this, a PATCH could persist a syntactically valid
  // but nonexistent SHA, and the next `checkReferenceRepo` would die in
  // `git log <bad>..HEAD` with a confusing "unknown revision" error.
  // Skipped when:
  //   - clearing (null) — that always succeeds
  //   - the ref has never been cloned yet (fresh add + manual SHA pin)
  //   - the same PATCH is also changing repoUrl: the clone hasn't been
  //     re-fetched against the new origin yet, so its commits reflect
  //     the OLD repo. Verifying against stale state would produce
  //     misleading results (false positives where the SHA happens to
  //     exist in the old repo, or false negatives where it doesn't).
  //     Let the next checkReferenceRepo surface any real mismatch.
  const repoUrlChanging = typeof patch.repoUrl === 'string' && patch.repoUrl.trim() !== refs[idx].repoUrl;
  if (
    typeof patch.lastReviewedSha === 'string'
    && SHA_RE.test(patch.lastReviewedSha)
    && !repoUrlChanging
  ) {
    const ref = refs[idx];
    const dest = isLocalPath(ref.repoUrl) ? expandHome(ref.repoUrl) : cloneDir(ref.id);
    // Same .git-existence check applies to both URL-based managed clones
    // and user-supplied local paths (ensureClone validates `.git` for local
    // refs too), so no per-branch logic needed.
    const cloneExists = existsSync(join(dest, '.git'));
    if (cloneExists) {
      const verify = await execGit(['cat-file', '-e', `${patch.lastReviewedSha}^{commit}`], dest, { timeout: 10_000 })
        .catch((err) => ({ error: err }));
      if (verify && verify.error) {
        // `cat-file -e` exits non-zero for two distinct reasons: (a) the
        // object isn't there, and (b) the repo is corrupt / unreadable /
        // permissions / timeout. The user-facing fix is different in each
        // case — distinguish via stderr text so the UI can show actionable
        // detail.
        const msg = String(verify.error.message || '').toLowerCase();
        const looksLikeMissing = /not a valid object|missing|does not exist|bad object|unable to read tree/.test(msg);
        if (looksLikeMissing) {
          throw new ServerError(
            `lastReviewedSha ${patch.lastReviewedSha.slice(0, 8)} not found in reference repo "${ref.name}"`,
            { status: 400, code: 'REFERENCE_REPO_SHA_NOT_FOUND' },
          );
        }
        // Anything else (permission denied, corrupt index, timeout) — surface
        // the underlying message so the user can act on it. Redact in case
        // the error includes the URL with credentials.
        throw new ServerError(
          `Failed to verify lastReviewedSha against reference repo "${ref.name}": ${redactUrlCreds(verify.error.message || 'unknown git error')}`,
          { status: 500, code: 'REFERENCE_REPO_SHA_VERIFY_FAILED' },
        );
      }
    }
  }
  // If repoUrl is changing on a URL-based ref with an existing managed
  // clone, point the clone's origin remote at the new URL — otherwise
  // subsequent fetches keep pulling from the old URL and the ref appears
  // stuck. Skipped when: same URL, ref is local-path (no managed clone),
  // or no clone exists yet (next check will clone fresh).
  const oldRef = refs[idx];
  if (typeof patch.repoUrl === 'string' && patch.repoUrl.trim() !== oldRef.repoUrl && !isLocalPath(patch.repoUrl)) {
    const dest = cloneDir(oldRef.id);
    if (existsSync(join(dest, '.git'))) {
      const result = await execGit(['remote', 'set-url', 'origin', patch.repoUrl.trim()], dest, { timeout: 10_000 })
        .catch((err) => ({ error: err }));
      if (result && result.error) {
        // Don't fail the patch outright — the user can manually delete
        // and re-add the ref to recover. But surface a warning so the
        // next check doesn't silently fetch from the old URL.
        console.warn(`⚠️ Failed to update origin remote for ref "${oldRef.name}": ${redactUrlCreds(result.error.message || '')}. Next check may use the previous URL — delete and re-add the ref to recover.`);
      }
    }
  }
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
    const { commits, truncated, totalCommitCount } = await listCommits(cwd, ref.lastReviewedSha, headRef);
    snapshot = {
      head,
      headShort: SHORT_SHA(head),
      sinceSha: ref.lastReviewedSha,
      sinceShort: SHORT_SHA(ref.lastReviewedSha),
      // Visible-on-this-page count, capped by COMMIT_LIST_CAP.
      commitCount: commits.length,
      // True when more commits exist upstream than we returned. UI shows
      // "X of Y new" when this is set.
      truncated,
      // The full count (only available for incremental scans). null on
      // first scan since we don't pay for an extra rev-list there.
      totalCommitCount,
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
 * sub-agent finishes appending PLAN.md items for the new commits, or by
 * the UI's "mark as reviewed" button. SHA must match a real commit visible from
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
  // Redact userinfo before emitting into the prompt — even though we strip
  // credentials at ingest now, older entries persisted before that fix may
  // still carry tokens in apps.json.
  lines.push(`- Repo: ${redactUrlCreds(ref.repoUrl)}`);
  lines.push(`- Branch: ${ref.branch || 'main'}`);
  lines.push(`- Last reviewed: ${SHORT_SHA(ref.lastReviewedSha) || '(none — first scan)'}`);
  // When truncated, surface "showing X of Y" so the agent knows it's
  // looking at a head-end slice (most recent COMMIT_LIST_CAP commits).
  // Older commits are still in the upstream; user can pin a SHA forward
  // to drop them or run another check after reviewing this batch.
  const countLabel = snapshot.truncated
    ? `${snapshot.commitCount} of ${snapshot.totalCommitCount} new commits — older ones omitted; review these first then pin SHA forward`
    : `${snapshot.commitCount} new commits`;
  lines.push(`- Current head: ${snapshot.headShort} (${countLabel})`);
  if (ref.notes) {
    lines.push('');
    // User-provided context: how the app relates to this upstream — what
    // features the app maintains in its own code, what bugs to watch for,
    // what areas of upstream are out of scope. The agent uses this to
    // prioritize commits and decide what's worth reimplementing.
    lines.push('### Context (user-supplied — how this app relates to the repo)');
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

/**
 * Trigger a CoS analysis task for a single reference repo after a successful
 * check found new commits. Builds the reference-watch prompt with the snapshot
 * data and queues it as an internal task for the next available agent slot.
 *
 * Returns `{ queued: true, taskId }` on success, or `{ queued: false, reason }`
 * when the task can't be created (e.g. no commits, app not found).
 */
export async function triggerReferenceAnalysis(app, ref, snapshot) {
  if (!snapshot || snapshot.commitCount === 0) {
    return { queued: false, reason: 'no-new-commits' };
  }
  if (!app) return { queued: false, reason: 'app-not-found' };

  const { addTask } = await import('./cos.js');
  const taskSchedule = await import('./taskSchedule.js');

  const referenceDataBlock = formatReferenceForPrompt(ref, snapshot);
  const promptTemplate = await taskSchedule.getTaskPrompt('reference-watch');
  // Use arrow replacers to avoid $& / $1 interpretation in replacement strings
  const fullPrompt = promptTemplate
    .replace(/\{appName\}/g, () => app.name)
    .replace(/\{repoPath\}/g, () => app.repoPath)
    .replace(/\{appId\}/g, () => app.id)
    .replace(/\{reviewer\}/g, () => DEFAULT_REVIEWER)
    .replace(/\{referenceData\}/g, () => referenceDataBlock)
    .replace(/\{planConstraint\}/g, () => '');

  const task = await addTask({
    id: `sys-ref-analysis-${app.id}-${ref.id}-${Date.now().toString(36)}`,
    status: 'pending',
    priority: 'MEDIUM',
    priorityValue: 2,
    description: `Reference-watch analysis: ${ref.name} (${redactUrlCreds(ref.repoUrl)}) for ${app.name}`,
    metadata: {
      app: app.id,
      appName: app.name,
      repoPath: app.repoPath,
      analysisType: 'reference-watch',
      autoGenerated: true,
      // The reference-watch prompt v2 instructs the agent to APPEND
      // slug-tagged checklist items to PLAN.md (and commit). readOnly:true
      // would inject the "do not modify or commit files" guard into the
      // system prompt and the agent would refuse to write the PLAN
      // entries — defeating the whole flow. Mark writable.
      readOnly: false,
      context: fullPrompt,
    },
    autoApproved: true,
    section: 'pending',
  }, 'internal', { raw: true });

  if (task?.duplicate) {
    return { queued: false, reason: 'duplicate', taskId: task.id };
  }
  return { queued: true, taskId: task.id };
}

// Exported for tests + reference-watch task type lookup.
export const __test = {
  REFERENCE_REPOS_ROOT,
  cloneDir,
  isLocalPath,
  workingDirectory,
  parseCommitLog,
};
