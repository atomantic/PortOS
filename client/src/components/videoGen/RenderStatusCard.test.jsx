import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import RenderStatusCard from './RenderStatusCard';

describe('RenderStatusCard', () => {
  it('names the step a silent render is on instead of showing a bare percentage', () => {
    render(<RenderStatusCard generating progressPct={0} statusMsg="Loading the FastVideo pipeline · 2m45s elapsed" />);

    expect(screen.getByText('Loading the FastVideo pipeline · 2m45s elapsed')).toBeInTheDocument();
    expect(screen.getByTestId('render-step-load')).toHaveAttribute('data-state', 'active');
    expect(screen.getByTestId('render-step-render')).toHaveAttribute('data-state', 'pending');
  });

  it('advances the step list from the runner phase', () => {
    render(<RenderStatusCard generating phase="sampling" progressPct={40} />);

    expect(screen.getByTestId('render-step-load')).toHaveAttribute('data-state', 'done');
    expect(screen.getByTestId('render-step-render')).toHaveAttribute('data-state', 'active');
    expect(screen.getByRole('progressbar', { name: 'Render progress' }))
      .toHaveAttribute('aria-valuenow', '40');
  });

  it('shows elapsed wall clock so a silent phase reads as work, not a hang', () => {
    render(<RenderStatusCard generating startedAt={Date.now() - 165_000} />);
    expect(screen.getByText('2m 45s')).toBeInTheDocument();
  });

  // The display going dark unannounced is what made users wake it — and waking
  // it is what risks the GPU-watchdog panic the sleep is there to prevent.
  it('explains the dark screen while an MLX render is running', () => {
    render(<RenderStatusCard generating phase="sampling" sleepsDisplay />);
    expect(screen.getByText(/put to sleep on purpose/i)).toBeInTheDocument();
  });

  it('does not claim the display is asleep while the job is still queued', () => {
    render(<RenderStatusCard generating phase="queued" sleepsDisplay />);
    expect(screen.queryByText(/put to sleep on purpose/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('render-step-queued')).toHaveAttribute('data-state', 'active');
  });

  it('shows the error instead of the step list when a render fails', () => {
    render(<RenderStatusCard generating={false} error="Runner exited with code 1" />);
    expect(screen.getByText('Runner exited with code 1')).toBeInTheDocument();
    expect(screen.queryByTestId('render-step-render')).not.toBeInTheDocument();
  });

  it('rests quietly when nothing is rendering', () => {
    render(<RenderStatusCard />);
    expect(screen.getByText('No render in progress.')).toBeInTheDocument();
  });
});
