import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PreflightProgress from './PreflightProgress';

const preflight = (overrides = {}) => ({
  phase: 'preparing',
  steps: [
    { key: 'queued', label: 'Waiting for a free task slot', status: 'done', detail: null },
    { key: 'security-scan', label: 'Screening PR content for hidden Unicode and prompt injection', status: 'active', detail: 'Screening 2 pull requests through the abuse guard' },
    { key: 'dispatch', label: 'Handing off to the agent', status: 'pending', detail: null },
  ],
  ...overrides,
});

describe('PreflightProgress', () => {
  it('renders nothing for a task with no programmatic phase', () => {
    const { container } = render(<PreflightProgress preflight={undefined} idScope="cos" taskId="t-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the check that is running and says no agent has started', () => {
    render(<PreflightProgress preflight={preflight()} idScope="cos" taskId="t-1" />);
    expect(screen.getByText('Screening PR content for hidden Unicode and prompt injection')).toBeInTheDocument();
    expect(screen.getByText('Screening 2 pull requests through the abuse guard')).toBeInTheDocument();
    expect(screen.getByLabelText('Pre-agent checks')).toHaveAttribute('aria-busy', 'true');
  });

  it('stops reading as busy once the phase is terminal, and surfaces the note', () => {
    render(<PreflightProgress
      preflight={preflight({ phase: 'failed', note: 'Repair the abuse guard, then retry PR review.' })}
      idScope="cos"
      taskId="t-1"
    />);
    const section = screen.getByLabelText('Pre-agent checks');
    expect(section).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByText('finished')).toBeInTheDocument();
    expect(screen.getByText('Repair the abuse guard, then retry PR review.')).toBeInTheDocument();
  });
});
