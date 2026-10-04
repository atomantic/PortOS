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
  it('submits substantive machine evidence for the exact proof without claiming playback', () => {
    const review = reviewFixture();
    const view = render(<ProductionReviewPanel project={project} review={review} onOpenArtifact={vi.fn()} />);
    recordPlayback();
    fireEvent.change(screen.getByLabelText('Review method'), { target: { value: 'machine' } });
    expect(screen.queryByLabelText(acknowledgement)).toBeNull();
    const approve = screen.getByRole('button', { name: 'Approve animated proof' });
    const evidence = {
      visualReview: 'Continuous frame sequence shows the figure turning and opening the prop on the beat.',
      audioReview: 'Decoded master audio matches the proof interval; transient timing aligns with the turn.',
      limitations: 'Machine inspection only; no human listening or playback is claimed.',
    };
    fireEvent.change(screen.getByLabelText('Visual and motion observations'), { target: { value: evidence.visualReview } });
    fireEvent.change(screen.getByLabelText('Audio and alignment observations'), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText('Review limitations'), { target: { value: evidence.limitations } });
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Audio and alignment observations'), { target: { value: evidence.audioReview } });
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    expect(review.approve).toHaveBeenCalledWith('proof', {
      method: 'machine', watchedWithAudio: false, machineEvidence: evidence,
      excerptId: 'proof-a', filename: 'proof-a.mp4',
      energyComparison: 'The driving turn matches the chosen energy.',
      timecodedNotes: '0:04 — figure turns on the downbeat; prop follows at 4.5s.',
    });
    fireEvent.change(screen.getByLabelText('Review method'), { target: { value: 'playback' } });
    expect(screen.getByLabelText(acknowledgement).checked).toBe(false);
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Review method'), { target: { value: 'machine' } });
    view.rerender(<ProductionReviewPanel project={{ ...project, excerpts: [{ ...project.excerpts[0], filename: 'replacement.mp4' }] }} review={review} onOpenArtifact={vi.fn()} />);
    expect(screen.getByLabelText('Review method').value).toBe('playback');
    fireEvent.loadedData(screen.getByLabelText('Animated proof with master audio'));
    fireEvent.change(screen.getByLabelText('Review method'), { target: { value: 'machine' } });
    expect(screen.getByLabelText('Visual and motion observations').value).toBe('');
    expect(screen.getByLabelText('Audio and alignment observations').value).toBe('');
    expect(screen.getByLabelText('Review limitations').value).toBe('');
    expect(approve.disabled).toBe(true);
  });

  it('reports server errors and blocks machine approval for missing media or timestamps', () => {
    const review = reviewFixture();
    render(<ProductionReviewPanel project={project} review={{ ...review, error: 'The proof revision changed; review the current proof.' }} onOpenArtifact={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('proof revision changed');
    expect(screen.getByLabelText('Review method').disabled).toBe(true);
    fireEvent.loadedData(screen.getByLabelText('Animated proof with master audio'));
    fireEvent.change(screen.getByLabelText('Review method'), { target: { value: 'machine' } });
    for (const label of ['Visual and motion observations', 'Audio and alignment observations', 'Review limitations']) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: 'Specific evidence from the exact proof and the current master audio.' } });
    }
    fireEvent.change(screen.getByLabelText('Playback energy compared with the saved plan'), { target: { value: 'Driving movement matches the saved plan.' } });
    fireEvent.change(screen.getByLabelText('Timecoded playback notes'), { target: { value: 'Missing timestamp' } });
    const approve = screen.getByRole('button', { name: 'Approve animated proof' });
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Timecoded playback notes'), { target: { value: '0:04 — turn matches the downbeat.' } });
    fireEvent.error(screen.getByLabelText('Animated proof with master audio'));
    expect(approve.disabled).toBe(true);
    expect(screen.getByLabelText('Visual and motion observations').disabled).toBe(true);
    expect(review.approve).not.toHaveBeenCalled();
  });

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

describe('Stale alignment review', () => {
  it('labels historical verification and offers an explicit native button with the saved notes', () => {
    const vocal = { ...project, productionReview: { ...project.productionReview, draft: { ...project.productionReview.draft, lyricsMode: 'vocal' } } };
    const review = reviewFixture();
    review.readiness.alignment = { status: 'stale', basis: 'current-word-times' };
    review.reverifyAlignment = vi.fn();
    const view = render(<ProductionReviewPanel project={vocal} review={review} onOpenArtifact={vi.fn()} />);
    fireEvent.click(screen.getByText('Edit visual guide and storyboard'));
    expect(screen.getByRole('option', { name: 'Previously verified — needs re-review' }).selected).toBe(true);
    const button = screen.getByRole('button', { name: 'Reverify current timings' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.disabled).toBe(false);
    expect(screen.getByText(/Listen to the current master and inspect its word timings/)).toBeTruthy();
    expect(review.reverifyAlignment).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(review.reverifyAlignment).toHaveBeenCalledWith('Synthetic master');
    fireEvent.change(screen.getByLabelText('Alignment notes / instrumental rationale'), { target: { value: 'New unsaved notes' } });
    expect(button.disabled).toBe(true);
    view.rerender(<ProductionReviewPanel project={vocal} review={{ ...review, busy: true }} onOpenArtifact={vi.fn()} />);
    expect(button.disabled).toBe(true);
  });
});
