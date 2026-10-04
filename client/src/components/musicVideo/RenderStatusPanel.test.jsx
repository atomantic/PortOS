import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import RenderStatusPanel, { RenderFailure } from './RenderStatusPanel.jsx';

afterEach(cleanup);
it('keeps a persisted render failure visible after reload and isolates another project’s SSE failure', () => {
  const project = { id: 'mv-example', status: 'failed', renderError: 'Edit durationSec to a whole-frame duration and re-import.' };
  const { rerender } = render(<RenderFailure project={project} renderJob={{ failure: { projectId: 'other', message: 'Other failure' } }} />);
  expect(screen.getByRole('alert')).toHaveTextContent(project.renderError);
  expect(screen.queryByText('Other failure')).not.toBeInTheDocument();
  rerender(<RenderFailure project={project} renderJob={{ active: true, context: project.id }} />);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  rerender(<RenderFailure project={{ ...project, status: 'complete', renderError: null }} renderJob={{}} />);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('shows an amber out-of-date notice only when the final render is stale (#10143)', () => {
  const { rerender } = render(<RenderStatusPanel renderHistoryId="rh-1" stale />);
  expect(screen.getByRole('status')).toHaveTextContent('Final render is out of date — re-render');
  rerender(<RenderStatusPanel renderHistoryId="rh-1" />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
