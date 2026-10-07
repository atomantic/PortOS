import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import AgentResultLine from './AgentResultLine';

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
  expect(screen.getByText('Completed successfully')).toBeInTheDocument();
  expect(screen.queryByText('Assessment saved')).not.toBeInTheDocument();
  expect(screen.queryByText('Delivery validation failed')).not.toBeInTheDocument();
});


it('does not present blocked publication as completed delivery', () => {
  render(<AgentResultLine agent={{ result: { success: true, validationPassed: true }, metadata: { publicationValidation: { status: 'blocked', reason: 'pregate-nonzero' } } }} />);
  expect(screen.getByText('Execution completed')).toBeInTheDocument();
  expect(screen.getByText('Publication blocked; worktree preserved')).toBeInTheDocument();
  expect(screen.queryByText('Completed successfully')).not.toBeInTheDocument();
});
