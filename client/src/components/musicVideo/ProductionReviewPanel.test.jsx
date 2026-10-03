import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ProductionReviewPanel from './ProductionReviewPanel.jsx';

afterEach(() => { vi.unstubAllGlobals(); window.location.hash = ''; });

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
  fireEvent.loadedData(screen.getByLabelText('Animated proof with master audio'));
  fireEvent.change(screen.getByLabelText('Playback energy compared with the saved plan'), { target: { value: 'The driving turn matches the chosen energy.' } });
  fireEvent.change(screen.getByLabelText('Timecoded playback notes'), { target: { value: '0:04 — figure turns on the downbeat; prop follows at 4.5s.' } });
  fireEvent.click(screen.getByLabelText(acknowledgement));
}

describe('Production proof playback evidence', () => {
  it('shows the selected version before permitting art approval without password re-entry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const review = reviewFixture(); review.readiness.art.approved = false;
    const art = { ...project, devArtifacts: [{ id: 'guide', title: 'Synthetic visual guide', version: 2, mimeType: 'image/png' }],
      productionReview: { ...project.productionReview, draft: { ...project.productionReview.draft, guideArtifactId: 'guide' } } };
    render(<ProductionReviewPanel project={art} review={review} onOpenArtifact={vi.fn()} />);
    const approve = screen.getByRole('button', { name: 'Approve art direction' });
    expect(approve.disabled).toBe(true);
    const image = await screen.findByAltText('Synthetic visual guide v2');
    expect(image.getAttribute('src')).toContain('?version=2');
    fireEvent.load(image);
    expect(screen.queryByLabelText('Instance password for this approval')).toBeNull();
    fireEvent.click(approve);
    expect(review.approve).toHaveBeenCalledWith('art', undefined);
    fireEvent.error(image);
    expect(approve.disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
  });

  it('shows the document shots beside storyboard approval and targets change requests to that stage', () => {
    const review = reviewFixture(); review.readiness.storyboard.approved = false;
    const doc = { ...project, composition: { mode: 'document', document: { directory: 'synthetic/doc-2' } },
      productionReview: { ...project.productionReview, draft: { ...project.productionReview.draft, storyboardSource: 'document',
        storyboard: [{ id: 'shot-a', label: 'Doorway', startSec: 0, endSec: 10, action: 'Open the doorway on the downbeat', camera: 'Push in', staging: 'Figure left', transition: 'Match cut', lyricCueIds: [] }] } } };
    render(<ProductionReviewPanel project={doc} review={review} onOpenArtifact={vi.fn()} />);
    const content = screen.getByLabelText('Storyboard review content');
    expect(content.textContent).toContain('1 document shots');
    expect(content.textContent).toContain('doc-2');
    expect(content.textContent).toContain('Open the doorway on the downbeat');
    fireEvent.click(within(content.closest('details')).getByRole('button', { name: 'Request changes' }));
    expect(screen.getByLabelText('Feedback stage').value).toBe('storyboard');
    expect(document.activeElement).toBe(screen.getByLabelText('Requested change'));
    expect(screen.getByLabelText('Requested change').closest('details').open).toBe(true);
  });

  it('keeps the hash-selected art context open when readiness arrives', () => {
    window.location.hash = '#mv-review-art';
    const review = reviewFixture();
    const view = render(<ProductionReviewPanel project={project} review={{ ...review, readiness: null }} onOpenArtifact={vi.fn()} />);
    view.rerender(<ProductionReviewPanel project={project} review={review} onOpenArtifact={vi.fn()} />);
    expect(document.getElementById('mv-review-art').open).toBe(true);
  });

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
    expect(review.approve).toHaveBeenCalledWith('proof', expect.objectContaining({
      excerptId: id, filename, watchedWithAudio: true, energyComparison: 'The driving turn matches the chosen energy.',
      timecodedNotes: '0:04 — figure turns on the downbeat; prop follows at 4.5s.',
    }));
  });

  it('blocks approval and explains a failed proof player', () => {
    const review = reviewFixture();
    render(<ProductionReviewPanel project={project} review={review} onOpenArtifact={vi.fn()} />);
    recordPlayback();
    fireEvent.error(screen.getByLabelText('Animated proof with master audio'));
    expect(screen.getByRole('alert').textContent).toContain('could not be played');
    expect(screen.getByRole('button', { name: 'Approve animated proof' }).disabled).toBe(true);
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
