import { buildQueuedTask } from '../services/cosTaskIntake.js';
import { generateTasksMarkdown, parseTasksMarkdown } from './taskParser.js';
import { describe, it, expect } from 'vitest';
import { buildAgentRegistration } from './agentRegistrationRecord.js';

// `agent.metadata` is a hand-picked projection of `task.metadata`, never a spread,
// so a field nobody lists simply does not survive the spawn — the failure mode the
// module header records (`quotaBurnStepId`, #6406). These pin the one field whose
// absence is invisible at spawn time and only shows up as a missing link in the UI.
const args = (taskMetadata, provider = { id: 'claude', command: 'claude' }) => ({
  task: { id: 'task-1', description: 'do the thing', taskType: 'user', priority: 'normal', metadata: taskMetadata },
  provider,
  instanceId: 'instance-1',
  workspacePath: '/tmp/ws',
  sourceWorkspace: null,
  primaryCheckoutBaseline: null,
  worktreeInfo: null,
  explicitWorktree: false,
  jiraBranchName: null,
  providerEndpoint: null,
  localPromptBudget: null,
  leanMode: false,
  prOpenedBy: 'portos',
  claimFlowTask: false,
  selectedModel: 'opus',
  modelSelection: { tier: 'heavy', reason: 'pinned' },
  runId: 'run-1',
  dispatchUseRunner: false,
  executionMode: 'direct',
  publicReviewPosture: null,
  resolvedAppName: null,
});

describe('buildAgentRegistration — resume provenance', () => {
  it('projects the predecessor this run took over from', () => {
    // Stamped on the task by `resolveTaskResumePatch` when Resume/Relaunch
    // requeues a paused task in place. The predecessor is retired as a HANDOFF
    // rather than a failure (lib/agentOutcome.js); without this projection the
    // card that inherited its worktree cannot say what it is continuing.
    const record = buildAgentRegistration(args({ resumedFromAgentId: 'agent-predecessor' }));
    expect(record.resumedFromAgentId).toBe('agent-predecessor');
  });

  it('projects an explicit null for an ordinary first run', () => {
    // Not `undefined`: the key has to exist so a reader can tell "no predecessor"
    // from "record written before this field shipped".
    expect(buildAgentRegistration(args({})).resumedFromAgentId).toBeNull();
  });
});

it('retains recovery lineage and the persisted boolean marker through task markdown', () => {
  const recoveryOrigin = { parentAgentId: 'agent-parent', parentTaskId: 'task-parent', subsystem: 'repository-cleanup',
    attempt: 2, observation: 'a'.repeat(64), noProgress: true };
  const queued = buildQueuedTask({ description: 'Synthetic cleanup', isRecovery: true, metadata: { recoveryOrigin } }, 'user');
  const parsed = parseTasksMarkdown(generateTasksMarkdown([queued]));
  const task = parsed[0];
  expect(task.metadata.isRecovery).toBe('true');
  const record = buildAgentRegistration({ ...args({}), task });
  expect(record).toMatchObject({ isRecovery: true, recoveryOrigin });
});

it('projects non-secret provider route provenance for active and archived cards', () => {
  const record = buildAgentRegistration(args({}, {
    id: 'claude-ollama',
    name: 'Claude Ollama',
    type: 'cli',
    command: 'claude',
    method: 'cli',
    harnessId: 'claude',
    serviceId: 'ollama',
    servicePlan: 'local',
    credentialBootstrapId: 'example-auth',
    credentialBootstrap: { command: 'example-auth' },
    envVars: { EXAMPLE_SECRET: 'must-not-be-copied' },
  }));

  expect(record).toMatchObject({
    providerId: 'claude-ollama',
    providerName: 'Claude Ollama',
    providerType: 'cli',
    providerMethod: 'cli',
    harnessId: 'claude',
    serviceId: 'ollama',
    servicePlan: 'local',
    providerCredentialBootstrapId: 'example-auth',
    providerHasCredentialBootstrap: true,
  });
  expect(record).not.toHaveProperty('envVars');
  expect(record).not.toHaveProperty('credentialBootstrap');
});

it('preserves scheduled reconciliation identity through persistence and registration', () => {
  const queued = buildQueuedTask({ description: 'Reconcile named branches', metadata: {
    analysisType: 'branch-reconcile', useWorktree: false, openPR: false,
  } }, 'internal');
  const [task] = parseTasksMarkdown(generateTasksMarkdown([queued]));
  const record = buildAgentRegistration({ ...args({}), task });
  expect(task.metadata.analysisType).toBe('branch-reconcile');
  expect(record.taskAnalysisType).toBe('branch-reconcile');
  expect(record.isWorktree).toBe(false);
});

describe('buildAgentRegistration — claim ownership', () => {
  // The claim tree is cut by the agent, so a relaunch can only see who holds it
  // from the branch the run registered here.
  it('registers the exact branch a pinned claim run owns', () => {
    const record = buildAgentRegistration({ ...args({ claimFlow: true, claimTarget: '42' }), claimFlowTask: true });
    expect(record.claimBranch).toBe('claim/issue-42');
    expect(record.claimPicksOwnBranch).toBe(false);
  });

  it('registers an unpinned claim run (swarm orchestrator) as picking its own branch', () => {
    const record = buildAgentRegistration({ ...args({ claimFlow: true, swarmCount: 3 }), claimFlowTask: true });
    expect(record.claimBranch).toBeNull();
    expect(record.claimPicksOwnBranch).toBe(true);
  });

  it('registers no claim ownership for an ordinary task', () => {
    const record = buildAgentRegistration(args({}));
    expect(record.claimBranch).toBeUndefined();
    expect(record.claimPicksOwnBranch).toBeUndefined();
  });
});
