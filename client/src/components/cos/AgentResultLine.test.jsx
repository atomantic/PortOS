import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import AgentResultLine, { SecurityScanEvidence } from './AgentResultLine';

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
  expect(screen.getByText('Cleanup unverified/pending')).toBeInTheDocument();
  expect(screen.queryByText('Completed successfully')).not.toBeInTheDocument();
  view.rerender(<AgentResultLine agent={{ ...agent, metadata: { ...agent.metadata, cleanupOutcome: { status: 'already-absent', reason: 'already-absent-preservation-unverified' } } }} />);
  expect(screen.getByText(/Cleanup already absent; preservation unverified/)).toBeInTheDocument();
  expect(screen.queryByText('Completed successfully')).not.toBeInTheDocument();
  view.rerender(<AgentResultLine agent={{ ...agent, metadata: { ...agent.metadata, cleanupOutcome: { status: 'verified' } } }} />);
  expect(screen.getByText('Execution completed')).toBeInTheDocument();
});

it('names the live runs a claim-owner cleanup hold is waiting on', async () => {
  const { MemoryRouter } = await import('react-router');
  const cleanupOutcome = { status: 'blocked', reason: 'claim-owner-ambiguous', owners: ['agent-aaa', 'agent-bbb'] };
  render(<MemoryRouter><AgentResultLine agent={{ result: { success: true }, metadata: { cleanupOutcome } }} /></MemoryRouter>);
  const first = screen.getByRole('link', { name: 'agent-aaa' });
  expect(first.closest('div')).toHaveTextContent('Cleanup blocked: claim-owner-ambiguous — waiting on live runs agent-aaa, agent-bbb');
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
