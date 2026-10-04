/**
 * Social cuts in the excerpt panel (#9280): a composition-document project can
 * render an excerpt at another frame with faded edges, and a suggested hook
 * renders as a vertical cut in one click. A footage project keeps the plain
 * range-only control (it has no frame of its own to re-lay-out).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/apiMusicVideo.js', () => ({ getMusicVideoSocialCuts: vi.fn() }));

import { getMusicVideoSocialCuts } from '../../services/apiMusicVideo.js';
import ExcerptPanel from './ExcerptPanel.jsx';

const documentProject = { id: 'mv-1', name: 'Example Song', composition: { mode: 'document' }, audioAnalysis: { durationSec: 90 } };

function renderPanel(project, startExcerpt = vi.fn()) {
  render(<ExcerptPanel project={project} rendering={false} progress={0} excerpts={[]} startExcerpt={startExcerpt} />);
  return startExcerpt;
}

beforeEach(() => vi.clearAllMocks());

describe('ExcerptPanel social cuts (#9280)', () => {
  it('renders the chosen range at another frame with faded audio edges', () => {
    const start = renderPanel(documentProject);
    fireEvent.change(screen.getByLabelText('Frame'), { target: { value: '9:16' } });
    fireEvent.click(screen.getByLabelText('Fade audio edges'));
    fireEvent.click(screen.getByRole('button', { name: /Render excerpt/ }));
    expect(start).toHaveBeenCalledWith(0, 15, { aspect: '9:16', fade: true });
  });

  it('renders a suggested hook as a vertical faded cut', async () => {
    getMusicVideoSocialCuts.mockResolvedValue({ suggestions: [{ startSec: 43.5, endSec: 62.4, score: 0.8, label: 'the chorus line', reasons: ['chorus', 'sings the title'] }] });
    const start = renderPanel(documentProject);
    fireEvent.click(screen.getByRole('button', { name: /Suggest hooks/ }));
    await waitFor(() => expect(screen.getByText(/the chorus line/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Render 9:16' }));
    expect(start).toHaveBeenCalledWith(43.5, 62.4, { aspect: '9:16', fade: true });
  });

  it('keeps a footage project to its own frame', () => {
    const start = renderPanel({ ...documentProject, composition: { mode: 'concat' } });
    expect(screen.queryByLabelText('Frame')).toBeNull();
    expect(screen.queryByRole('button', { name: /Suggest hooks/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Render excerpt/ }));
    expect(start).toHaveBeenCalledWith(0, 15, undefined);
  });
});


it('keeps the current draft visible while retaining stale and failed attempts behind history', () => {
  const current = { id: 'current', status: 'complete', filename: 'current.mp4', startSec: 0, endSec: 12, dependencyState: { status: 'current' } };
  render(<ExcerptPanel project={documentProject} rendering={false} progress={0} excerpts={[
    { ...current, id: 'older', filename: 'older.mp4', dependencyState: { status: 'stale' } }, current,
    { id: 'failed', status: 'error', error: 'Render interrupted: encoder input closed', startSec: 0, endSec: 12 },
  ]} startExcerpt={vi.fn()} />);
  expect(screen.getByRole('list', { name: 'Current draft and active renders' })).toHaveTextContent('Matches current inputs');
  const history = screen.getByText('Earlier and failed attempts (2)').closest('details');
  expect(history.open).toBe(false);
  expect(screen.getByRole('status')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Latest draft attempt failed: Render interrupted');
  fireEvent.click(screen.getByText('Earlier and failed attempts (2)'));
  expect(history.open).toBe(true);
  expect(screen.getByText('Earlier inputs — retained for reference')).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('Render interrupted');
});

it('explains an occupied render slot without attributing another project’s progress to this project', () => {
  const start = vi.fn();
  render(<ExcerptPanel project={documentProject} occupied rendering={false} progress={0} excerpts={[]} startExcerpt={start} />);
  const button = screen.getByRole('button', { name: /Render excerpt/ });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(start).not.toHaveBeenCalled();
  expect(screen.getByRole('status')).toHaveTextContent('another project');
  expect(screen.queryByText(/Rendering draft/)).toBeNull();
});

it('does not mislabel current footage after it has been approved as production proof', () => {
  render(<ExcerptPanel project={{ ...documentProject, productionReview: { proof: { excerptId: 'proof' }, approvals: { proof: { excerptId: 'proof' } } } }} rendering={false} progress={0} excerpts={[
    { id: 'proof', status: 'complete', filename: 'example.mp4', startSec: 0, endSec: 12, dependencyState: { status: 'current' } },
  ]} startExcerpt={vi.fn()} />);
  expect(screen.getByText(/Matches current inputs/)).toHaveTextContent('production approval is separate');
  expect(screen.queryByText(/unapproved draft/)).toBeNull();
});

describe('ExcerptPanel roles and deletion (#10148)', () => {
  const done = (id, extra = {}) => ({ id, status: 'complete', filename: `${id}.mp4`, startSec: 0, endSec: 12, dependencyState: { status: 'current' }, ...extra });

  it('keeps the review draft visible when a newer social cut renders, and badges both', () => {
    render(<ExcerptPanel project={documentProject} rendering={false} progress={0}
      excerpts={[done('draft'), done('social', { aspect: '9:16' })]} startExcerpt={vi.fn()} />);
    const list = screen.getByRole('list', { name: 'Current draft and active renders' });
    expect(list).toHaveTextContent('Social cut');
    expect(list).toHaveTextContent('Draft');
    expect(screen.queryByText(/Earlier and failed attempts/)).toBeNull();
  });

  it('labels the registered proof and offers no delete for it', () => {
    const project = { ...documentProject, productionReview: { proof: { excerptId: 'p1' } } };
    render(<ExcerptPanel project={project} rendering={false} progress={0}
      excerpts={[done('p1')]} startExcerpt={vi.fn()} />);
    expect(screen.getByText('Proof')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
  });

  it('requires a second click to delete an ordinary excerpt', () => {
    const deleteExcerpt = vi.fn();
    render(<ExcerptPanel project={documentProject} rendering={false} progress={0}
      excerpts={[done('d1')]} startExcerpt={vi.fn()} deleteExcerpt={deleteExcerpt} />);
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }));
    expect(deleteExcerpt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    expect(deleteExcerpt).toHaveBeenCalledWith('d1');
  });
});
