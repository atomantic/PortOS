import { readFile } from 'fs/promises';
import { join } from 'path';
import { getAgentRecord, updateAgent } from './cosAgentLifecycle.js';
import { getAgentDir } from './cosAgentIndex.js';
import { requestSecurityScanViaRunner } from './cosRunnerClient.js';
import { parseRunnerSecurityScanEvidence } from '../lib/securityScanEvidence.js';
import { ServerError } from '../lib/errorHandler.js';

export async function persistAgentSecurityScan(agentId, value) {
  const evidence = parseRunnerSecurityScanEvidence(value);
  if (!evidence) return null;
  const terminal = !['not-run', 'running'].includes(evidence.status);
  const executionInterruption = evidence.status === 'refused'
    ? { category: 'content-refusal', source: 'security-scanner', at: new Date().toISOString() } : null;
  const updated = await updateAgent(agentId, { metadata: { securityScan: evidence, ...(terminal ? { securityScanControl: null } : {}), ...(executionInterruption ? { executionInterruption } : {}) } });
  return updated?.metadata?.securityScan || evidence;
}

async function readSavedEvidence(agent) {
  const date = agent.completedAt?.slice(0, 10);
  for (const dir of [getAgentDir(agent.id, date), getAgentDir(agent.id)]) {
    const value = await readFile(join(dir, 'security-scan.json'), 'utf8').then(JSON.parse).catch(() => null);
    const evidence = parseRunnerSecurityScanEvidence(value);
    if (evidence) return evidence;
  }
  return parseRunnerSecurityScanEvidence(agent.metadata?.securityScan);
}

// Called before every completion, including user termination and recovery.
// The runner file is a recovery receipt inside the existing agent archive;
// the ordinary agent metadata remains the card's authoritative record.
export async function settleAgentSecurityScan(agentId) {
  const agent = await getAgentRecord(agentId);
  if (!agent || agent.metadata?.taskAnalysisType !== 'security' || !agent.metadata?.useRunner) return null;
  let evidence;
  let unreachable = false;
  try { evidence = (await requestSecurityScanViaRunner(agentId, { stop: true })).evidence; }
  catch (err) { unreachable = true; console.warn(`⚠️ Scanner cleanup could not be confirmed for ${agentId} (${err.status || 'runner-unreachable'})`); }
  evidence = parseRunnerSecurityScanEvidence(evidence) || await readSavedEvidence(agent);
  if (unreachable && evidence?.status === 'running') {
    // Connection loss is a server observation, never a forged runner revision.
    await updateAgent(agentId, { metadata: { securityScanControl: { status: 'interrupted', cleanup: 'unconfirmed' } } });
    return { ...evidence, status: 'interrupted', cleanup: 'unconfirmed' };
  }
  return evidence ? persistAgentSecurityScan(agentId, evidence) : null;
}

export async function runAgentSecurityScan(agentId, input) {
  const agent = await getAgentRecord(agentId);
  if (!agent || agent.status !== 'running' || agent.metadata?.taskAnalysisType !== 'security' || !agent.metadata?.useRunner) {
    throw new ServerError('Security scanner requires its active runner-owned audit', { status: 409 });
  }
  const result = await requestSecurityScanViaRunner(agentId, { input });
  await persistAgentSecurityScan(agentId, result.evidence);
  return result;
}
