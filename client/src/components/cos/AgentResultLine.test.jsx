import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import AgentResultLine, { ReleasePublicationLine, SecurityScanEvidence } from './AgentResultLine';

it('separates clean execution, assessment persistence and delivery validation', () => {
  const agent = { result: { success: true, validationPassed: false, auditAssessment: { status: 'persistence-failed' } } };
  const view = render(<AgentResultLine agent={agent} />);
  expect(screen.getByText('Execution completed')).toBeInTheDocument();
  expect(screen.getByText('Assessment could not be saved')).toBeInTheDocument();
  expect(screen.getByText('Delivery validation failed')).toBeInTheDocument();
  expect(screen.queryByText('Completed successfully')).not.toBeInTheDocument();
  view.rerender(<AgentResultLine agent={{ ...agent, metadata: { auditAssessment: { status: 'recorded' } } }} />);
  expect(screen.getByText('Assessment saved')).toBeInTheDocument();
  expect(screen.queryByText('Assessment could not be saved')).not.toBeInTheDocument();
  expect(screen.getByText('Delivery validation failed')).toBeInTheDocument();
  view.rerender(<AgentResultLine agent={{ result: { success: true, auditAssessment: { status: 'recorded' } }, metadata: { auditAssessment: { status: 'persistence-failed' } } }} />);
  expect(screen.getByText('Assessment saved')).toBeInTheDocument();
  expect(screen.queryByText('Assessment could not be saved')).not.toBeInTheDocument();
});

it('does not invent assessment or delivery validation for ordinary successful runs', () => {
  render(<AgentResultLine agent={{ result: { success: true, validationPassed: null } }} />);
  expect(screen.getByText('Execution completed')).toBeInTheDocument();
  expect(screen.queryByText('Assessment saved')).not.toBeInTheDocument();
  expect(screen.queryByText('Delivery validation failed')).not.toBeInTheDocument();
});


it('does not present blocked publication as completed delivery', () => {
  render(<AgentResultLine agent={{ result: { success: true, validationPassed: true }, metadata: { publicationValidation: { status: 'blocked', reason: 'pregate-nonzero' } } }} />);
  expect(screen.getByText('Execution completed')).toBeInTheDocument();
  expect(screen.getByText('Publication blocked; worktree preserved')).toBeInTheDocument();
  expect(screen.queryByText('Completed successfully')).not.toBeInTheDocument();
});


it('retains refusal and scanner interruption evidence alongside successful delivery and assessment', () => {
  render(<AgentResultLine agent={{ result: { success: true, auditAssessment: { status: 'recorded' } }, metadata: {
    executionInterruption: { category: 'content-refusal' },
    securityScan: { status: 'time-limit', model: 'example-model', effort: 'low', auth: 'chatgpt',
      estimatedCostUsd: null, maxCostUsd: 0, timeLimitSeconds: 600, exitCode: null,
      artifacts: { findings: true, coverage: null } },
  } }} />);
  expect(screen.getByText('Execution completed')).toBeInTheDocument();
  expect(screen.getByText('Assessment saved')).toBeInTheDocument();
  expect(screen.getByText(/provider safety refusal; automatic retry stopped/)).toBeInTheDocument();
  expect(screen.getByText('Security scanner (agent reported): time-limit')).toBeInTheDocument();
  expect(screen.getByText(/Estimated baseline: unknown · Estimate cap: \$0.00 \(API-equivalent USD\)/)).toBeInTheDocument();
  expect(screen.getByText('Short-context estimates do not measure billed charges or ChatGPT subscription quota.')).toBeInTheDocument();
  expect(screen.getByText(/Exit: unknown/)).toBeInTheDocument();
  expect(screen.getByText(/findings: saved; coverage: unknown/)).toBeInTheDocument();
});

it('shows runner observations during execution without requiring an agent completion summary', () => {
  render(<SecurityScanEvidence scanner={{ source: 'runner', status: 'interrupted', cleanup: 'unconfirmed', model: 'example-model', effort: 'medium', auth: 'chatgpt' }} />);
  expect(screen.getByText('Security scanner (runner observed): interrupted')).toBeInTheDocument();
  expect(screen.getByText('Process cleanup: unconfirmed')).toBeInTheDocument();
  expect(screen.queryByText('Completed successfully')).not.toBeInTheDocument();
});

it('shows the committed scanner baseline separately from later audit success', () => {
  render(<AgentResultLine agent={{ result: { success: true }, metadata: { securityScan: {
    source: 'runner', status: 'completed', baseline: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
  } } }} />);
  expect(screen.getByText(/Committed baseline:/)).toHaveTextContent('a'.repeat(40));
  expect(screen.getByText(/Committed baseline:/)).toHaveTextContent('Uncommitted files and submodules excluded');
  expect(screen.getByText(/Committed baseline:/)).toHaveTextContent('Subsequent repairs are not certified');
});

it('distinguishes explicit unlimited grants from unknown, zero and saved bounded limits', () => {
  const scanner = { source: 'runner', status: 'running', auth: 'chatgpt', maxCostUsd: 'unlimited', timeLimitSeconds: 'unlimited' };
  const view = render(<SecurityScanEvidence scanner={scanner} />);
  expect(screen.getByText(/Time limit: none \(no elapsed-time deadline\)/)).toBeInTheDocument();
  expect(screen.getByText(/Estimate cap: none \(no estimate cap\)/)).toBeInTheDocument();
  view.rerender(<SecurityScanEvidence scanner={{ ...scanner, maxCostUsd: null, timeLimitSeconds: null }} />);
  expect(screen.getByText(/Estimate cap: unknown/)).toBeInTheDocument();
  expect(screen.getByText(/Time limit: unknown/)).toBeInTheDocument();
  view.rerender(<SecurityScanEvidence scanner={{ ...scanner, maxCostUsd: 0, timeLimitSeconds: 0 }} />);
  expect(screen.getByText(/Estimate cap: \$0.00/)).toBeInTheDocument();
  expect(screen.getByText(/Time limit: 0s/)).toBeInTheDocument();
  view.rerender(<SecurityScanEvidence scanner={{ ...scanner, maxCostUsd: 25, timeLimitSeconds: 1200 }} />);
  expect(screen.getByText(/Estimate cap: \$25.00/)).toBeInTheDocument();
  expect(screen.getByText(/Time limit: 1,200s/)).toBeInTheDocument();
});

it('distinguishes connection loss from the last trusted runner observation', () => {
  render(<SecurityScanEvidence scanner={{ source: 'runner', status: 'running', auth: 'chatgpt' }} control={{ status: 'interrupted', cleanup: 'unconfirmed' }} />);
  expect(screen.getByText(/interrupted \(runner connection lost\)/)).toBeInTheDocument();
  expect(screen.getByText('Process cleanup: unconfirmed')).toBeInTheDocument();
});

it('keeps input rejection history visible after a corrected scanner execution completes', () => {
  const scanner = { source: 'runner', status: 'invalid-input', auth: 'chatgpt',
    preflight: { rejectedRequests: 1, lastError: { field: 'paths', index: 2, code: 'path-not-found' } } };
  const view = render(<SecurityScanEvidence scanner={scanner} />);
  expect(screen.getByText('Input rejected before scanner launch')).toBeInTheDocument();
  expect(screen.getByText('Input rejections: 1 · Last: paths item 3 — path-not-found')).toBeInTheDocument();
  view.rerender(<SecurityScanEvidence scanner={{ ...scanner, status: 'completed' }} />);
  expect(screen.getByText('Security scanner (runner observed): completed')).toBeInTheDocument();
  expect(screen.queryByText('Input rejected before scanner launch')).not.toBeInTheDocument();
  expect(screen.getByText('Input rejections: 1 · Last: paths item 3 — path-not-found')).toBeInTheDocument();
});


it('does not promote historical cleanup process success to verified cleanup', () => {
  const agent = { result: { success: true }, metadata: { recoveryOrigin: { subsystem: 'repository-cleanup' } } };
  const view = render(<AgentResultLine agent={agent} />);
  expect(screen.getByText('Execution completed')).toBeInTheDocument();
  expect(screen.getByText('Local worktree cleanup is pending.')).toBeInTheDocument();
  expect(screen.queryByText('Completed successfully')).not.toBeInTheDocument();
  view.rerender(<AgentResultLine agent={{ ...agent, metadata: { ...agent.metadata, cleanupOutcome: { status: 'already-absent', reason: 'already-absent' } } }} />);
  expect(screen.getByText('Local worktree already removed.')).toBeInTheDocument();
  expect(screen.queryByText('Completed successfully')).not.toBeInTheDocument();
  view.rerender(<AgentResultLine agent={{ ...agent, metadata: { ...agent.metadata, cleanupOutcome: { status: 'verified' } } }} />);
  expect(screen.getByText('Execution completed')).toBeInTheDocument();
});

it('names the live runs a claim-owner cleanup hold is waiting on', async () => {
  const { MemoryRouter } = await import('react-router');
  const cleanupOutcome = { status: 'blocked', reason: 'claim-owner-ambiguous', owners: ['agent-aaa', 'agent-bbb'] };
  render(<MemoryRouter><AgentResultLine agent={{ result: { success: true }, metadata: { cleanupOutcome } }} /></MemoryRouter>);
  const first = screen.getByRole('link', { name: 'agent-aaa' });
  expect(first.closest('div')).toHaveTextContent('Next: wait for the current owner to finish. — waiting on live runs agent-aaa, agent-bbb');
  expect(first).toHaveAttribute('href', '/cos/agents/agent-aaa');
  expect(screen.getByRole('link', { name: 'agent-bbb' })).toHaveAttribute('href', '/cos/agents/agent-bbb');
});


it('renders delivery separately from normal execution, including historical prose', () => {
  const agent = { result: { success: true }, metadata: { taskSummary: 'Status: BLOCKED - invented contradictory instructions' } };
  const view = render(<AgentResultLine agent={agent} />);
  expect(screen.getByText('Execution completed')).toBeInTheDocument();
  expect(screen.queryByText('Completed successfully')).not.toBeInTheDocument();
  for (const [status, label] of [['blocked', 'Task blocked'], ['incomplete', 'Task incomplete'], ['no-action-needed', 'No action needed'], ['completed', 'Completed successfully']]) {
    view.rerender(<AgentResultLine agent={{ result: { success: true, executionSuccess: true, taskOutcome: { status, reason: 'Invented evidence.' } } }} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText('Invented evidence.')).toBeInTheDocument();
  }
});


it('separates merged delivery from pending, verified, absent and blocked cleanup without exposing codes in the primary summary', async () => {
  const { MemoryRouter } = await import('react-router');
  const record = { result: { success: true, cleanupPending: true, taskOutcome: { status: 'completed', reason: 'Historical cleanup queued.' } },
    metadata: { cleanupOutcome: { status: 'pending', reason: 'cognitive-review-pending', committedIntegrationVerified: true, taskId: 'cleanup-example' } } };
  const view = render(<MemoryRouter><AgentResultLine agent={record} /></MemoryRouter>);
  expect(screen.getByText('Code merged.')).toBeInTheDocument();
  expect(screen.getByText('Execution completed')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'cleanup recovery task' })).toHaveAttribute('href', '/cos/tasks?task=cleanup-example&source=internal');
  expect(screen.queryByText('Historical cleanup queued.')).not.toBeInTheDocument();
  for (const [status, reason, message] of [
    ['verified', 'retirement-receipt-verified', 'Local worktree cleaned up.'],
    ['verified', 'already-absent-merged', 'Local worktree already removed; merged delivery confirmed.'],
    ['already-absent', 'already-absent', 'Local worktree already removed; merged delivery confirmed.'],
    ['blocked', 'retirement-review-unavailable', 'Local worktree cleanup is pending.'],
  ]) {
    view.rerender(<MemoryRouter><AgentResultLine agent={{ ...record, metadata: { cleanupOutcome: { status, reason, committedIntegrationVerified: true } } }} /></MemoryRouter>);
    expect(screen.getByText('Code merged.')).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
    const diagnostic = screen.getByText(new RegExp(reason));
    expect(diagnostic.closest('details')).not.toHaveAttribute('open');
    expect(screen.queryByText('Historical cleanup queued.')).not.toBeInTheDocument();
    if (status === 'verified' || status === 'already-absent') expect(screen.getByText('Completed successfully')).toBeInTheDocument();
    else expect(screen.queryByText('Completed successfully')).not.toBeInTheDocument();
    if (status !== 'verified' && status !== 'already-absent') expect(screen.getByText('Execution completed')).toBeInTheDocument();
  }
});

it('shows clean worktree removal without claiming merged delivery when no PR was merged', () => {
  render(<AgentResultLine agent={{ result: { success: true }, metadata: { cleanupOutcome: { status: 'already-absent', reason: 'already-absent' } } }} />);
  expect(screen.getByText('Local worktree cleaned up.')).toBeInTheDocument();
  expect(screen.getByText('Local worktree already removed.')).toBeInTheDocument();
  expect(screen.queryByText('Code merged.')).not.toBeInTheDocument();
  expect(screen.queryByText('Code delivery still needs verification.')).not.toBeInTheDocument();
});

it('shows the verified assigned PR without claiming later local work was delivered or preserved', () => {
  const prUrl = 'https://github.com/example/repo/pull/42';
  const agent = { result: { success: true, executionSuccess: true, cleanupPending: true,
    taskOutcome: { status: 'no-action-needed', reason: 'The assigned review target is merged.' } }, metadata: {
    taskOutcomeSource: 'forge-verification', reviewLoopMergeTarget: { url: prUrl, branch: 'example' },
    mergedReviewFollowUp: { status: 'verified', prUrl }, cleanupOutcome: { status: 'blocked', reason: 'worktree-dirty' },
  } };
  const view = render(<AgentResultLine agent={agent} />);
  expect(screen.getByText('Assigned pull request merged.')).toBeInTheDocument();
  expect(screen.getByText('Later local work may still need delivery verification.')).toBeInTheDocument();
  expect(screen.getByText('Local worktree cleanup is pending.')).toBeInTheDocument();
  expect(screen.queryByText('Delivery verified.')).not.toBeInTheDocument();
  expect(screen.queryByText('Completed successfully')).not.toBeInTheDocument();

  view.rerender(<AgentResultLine agent={{ ...agent, result: { ...agent.result, success: false,
    taskOutcome: { status: 'incomplete', reason: 'Cleanup is pending.', recovery: { mode: 'cleanup' } } } }} />);
  expect(screen.getByText('Task incomplete')).toBeInTheDocument();
  expect(screen.getByText('Assigned pull request merged.')).toBeInTheDocument();
  expect(screen.getByText('Later local work may still need delivery verification.')).toBeInTheDocument();

  view.rerender(<AgentResultLine agent={{ ...agent, metadata: { ...agent.metadata,
    cleanupOutcome: { status: 'blocked', reason: 'absent-checkout-settlement-unverified', committedIntegrationVerified: true } } }} />);
  expect(screen.getByText('Assigned pull request merged.')).toBeInTheDocument();
  expect(screen.getByText('Later local work may still need delivery verification.')).toBeInTheDocument();
  expect(screen.getByText('Local worktree cleanup is pending.')).toBeInTheDocument();
  expect(screen.queryByText('Code merged.')).not.toBeInTheDocument();

  for (const metadata of [
    { ...agent.metadata, mergedReviewFollowUp: { status: 'verified', prUrl: 'https://github.com/example/repo/pull/99' } },
    { ...agent.metadata, mergedReviewFollowUp: { status: 'unverified', prUrl } },
    { ...agent.metadata, taskOutcomeSource: 'sentinel' },
    { ...agent.metadata, reviewLoopMergeTarget: null },
  ]) {
    view.rerender(<AgentResultLine agent={{ ...agent, result: { ...agent.result, success: false }, metadata }} />);
    expect(screen.queryByText('Assigned pull request merged.')).not.toBeInTheDocument();
    expect(screen.getByText('Cleanup pending.')).toBeInTheDocument();
  }

  view.rerender(<AgentResultLine agent={{ ...agent, metadata: { ...agent.metadata,
    cleanupOutcome: { status: 'verified', committedIntegrationVerified: true } } }} />);
  expect(screen.getByText('Code merged.')).toBeInTheDocument();
  expect(screen.getByText('Local worktree cleaned up.')).toBeInTheDocument();
  expect(screen.queryByText('Later local work may still need delivery verification.')).not.toBeInTheDocument();
});

it('lets verified current cleanup supersede a stale cleanup-only handoff even without merged PR', () => {
  const record = { result: { success: false, executionSuccess: true, cleanupPending: true,
    taskOutcome: { status: 'incomplete', reason: 'Historical cleanup queued.', recovery: { mode: 'cleanup' } } },
    metadata: { cleanupOutcome: { status: 'verified', reason: 'already-absent-merged', committedIntegrationVerified: true } } };
  const view = render(<AgentResultLine agent={record} />);
  expect(screen.getByText('Completed successfully')).toBeInTheDocument();
  expect(screen.getByText('Code merged.')).toBeInTheDocument();
  expect(screen.getByText('Local worktree already removed; merged delivery confirmed.')).toBeInTheDocument();
  expect(screen.queryByText('Task incomplete')).not.toBeInTheDocument();
  view.rerender(<AgentResultLine agent={{ ...record, metadata: { cleanupOutcome: { status: 'already-absent', reason: 'already-absent' } } }} />);
  expect(screen.getByText('Completed successfully')).toBeInTheDocument();
  expect(screen.getByText('Local worktree cleaned up.')).toBeInTheDocument();
  expect(screen.queryByText('Task incomplete')).not.toBeInTheDocument();
  view.rerender(<AgentResultLine agent={{ ...record, result: { ...record.result,
    taskOutcome: { status: 'blocked', reason: 'Choose whether to publish the release.', recovery: { mode: 'approval' } } } }} />);
  expect(screen.getByText('Task blocked')).toBeInTheDocument();
  expect(screen.getByText('Choose whether to publish the release.')).toBeInTheDocument();
  expect(screen.queryByText('Completed successfully')).not.toBeInTheDocument();
});

it('does not settle other branch cleanup from one historical merged-and-absent branch', () => {
  render(<AgentResultLine agent={{ result: { success: true, cleanupPending: true,
    taskOutcome: { status: 'completed', reason: 'Code merged.' } }, metadata: {
    cleanupOutcome: { status: 'already-absent', committedIntegrationVerified: true, total: 2, unresolved: 2 },
  } }} />);
  expect(screen.getByText('Execution completed')).toBeInTheDocument();
  expect(screen.getByText('Other repository cleanup is pending.')).toBeInTheDocument();
  expect(screen.queryByText('Completed successfully')).not.toBeInTheDocument();
});

it('retains a cleanup-only task hold when another branch obligation is unresolved', () => {
  const agent = { result: { success: true, executionSuccess: true, cleanupPending: true,
    taskOutcome: { status: 'incomplete', reason: 'Cleanup verification remains pending.', recovery: { mode: 'cleanup' } } }, metadata: {
    cleanupOutcome: { status: 'verified', committedIntegrationVerified: true, total: 2, unresolved: 1 },
  } };
  render(<AgentResultLine agent={agent} />);
  expect(screen.getByText('Task incomplete')).toBeInTheDocument();
  expect(screen.queryByText('Completed successfully')).not.toBeInTheDocument();
});

it('shows verified eventual delivery instead of the earlier pre-merge contention verdict', () => {
  const agent = { result: { success: false, executionSuccess: true,
    taskOutcome: { status: 'incomplete', reason: 'Earlier main movement.' } }, metadata: {
    repoStateVerification: { status: 'completed', deliveryVerified: true },
    cleanupOutcome: { status: 'verified', reason: 'already-absent-merged', committedIntegrationVerified: true },
  } };
  const view = render(<AgentResultLine agent={agent} />);
  expect(screen.getByText('Completed successfully')).toBeInTheDocument();
  expect(screen.queryByText('Task incomplete')).not.toBeInTheDocument();
  view.rerender(<AgentResultLine agent={{ ...agent, metadata: { ...agent.metadata,
    cleanupOutcome: { status: 'blocked', committedIntegrationVerified: true } } }} />);
  expect(screen.getByText('Task incomplete')).toBeInTheDocument();
  expect(screen.queryByText('Completed successfully')).not.toBeInTheDocument();
});

it('shows verified publication before any terminal result and retains it after synchronization fails', () => {
  const publication = { status: 'verified', tag: 'v1.2.3', releaseUrl: 'https://github.com/example/repo/releases/tag/v1.2.3', publishedAt: '2026-01-01T12:00:00Z' };
  const agent = { status: 'running', metadata: { releasePublication: publication } };
  const view = render(<AgentResultLine agent={agent} />);
  expect(screen.getByText('Published — synchronization not yet verified')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'v1.2.3' })).toHaveAttribute('href', publication.releaseUrl);
  expect(view.container.querySelector('time')).toHaveAttribute('datetime', publication.publishedAt);
  expect(screen.queryByText('Completed successfully')).not.toBeInTheDocument();
  view.rerender(<AgentResultLine agent={{ ...agent, result: { success: false, error: 'Synchronization failed' } }} />);
  expect(screen.getByText('Published — synchronization not yet verified')).toBeInTheDocument();
  expect(screen.getByText('Synchronization failed')).toBeInTheDocument();
});

it('keeps publication unchanged while synchronization moves through pending, running, blocked, and verified', () => {
  const identity = 'e'.repeat(64);
  const publication = { status: 'verified', tag: 'v2.0.0', releaseUrl: 'https://github.com/example/repo/releases/tag/v2.0.0', publishedAt: '2026-01-01T15:00:00Z' };
  const prUrl = 'https://github.com/example/repo/pull/100';
  const headSha = 'f'.repeat(40);

  // 1. Pending
  const agent = {
    status: 'running',
    metadata: {
      releasePublication: publication,
      releaseSynchronization: { status: 'pending', identity, prUrl, headSha },
    },
  };
  const view = render(<AgentResultLine agent={agent} />);
  expect(screen.getByText('Published — synchronization pending')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'v2.0.0' })).toHaveAttribute('href', publication.releaseUrl);
  expect(view.container.querySelector('time')).toHaveAttribute('datetime', publication.publishedAt);
  expect(screen.getByText(`Release sync: ${identity}`)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Sync PR (fffffff)' })).toHaveAttribute('href', prUrl);

  // 2. Running
  view.rerender(<AgentResultLine agent={{
    ...agent,
    metadata: {
      ...agent.metadata,
      releaseSynchronization: { status: 'running', identity, prUrl, headSha },
    },
  }} />);
  expect(screen.getByText('Published — synchronization running')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'v2.0.0' })).toHaveAttribute('href', publication.releaseUrl);
  expect(view.container.querySelector('time')).toHaveAttribute('datetime', publication.publishedAt);
  expect(screen.getByText(`Release sync: ${identity}`)).toBeInTheDocument();

  // 3. Blocked
  view.rerender(<AgentResultLine agent={{
    ...agent,
    metadata: {
      ...agent.metadata,
      releaseSynchronization: { status: 'blocked', identity, prUrl, headSha, blocker: 'head-ci-not-green-at-merge', nextAction: 'Inspect the original evidence.' },
    },
  }} />);
  expect(screen.getByText('Published — synchronization blocked')).toBeInTheDocument();
  expect(screen.getByText('Blocker: head-ci-not-green-at-merge')).toBeInTheDocument();
  expect(screen.getByText('Next action: Inspect the original evidence.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'v2.0.0' })).toHaveAttribute('href', publication.releaseUrl);
  expect(view.container.querySelector('time')).toHaveAttribute('datetime', publication.publishedAt);
  expect(screen.getByText(`Release sync: ${identity}`)).toBeInTheDocument();

  // 4. Verified
  view.rerender(<AgentResultLine agent={{
    ...agent,
    result: { success: true, validationPassed: true, taskOutcome: { status: 'completed', reason: 'Done' } },
    metadata: {
      ...agent.metadata,
      releaseSynchronization: { status: 'verified', identity, prUrl, headSha },
    },
  }} />);
  expect(screen.getByText('Published — synchronization verified')).toBeInTheDocument();
  expect(screen.getByText('Completed successfully')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'v2.0.0' })).toHaveAttribute('href', publication.releaseUrl);
  expect(view.container.querySelector('time')).toHaveAttribute('datetime', publication.publishedAt);
  expect(screen.getByText(`Release sync: ${identity}`)).toBeInTheDocument();
});

it('does not synthesize verified synchronization from task execution success or terminal prose', () => {
  const identity = 'a'.repeat(64);
  const publication = { status: 'verified', tag: 'v1.0.0', releaseUrl: 'https://github.com/example/repo/releases/tag/v1.0.0', publishedAt: '2026-01-01T10:00:00Z' };
  const agent = {
    result: { success: true, validationPassed: true, taskOutcome: { status: 'completed', reason: 'Synchronization completed in PR 42' } },
    metadata: {
      releasePublication: publication,
      releaseSynchronization: { status: 'running', identity },
      taskSummary: 'Completed synchronization of release v1.0.0',
    },
  };
  render(<AgentResultLine agent={agent} />);
  expect(screen.getByText('Published — synchronization running')).toBeInTheDocument();
  expect(screen.queryByText('Published — synchronization verified')).not.toBeInTheDocument();
  expect(screen.getByText('Execution completed')).toBeInTheDocument();
  expect(screen.queryByText('Completed successfully')).not.toBeInTheDocument();
});

it('does not claim publication from synchronization metadata without a verified receipt', () => {
  const sync = { identity: 'a'.repeat(64), status: 'running', tag: 'v1.2.3', releaseUrl: 'https://github.com/example/repo/releases/tag/v1.2.3', publishedAt: '2026-01-01T12:00:00Z' };
  const view = render(<ReleasePublicationLine synchronization={sync} />);
  expect(screen.getByText('Publication not verified — synchronization running')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'v1.2.3' })).not.toBeInTheDocument();
  expect(view.container.querySelector('time')).toBeNull();
  view.rerender(<ReleasePublicationLine publication={{ status: 'pending', tag: sync.tag, releaseUrl: sync.releaseUrl }} synchronization={sync} />);
  expect(screen.getByText('Publication not verified — synchronization running')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'v1.2.3' })).not.toBeInTheDocument();
  view.rerender(<ReleasePublicationLine publication={{ status: 'verified', tag: sync.tag, releaseUrl: sync.releaseUrl }} synchronization={sync} />);
  expect(screen.getByText('Published — synchronization running')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'v1.2.3' })).toHaveAttribute('href', sync.releaseUrl);
});
