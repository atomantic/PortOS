import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

// Uniquely catches a refusal's one-tap fix acting on a shot it cannot fix, or a fix offered where none exists.
it('offers one tap that fixes the shots a render refusal names', async () => {
  const project = { id: 'mv-example', status: 'ready' };
  const onPatchShots = vi.fn(async () => {});
  const failure = { projectId: project.id, code: 'STALE_PERFORMANCE_TAKES', message: 'Shots 3 (no lip-sync record), 6 (re-timed): …',
    context: { stale: [{ sceneId: 'a', cutaway: true }, { sceneId: 'b', cutaway: false }, { sceneId: 'c', cutaway: true }] } };
  const { rerender } = render(<RenderFailure project={project} renderJob={{ failure }} onPatchShots={onPatchShots} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Switch these 2 to Cutaway' })); });
  expect(onPatchShots).toHaveBeenCalledWith(['a', 'c'], { shotMode: 'cutaway' }, 'Switched 2 shots to Cutaway');
  rerender(<RenderFailure project={project} renderJob={{ failure: { projectId: project.id, code: 'INSUFFICIENT_CLIP_COVERAGE', message: 'Shot 19 (0.58s short): …',
    context: { shortfalls: [{ sceneId: 'd', shortBySec: 0.58 }] } } }} onPatchShots={onPatchShots} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Hold the last frame on it' })); });
  expect(onPatchShots).toHaveBeenLastCalledWith(['d'], { holdLastFrame: true }, 'Holding the last frame on 1 shot');
  const onRenderClips = vi.fn(async () => {});
  rerender(<RenderFailure project={project} renderJob={{ failure: { projectId: project.id, code: 'STALE_CLIP_DEPENDENCIES', message: 'Shot 8: the clip was made from frames that have since changed. …',
    context: { sceneIds: ['e'] } } }} onPatchShots={onPatchShots} onRenderClips={onRenderClips} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Render a new clip' })); });
  expect(onRenderClips).toHaveBeenCalledWith(['e']);
  expect(onPatchShots).toHaveBeenCalledTimes(2);
  rerender(<RenderFailure project={project} renderJob={{ failure: { ...failure, code: 'MISSING_CLIPS' } }} onPatchShots={onPatchShots} />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
