import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TaskHeader from './TaskHeader';

const baseConfig = { enabled: true, type: 'on-demand' };

function renderHeader(overrides = {}, orderStep = undefined, taskType = 'better-complexity') {
  render(<TaskHeader taskType={taskType} config={{ ...baseConfig, ...overrides }} orderStep={orderStep} />);
}

describe('TaskHeader advisory run order', () => {
  it('names the tasks to run first instead of describing them in prose', () => {
    renderHeader({ suggestedAfter: ['module-hygiene'] }, 4);
    expect(screen.getByText('Run first:')).toBeInTheDocument();
    expect(screen.getByText('module-hygiene')).toBeInTheDocument();
  });

  it('shows the order step for a task inside the sequence', () => {
    renderHeader({ suggestedAfter: ['module-hygiene'] }, 4);
    expect(screen.getByTitle(/Suggested order step 4 — run module-hygiene first/)).toBeInTheDocument();
  });

  it('shows no step for a task outside the sequence — unordered is not "first"', () => {
    renderHeader({}, undefined, 'claim-issue');
    expect(screen.queryByTitle(/Suggested order step/)).not.toBeInTheDocument();
    expect(screen.queryByText('Run first:')).not.toBeInTheDocument();
  });

  it('keeps the rationale prose as a separate line from the named order', () => {
    renderHeader({ suggestedAfter: ['module-hygiene'], runGuidance: 'Remeasures the functions that survived the ladder.' }, 4);
    expect(screen.getByText('Remeasures the functions that survived the ladder.')).toBeInTheDocument();
    expect(screen.getByText('Run first:')).toBeInTheDocument();
  });
});
