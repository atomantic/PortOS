/** Git/GitHub own release activity. Historical recovery metadata is not a lock. */
import { execGit } from '../lib/execGit.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { currentTaskTypeName } from '../lib/taskTypeRenames.js';
import { execGh } from './github.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';

const releaseTypes = new Set(['do-release', 'release-sync']);
const unfinished = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];
const repository = agent => agent.sourceWorkspace || agent.metadata?.sourceWorkspace || agent.workspacePath || agent.metadata?.workspacePath;
const commonDirectory = async cwd => (await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)).stdout.trim();

/** Called at dispatch and again when reserving a candidate. Read failures refuse
 * this attempt; they never persist a hold requiring an operator to retire it. */
export async function releasePreflight({ repoPath, agentId, agents, version, forgeAccount = null, continuingPublication = false }) {
  if (!repoPath) return { ok: false, reason: 'release-repository-unavailable' };
  const common = await commonDirectory(repoPath);
  const origin = await getOriginInfo(repoPath);
  if (!origin.isGithub || !origin.fullName) return { ok: false, reason: 'release-forge-unavailable' };
  if (!agents) {
    const { readClaimOwnershipAgents } = await import('./cosClaimOwnershipState.js');
    agents = await readClaimOwnershipAgents();
  }
  if (!agents) return { ok: false, reason: 'release-ownership-unavailable' };
  const { getActiveAgentIds } = await import('./agentState.js');
  const active = new Set(getActiveAgentIds());
  if ([...active].some(id => id !== agentId && !agents.some(agent => agent.id === id))) {
    return { ok: false, reason: 'release-ownership-unavailable' };
  }
  for (const agent of agents) {
    if (agent.id === agentId || !releaseTypes.has(currentTaskTypeName(agent.metadata?.taskAnalysisType || agent.metadata?.analysisType))
      || (agent.status === 'completed' && !active.has(agent.id))) continue;
    const path = repository(agent);
    if (!path) return { ok: false, reason: 'release-ownership-unavailable' };
    const other = await getOriginInfo(path);
    if (await commonDirectory(path) === common || (other.host === origin.host && other.fullName?.toLowerCase() === origin.fullName.toLowerCase())) {
      return { ok: false, reason: 'release-agent-active' };
    }
  }
  const options = await resolveForgeExecOptions(repoPath, { forgeAccount });
  const api = async path => JSON.parse(await execGh(['api', '--hostname', origin.host, `repos/${origin.fullName}/${path}`], undefined, options));
  const pulls = await api('pulls?state=open&base=release&per_page=1');
  if (!Array.isArray(pulls)) throw new Error('Invalid release promotion response');
  if (pulls.length) return { ok: false, reason: 'release-promotion-active' };
  if (!continuingPublication) {
    const proposedVersion = version ?? JSON.parse((await execGit(['show', 'HEAD:package.json'], repoPath)).stdout).version;
    if (!/^\d+\.\d+\.\d+$/.test(proposedVersion || '')) throw new Error('Invalid proposed release version');
    const tag = `refs/tags/v${proposedVersion}`;
    const tags = await api(`git/matching-refs/tags/v${proposedVersion}`);
    if (!Array.isArray(tags)) throw new Error('Invalid release tag response');
    if (tags.some(row => row.ref === tag)) return { ok: false, reason: 'release-tag-present' };
  }
  // Status queries cover old workflow re-runs too, regardless of creation order.
  for (const status of unfinished) {
    const runs = await api(`actions/workflows/release.yml/runs?status=${status}&per_page=1`);
    if (!Number.isSafeInteger(runs.total_count) || runs.total_count < 0) throw new Error('Invalid release workflow response');
    if (runs.total_count) return { ok: false, reason: 'release-workflow-active' };
  }
  return { ok: true };
}
