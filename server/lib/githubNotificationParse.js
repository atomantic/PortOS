/**
 * Pure parsing for the GitHub notifications inbox (#12870): `gh api --include`
 * output and the thread records GitHub returns. Every field here is external
 * data — titles are shown as text, and the only link kept is one rebuilt from
 * GitHub's own API url that lands on the account's own web host.
 */
import { z } from 'zod';

const THREAD_ID_RE = /^\d{1,20}$/;
const REPO_PART_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_TITLE_CHARS = 500;

/**
 * Split `gh api --include` stdout into status, lower-cased headers and body.
 * Returns null for output that does not start with an HTTP status line.
 */
export function parseGhIncludeOutput(text) {
  const raw = String(text ?? '');
  const split = raw.search(/\r?\n\r?\n/);
  const head = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const [statusLine, ...headerLines] = head.split(/\r?\n/);
  const status = statusLine.match(/^HTTP\/[\d.]+\s+(\d{3})\b/);
  if (!status) return null;
  const headers = {};
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(status[1]), headers, body };
}

export const linkHeaderHasNext = (link) => /<[^>]+>;\s*rel="next"/.test(String(link || ''));

/** `X-Poll-Interval` in seconds, or null when absent or nonsensical. */
export function pollIntervalSeconds(value) {
  const seconds = Number.parseInt(value, 10);
  return Number.isInteger(seconds) && seconds > 0 && seconds <= 86_400 ? seconds : null;
}

const webHostFor = (host) => (host === 'github.com' ? 'github.com' : host);
const apiPrefixFor = (host) => (host === 'github.com' ? 'https://api.github.com/repos/' : `https://${host}/api/v3/repos/`);

const SUBJECT_PATHS = { issues: 'issues', pulls: 'pull', commits: 'commit', discussions: 'discussions' };

/**
 * The browser link for a thread on the account's own host: the subject's page
 * when GitHub gave an API url we recognize, else the repository page. Any url
 * that would leave `host` is dropped rather than shown.
 */
function notificationHtmlUrl({ subjectApiUrl, repoFullName }, host) {
  const [owner, repo] = String(repoFullName || '').split('/');
  if (!REPO_PART_RE.test(owner || '') || !REPO_PART_RE.test(repo || '')) return '';
  const repoUrl = `https://${webHostFor(host)}/${owner}/${repo}`;
  const prefix = `${apiPrefixFor(host)}${owner}/${repo}/`;
  if (typeof subjectApiUrl !== 'string' || !subjectApiUrl.startsWith(prefix)) return repoUrl;
  const [kind, id, ...rest] = subjectApiUrl.slice(prefix.length).split('/');
  if (rest.length || !/^[A-Za-z0-9]{1,64}$/.test(id || '')) return repoUrl;
  if (kind === 'releases') return `${repoUrl}/releases`;
  return SUBJECT_PATHS[kind] ? `${repoUrl}/${SUBJECT_PATHS[kind]}/${id}` : repoUrl;
}

const rawThreadSchema = z.object({
  id: z.string().regex(THREAD_ID_RE),
  unread: z.boolean(),
  reason: z.string().max(64),
  updated_at: z.string().datetime({ offset: true }),
  subject: z.object({
    title: z.string(),
    type: z.string().max(64),
    url: z.string().max(2000).nullable().optional(),
  }).passthrough(),
  repository: z.object({
    full_name: z.string().max(201),
    private: z.boolean().optional(),
    owner: z.object({ login: z.string().max(100) }).passthrough(),
  }).passthrough(),
}).passthrough();

/** A stored-shape record from one raw API thread, or null when malformed. */
export function toNotificationRecord(raw, host) {
  const parsed = rawThreadSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { id, unread, reason, updated_at: updatedAt, subject, repository } = parsed.data;
  const record = {
    threadId: id,
    repoFullName: repository.full_name,
    repoOwner: repository.owner.login,
    repoPrivate: repository.private === true,
    reason,
    subjectType: subject.type,
    subjectTitle: Array.from(subject.title).slice(0, MAX_TITLE_CHARS).join(''),
    subjectApiUrl: subject.url || null,
    unread,
    ghUpdatedAt: updatedAt,
  };
  return { ...record, htmlUrl: notificationHtmlUrl(record, host) };
}
