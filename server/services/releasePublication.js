import { createHash } from 'node:crypto';
import { execGit } from '../lib/execGit.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { releasePublicationRequestSchema } from '../lib/releasePublication.js';
import { execGh } from './github.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';
import { getAgentRecord, recordAgentReleasePublication } from './cosAgentLifecycle.js';

const SHA = /^[a-f0-9]{40}$/;
const refuse = (message) => { throw new ServerError(message, { status: 409, code: 'RELEASE_PUBLICATION_UNVERIFIED' }); };
const requireSha = (value) => SHA.test(value || '') ? value : refuse('Release evidence has an invalid commit or tree');
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

// Read only immutable object names. No fetch, checkout, tag mutation or commands
// taken from release/PR prose occur in the verification path.
async function readCandidate(head, cwd) {
  const git = async args => (await execGit(args, cwd)).stdout.trim();
  const pins = (await git(['log', '-1', '--format=%H', '--grep=^Release-Cut: ', head])).split('\n').filter(Boolean);
  if (pins.length !== 1) refuse('Expected exactly one recorded candidate cutoff');
  const pin = requireSha(pins[0]);
  const message = await git(['show', '-s', '--format=%B', pin]);
  const trailer = key => {
    const values = [...message.matchAll(new RegExp(`^${key}: (.+)$`, 'gm'))];
    if (values.length !== 1) refuse(`Candidate is missing a unique ${key} trailer`);
    return values[0][1];
  };
  const cutoff = requireSha(trailer('Release-Cut'));
  const releaseBase = requireSha(trailer('Release-Base'));
  const previousCommit = requireSha(trailer('Release-Previous-Commit'));
  const previousTag = trailer('Release-Previous-Tag');
  const parents = await git(['show', '-s', '--format=%P', pin]);
  if (parents !== cutoff) refuse('Candidate pin parent differs from its cutoff');
  const tree = async sha => requireSha(await git(['rev-parse', `${sha}^{tree}`]));
  if (await tree(pin) !== await tree(cutoff)) refuse('Candidate pin must be metadata only');
  for (const ancestor of [pin, releaseBase, previousCommit]) {
    const result = await execGit(['merge-base', '--is-ancestor', ancestor, head], cwd, { ignoreExitCode: true });
    if (result.exitCode !== 0) refuse('Candidate does not retain its recorded release ancestry');
  }
  const manifest = JSON.parse(await git(['show', `${head}:package.json`]));
  return { cutoff, pin, releaseBase, previousCommit, previousTag, version: manifest.version, tree: await tree(head) };
}

export async function verifyAgentReleasePublication(agentId, body) {
  const input = validateRequest(releasePublicationRequestSchema, body);
  const agent = await getAgentRecord(agentId);
  if (!agent || agent.status !== 'running' || agent.metadata?.taskAnalysisType !== 'do-release') {
    refuse('Publication evidence requires an active release coordinator');
  }
  const owner = { id: agent.id, taskId: agent.taskId, startedAt: agent.startedAt, metadata: { ...agent.metadata } };
  const cwd = agent.metadata.sourceWorkspace || agent.metadata.workspacePath;
  if (!cwd) refuse('Release coordinator has no registered repository');
  const origin = await getOriginInfo(cwd);
  if (!origin.isGithub || !origin.fullName || origin.host !== 'github.com') refuse('Release publication requires a GitHub repository');
  const repository = origin.fullName;
  const options = await resolveForgeExecOptions(cwd);
  const api = async path => JSON.parse(await execGh(['api', '--hostname', origin.host, `repos/${repository}/${path}`], undefined, options));
  const pr = await api(`pulls/${input.promotionPrNumber}`);
  if (pr.number !== input.promotionPrNumber || pr.merged !== true || !validTime(pr.merged_at)
    || pr.base?.ref !== 'release' || pr.base?.repo?.full_name !== repository
    || pr.head?.repo?.full_name !== repository) refuse('Promotion must be a merged same-repository release PR');
  const candidateHead = requireSha(pr.head.sha);
  if (typeof pr.head.ref !== 'string' || !pr.head.ref) refuse('Promotion candidate branch is unavailable');
  const promotionMerge = requireSha(pr.merge_commit_sha);
  const candidate = await readCandidate(candidateHead, cwd);
  if (candidate.version !== input.version) refuse('Candidate version differs from the requested publication');
  const tag = `v${input.version}`;
  const [release, run, promotion, ref] = await Promise.all([
    api(`releases/tags/${tag}`), api(`actions/runs/${input.workflowRunId}`),
    api(`git/commits/${promotionMerge}`), api(`git/ref/tags/${tag}`),
  ]);
  const tree = requireSha(promotion.tree?.sha);
  if (tree !== candidate.tree || promotion.parents?.length !== 2
    || promotion.parents[0].sha !== candidate.releaseBase || promotion.parents[1].sha !== candidateHead) {
    refuse('Promotion did not preserve the verified candidate head and tree');
  }
  const releaseUrl = `https://${origin.host}/${repository}/releases/tag/${tag}`;
  if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false
    || release.html_url !== releaseUrl || !validTime(release.published_at)) refuse('Release is not a published stable release in this repository');
  if (run.id !== input.workflowRunId || run.repository?.full_name !== repository
    || run.head_sha !== promotionMerge || run.head_branch !== 'release' || run.event !== 'push'
    || run.path !== '.github/workflows/release.yml' || run.status !== 'completed' || run.conclusion !== 'success') {
    refuse('Release workflow has not succeeded on the promotion merge');
  }
  if (ref.ref !== `refs/tags/${tag}`) refuse('Release tag reference is mismatched');
  let object = ref.object;
  for (let depth = 0; depth < 5 && object?.type === 'tag'; depth++) {
    object = (await api(`git/tags/${requireSha(object.sha)}`)).object;
  }
  if (object?.type !== 'commit') refuse('Release tag does not peel to a commit');
  const tagCommit = requireSha(object.sha);
  const tagTree = requireSha((await api(`git/commits/${tagCommit}`)).tree?.sha);
  if (tagTree !== tree) refuse('Release tag tree differs from the published candidate');
  const identity = createHash('sha256').update(JSON.stringify([origin.host, repository, tag, tagCommit, tree])).digest('hex');
  const receipt = {
    status: 'verified', synchronizationHandoffVersion: 1, identity, repository, version: input.version, candidateHead,
    candidateBranch: pr.head.ref,
    cutoff: candidate.cutoff, pin: candidate.pin, releaseBase: candidate.releaseBase,
    previousCommit: candidate.previousCommit, previousTag: candidate.previousTag,
    promotionPrNumber: input.promotionPrNumber, promotionMerge, tag, tagCommit, tagTree,
    releaseUrl, publishedAt: release.published_at, workflowRunId: run.id,
    workflowUrl: `https://${origin.host}/${repository}/actions/runs/${run.id}`,
    verifiedAt: new Date().toISOString(),
  };
  // Identity/owner checks and the write share the ordinary agent state lock.
  // Replays retain the original verification time; a competing release cannot
  // replace an earlier milestone or turn it into a terminal delivery verdict.
  const saved = await recordAgentReleasePublication(owner, receipt);
  const { ensureReleaseSynchronization } = await import('./releaseSynchronization.js');
  // A failed handoff never rolls back or overwrites verified publication.
  await ensureReleaseSynchronization(await getAgentRecord(agentId));
  return saved;
}
