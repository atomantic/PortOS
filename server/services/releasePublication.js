import { readReleaseCandidate } from './releaseCandidateEvidence.js';
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


export async function verifyAgentReleasePublication(agentId, body) {
  const input = validateRequest(releasePublicationRequestSchema, body);
  const agent = await getAgentRecord(agentId);
  if (!agent || agent.status !== 'running' || agent.metadata?.taskAnalysisType !== 'do-release') {
    refuse('Publication evidence requires an active release coordinator');
  }
  if (agent.metadata.resumedFromAgentId && agent.metadata.releaseCandidateRecovery?.status !== 'transferred') {
    refuse('Interrupted candidate recovery must be verified before publication');
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
  const candidate = await readReleaseCandidate(candidateHead, cwd).catch(error => refuse(error.message));
  if (candidate.version !== input.version) refuse('Candidate version differs from the requested publication');
  const transfer = agent.metadata.releaseCandidateRecovery?.transfer;
  if (transfer && (transfer.branch !== pr.head.ref || transfer.candidate.cutoff !== candidate.cutoff
    || transfer.candidate.pin !== candidate.pin || transfer.candidate.releaseBase !== candidate.releaseBase
    || transfer.candidate.version !== candidate.version
    || (transfer.publication && transfer.publication.number !== input.promotionPrNumber))) {
    refuse('Publication differs from the recovered candidate');
  }
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
    ...(transfer && { recoveredPublisher: transfer.origin }),
    status: 'verified', synchronizationHandoffVersion: input.synchronizationMode === 'inline' ? 2 : 1,
    identity, repository, version: input.version, candidateHead,
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
  const synchronization = await ensureReleaseSynchronization(await getAgentRecord(agentId));
  return saved.synchronizationHandoffVersion === 2
    ? { ...saved, synchronizationPolicy: synchronization.policy }
    : saved;
}
