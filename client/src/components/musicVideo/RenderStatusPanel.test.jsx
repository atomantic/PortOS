import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RenderFailure } from './RenderStatusPanel.jsx';

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
