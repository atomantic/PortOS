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
