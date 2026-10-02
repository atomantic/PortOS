import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProductionReviewPanel from './ProductionReviewPanel.jsx';

const acknowledgement = 'I watched this revision with audio at normal speed and compared its energy, timed choreography and lyric timing with the saved plan.';
const project = {
  id: 'example-project', scenes: [], lyricCues: [], composition: { mode: 'document' },
  productionReview: { proof: { excerptId: 'proof-a', basis: 'same-creative-basis' }, draft: {
    cast: 'Example figure', environments: 'Example stage', visualLanguage: 'Copper and indigo',
    motionLanguage: 'Energy target: driving chorus. 0:04 — figure turns and opens the prop on the downbeat.',
    lyricsMode: 'instrumental', timingStatus: 'verified', timingNotes: 'Synthetic master', storyboard: [],
  } },
  excerpts: [{ id: 'proof-a', filename: 'proof-a.mp4', status: 'complete' }],
};
const reviewFixture = () => ({ readiness: {
  basis: { art: 'art', storyboard: 'board', proof: 'same-creative-basis' },
  art: { approved: true, problems: [] }, storyboard: { approved: true, problems: [] }, proof: { approved: false, problems: [] },
}, busy: false, proof: { active: false }, approve: vi.fn(), save: vi.fn(async () => null) });
function recordPlayback() {
  fireEvent.change(screen.getByLabelText('Instance password for this approval'), { target: { value: 'synthetic-password' } });
  fireEvent.change(screen.getByLabelText('Playback energy compared with the saved plan'), { target: { value: 'The driving turn matches the chosen energy.' } });
  fireEvent.change(screen.getByLabelText('Timecoded playback notes'), { target: { value: '0:04 — figure turns on the downbeat; prop follows at 4.5s.' } });
  fireEvent.click(screen.getByLabelText(acknowledgement));
}

describe('Production proof playback evidence', () => {
  it('shows the recorded review for an approved artifact without treating it as fresh playback evidence', () => {
    const review = reviewFixture();
    review.readiness.proof.approved = true;
    const approved = { ...project, productionReview: { ...project.productionReview, approvals: { proof: { proofReview: {
      excerptId: 'proof-a', filename: 'proof-a.mp4', watchedWithAudio: true,
      energyComparison: 'The driving turn matches the saved energy target.', timecodedNotes: '0:04 — the figure turns on the downbeat.',
    } } } } };
    const view = render(<ProductionReviewPanel project={approved} review={review} onOpenArtifact={vi.fn()} />);
    expect(screen.getByLabelText('Recorded proof review').textContent).toContain('0:04 — the figure turns on the downbeat.');
    expect(screen.getByLabelText(acknowledgement).checked).toBe(false);
    expect(screen.getByLabelText('Timecoded playback notes').value).toBe('');
    view.rerender(<ProductionReviewPanel project={{ ...approved, excerpts: [{ id: 'proof-a', filename: 'replacement.mp4', status: 'complete' }] }} review={review} onOpenArtifact={vi.fn()} />);
    expect(screen.queryByLabelText('Recorded proof review')).toBeNull();
  });

  it.each([
    { id: 'proof-b', filename: 'proof-b.mp4' },
    { id: 'proof-a', filename: 'replacement.mp4' },
  ])('requires new playback notes when the proof artifact changes to $filename without a creative-basis change', ({ id, filename }) => {
    const review = reviewFixture();
    const view = render(<ProductionReviewPanel project={project} review={review} onOpenArtifact={vi.fn()} />);
    recordPlayback();
    expect(screen.getByRole('button', { name: 'Approve animated proof' }).disabled).toBe(false);
    const replacement = { ...project, productionReview: { ...project.productionReview, proof: { ...project.productionReview.proof, excerptId: id } },
      excerpts: [{ id, filename, status: 'complete' }] };
    view.rerender(<ProductionReviewPanel project={replacement} review={review} onOpenArtifact={vi.fn()} />);
    expect(screen.getByLabelText(acknowledgement).checked).toBe(false);
    expect(screen.getByLabelText('Playback energy compared with the saved plan').value).toBe('');
    expect(screen.getByLabelText('Timecoded playback notes').value).toBe('');
    expect(screen.getByRole('button', { name: 'Approve animated proof' }).disabled).toBe(true);
    recordPlayback();
    fireEvent.click(screen.getByRole('button', { name: 'Approve animated proof' }));
    expect(review.approve).toHaveBeenCalledWith('proof', 'synthetic-password', expect.objectContaining({
      excerptId: id, filename, watchedWithAudio: true, energyComparison: 'The driving turn matches the chosen energy.',
      timecodedNotes: '0:04 — figure turns on the downbeat; prop follows at 4.5s.',
    }));
  });

  it('keeps failed choreography saves dirty and blocks playback acknowledgement and approval', async () => {
    const review = reviewFixture();
    render(<ProductionReviewPanel project={project} review={review} onOpenArtifact={vi.fn()} />);
    recordPlayback();
    fireEvent.change(screen.getByLabelText('Timed choreography and energy plan'), { target: { value: 'Energy target: explosive. 0:04 — replace the turn with a leap.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save planning edits', hidden: true }));
    await waitFor(() => expect(review.save).toHaveBeenCalled());
    expect(screen.getByText('Save edits before preparing, approving or rendering.')).toBeTruthy();
    expect(screen.getByLabelText(acknowledgement).disabled).toBe(true);
    expect(screen.getByLabelText('Timecoded playback notes').disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Approve animated proof' }).disabled).toBe(true);
    expect(review.approve).not.toHaveBeenCalled();
  });
});
