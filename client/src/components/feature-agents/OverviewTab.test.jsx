import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import OverviewTab from './OverviewTab.jsx';

describe('OverviewTab', () => {
  const defaultAgent = {
    id: 'agent-1',
    status: 'draft',
    priority: 'medium',
    autonomyLevel: 'human-in-the-loop',
    runCount: 5,
    lastRunAt: '2026-08-27T10:00:00Z',
    schedule: { mode: 'continuous' },
    createdAt: '2026-08-01T10:00:00Z',
    persona: 'Refactoring expert',
    goals: ['Improve test coverage', 'Fix mobile responsive issues'],
    git: {
      branchName: 'feature/agent-1',
      baseBranch: 'main',
    },
  };

  it('renders status and responsive action containers for draft agent', () => {
    const onStart = vi.fn();
    const { container } = render(
      <OverviewTab agent={defaultAgent} onStart={onStart} />
    );

    expect(screen.getByText('draft')).toBeInTheDocument();
    expect(screen.getByText('medium priority')).toBeInTheDocument();

    const activateBtn = screen.getByRole('button', { name: /Activate/i });
    expect(activateBtn).toBeInTheDocument();
    fireEvent.click(activateBtn);
    expect(onStart).toHaveBeenCalledWith('agent-1');

    const header = container.querySelector('.flex.flex-col.sm\\:flex-row');
    expect(header).toBeInTheDocument();
  });

  it('renders trigger, pause, and stop actions for active agent', () => {
    const onTrigger = vi.fn();
    const onPause = vi.fn();
    const onStop = vi.fn();

    render(
      <OverviewTab
        agent={{ ...defaultAgent, status: 'active' }}
        onTrigger={onTrigger}
        onPause={onPause}
        onStop={onStop}
      />
    );

    const triggerBtn = screen.getByRole('button', { name: /Trigger Run/i });
    const pauseBtn = screen.getByRole('button', { name: /Pause/i });
    const stopBtn = screen.getByRole('button', { name: /Stop/i });

    expect(triggerBtn).toBeInTheDocument();
    expect(pauseBtn).toBeInTheDocument();
    expect(stopBtn).toBeInTheDocument();

    fireEvent.click(triggerBtn);
    expect(onTrigger).toHaveBeenCalledWith('agent-1');

    fireEvent.click(pauseBtn);
    expect(onPause).toHaveBeenCalledWith('agent-1');

    fireEvent.click(stopBtn);
    expect(onStop).toHaveBeenCalledWith('agent-1');
  });

  it('renders resume and stop actions for paused agent', () => {
    const onResume = vi.fn();
    const onStop = vi.fn();

    render(
      <OverviewTab
        agent={{ ...defaultAgent, status: 'paused' }}
        onResume={onResume}
        onStop={onStop}
      />
    );

    const resumeBtn = screen.getByRole('button', { name: /Resume/i });
    const stopBtn = screen.getByRole('button', { name: /Stop/i });

    expect(resumeBtn).toBeInTheDocument();
    expect(stopBtn).toBeInTheDocument();

    fireEvent.click(resumeBtn);
    expect(onResume).toHaveBeenCalledWith('agent-1');

    fireEvent.click(stopBtn);
    expect(onStop).toHaveBeenCalledWith('agent-1');
  });
});
