/**
 * A targeted operator run may publish a deterministic patch defect as a
 * GitHub COMMENT review. It is not security clearance or a model review.
 */
import { execGh } from './github.js';
import { getSelfLogin } from './prWatcher.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { findAddedConflictMarkers, matchesConflictMarkerBlock } from '../lib/prConflictMarkers.js';
import { MODEL_ABUSE_GUARD_MAX_INPUT_CHARS } from '../lib/modelAbuseGuard.js';

const MARKER = '<!-- portos:unresolved-conflict-markers:v1 -->';
const active = new Set();

// The mutable PR diff discovers candidates; the Contents API at the immutable
// head in the contributor repository proves what belongs to the reviewed
// revision even if the PR head briefly changes between both open/head checks.
async function verifyAtHead({ runGh, hostname, headRepo, headRefOid, candidates }) {
  const confirmed = [];
  for (const candidate of candidates) {
    const endpoint = `repos/${headRepo}/contents/${candidate.path}?ref=${headRefOid}`;
    const file = safeJSONParse(await runGh(['api', '--hostname', hostname, endpoint]), null);
    const maxBytes = MODEL_ABUSE_GUARD_MAX_INPUT_CHARS;
    if (file?.type !== 'file' || file.path !== candidate.path || file.encoding !== 'base64'
      || !Number.isSafeInteger(file.size) || file.size > maxBytes || typeof file.content !== 'string'
      || file.content.length > maxBytes * 2) continue;
    const bytes = Buffer.from(file.content, 'base64');
    if (bytes.length === file.size && matchesConflictMarkerBlock(bytes.toString('utf8'), candidate)) confirmed.push(candidate);
  }
  return confirmed;
}

export async function publishConflictReview({ app, target, pr } = {}) {
  const { repoSpec, repoFullName, hostname, selfLogin, defaultBranch } = target ?? {};
  const { number, headRefOid } = pr ?? {};
  if (!hostname || !selfLogin || !repoSpec || !repoFullName || !defaultBranch
    || !Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{40}$/.test(headRefOid ?? '')) return 'unavailable';

  const key = JSON.stringify([repoSpec, selfLogin, number, headRefOid]);
  if (active.has(key)) return 'in-flight';
  active.add(key);
  try {
    const { cwd, env } = await resolveForgeExecOptions(app?.repoPath, { forgeAccount: app?.forgeAccount });
    const runGh = (args, input) => execGh(args, undefined, { cwd, env, ...(input ? { input } : {}) });
    const readCurrent = async () => safeJSONParse(await runGh([
      'pr', 'view', String(number), '--repo', repoSpec, '--json', 'state,headRefOid,baseRefName,headRepository',
    ]), null);
    const isCurrent = row => row?.state === 'OPEN' && row.headRefOid === headRefOid && row.baseRefName === defaultBranch;
    const current = await readCurrent();
    if (!isCurrent(current)) return 'changed';
    const headRepo = current.headRepository?.nameWithOwner;
    if (!/^[\w.-]+\/[\w.-]+$/.test(headRepo ?? '')) return 'unavailable';

    const endpoint = `repos/${repoFullName}/pulls/${number}/reviews`;
    const pages = safeJSONParse(await runGh([
      'api', '--hostname', hostname, '--paginate', '--slurp', endpoint,
    ]), null);
    if (!Array.isArray(pages) || !pages.length || !pages.every(Array.isArray)) return 'unavailable';
    if (pages.some(page => page.some(review => review?.commit_id === headRefOid
      && review.user?.login?.toLowerCase() === selfLogin.toLowerCase()
      && review.state === 'COMMENTED' && typeof review.body === 'string' && review.body.startsWith(MARKER)))) return 'already-posted';

    const diff = await runGh(['pr', 'diff', String(number), '--repo', repoSpec]);
    if (typeof diff !== 'string' || diff.length > MODEL_ABUSE_GUARD_MAX_INPUT_CHARS) return 'unavailable';
    const candidates = findAddedConflictMarkers(diff);
    if (!candidates.length) return 'changed';
    const findings = await verifyAtHead({ runGh, hostname, headRepo, headRefOid, candidates });
    if (!findings.length) return 'changed';
    const login = await getSelfLogin(hostname, { cwd, env });
    if (login?.toLowerCase() !== selfLogin.toLowerCase()) return 'unavailable';
    const latest = await readCurrent();
    if (!isCurrent(latest) || latest.headRepository?.nameWithOwner !== headRepo) return 'changed';

    const body = [
      MARKER,
      'I found lines matching a complete merge-conflict marker block in the reviewed revision:',
      ...findings.map(({ path, line }) => `- \`${path}\` (line ${line})`),
      '',
      'Please resolve the markers and request another review, or clarify if these lines are intentional test data. No full code review was performed.',
    ].join('\n');
    const posted = safeJSONParse(await runGh([
      'api', '--hostname', hostname, '--method', 'POST', endpoint, '--input', '-',
    ], JSON.stringify({ commit_id: headRefOid, body, event: 'COMMENT' })), null);
    return posted?.state === 'COMMENTED' && posted?.commit_id === headRefOid
      && posted?.user?.login?.toLowerCase() === selfLogin.toLowerCase() ? 'posted' : 'unavailable';
  } catch {
    return 'unavailable';
  } finally {
    active.delete(key);
  }
}
