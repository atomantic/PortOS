import { MemoryRouter } from 'react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import LoomAiRunStatus from './LoomAiRunStatus';

describe('LoomAiRunStatus', () => {
  it('offers the live TUI run through the existing Shell route', () => {
    render(
      <MemoryRouter>
        <LoomAiRunStatus run={{
          phase: 'ready',
          message: 'TUI run is ready',
          runId: 'run-tui-1',
          providerName: 'Codex TUI',
          model: 'gpt-test',
          shellReady: true,
        }} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /open shell/i })).toHaveAttribute('href', '/shell/run-tui-1');
  });

  it('keeps a completed operation visible without offering a released shell session', () => {
    render(
      <MemoryRouter>
        <LoomAiRunStatus run={{ phase: 'complete', message: 'AI response ready', runId: 'run-tui-1', shellReady: false }} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('status')).toHaveTextContent('AI response ready');
    expect(screen.queryByRole('link', { name: /open shell/i })).toBeNull();
  });
});
