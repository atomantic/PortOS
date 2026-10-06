import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import ProductionReviewPanel from './ProductionReviewPanel.jsx';

afterEach(() => { vi.unstubAllGlobals(); window.location.hash = ''; });

const approvalAction = 'Approve — I reviewed this proof with audio';
const proofAction = /Approve.*proof/;
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
}

describe('Production proof playback evidence', () => {
  it('records playback attestation only when the reviewer explicitly approves, without a separate checkbox', () => {
    const review = reviewFixture();
    render(<ProductionReviewPanel project={project} review={review} onOpenArtifact={vi.fn()} stage="proof" />);
    const approve = screen.getByRole('button', { name: approvalAction });
    expect(approve.disabled).toBe(true);
    fireEvent.loadedData(screen.getByLabelText('Animated proof with master audio'));
    expect(screen.getByText('Describe how the playback energy compares with the saved plan.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Playback energy compared with the saved plan'), { target: { value: 'Driving movement matches the plan.' } });
    expect(approve.disabled).toBe(true);
    expect(screen.getByText('Add playback notes with a timestamp such as 0:04 or 4.5s.')).toBeTruthy();
    recordPlayback();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(approve.disabled).toBe(false);
    expect(review.approve).not.toHaveBeenCalled();
    expect(document.getElementById(approve.getAttribute('aria-describedby').split(' ').at(-1)).textContent).toContain('watched this exact proof with audio at normal speed');
    fireEvent.click(approve);
    expect(review.approve).toHaveBeenCalledWith('proof', {
      watchedWithAudio: true, excerptId: 'proof-a', filename: 'proof-a.mp4',
      energyComparison: 'The driving turn matches the chosen energy.',
      timecodedNotes: '0:04 — figure turns on the downbeat; prop follows at 4.5s.',
    });
  });


  it('explains why a completed prototype cannot be approved and opens the missing prerequisites', () => {
    const review = reviewFixture();
    review.readiness.art.approved = false;
    review.readiness.storyboard = { approved: false, problems: ['Verify alignment against the current master.', 'Import a matching document shot manifest.'] };
    review.readiness.proof.problems = ['Approve the current lyric-timed storyboard before the animated proof.'];
    const prototype = { ...project, productionReview: { ...project.productionReview, proof: null, prototype: { excerptId: 'proof-a' } } };
    const onNavigate = vi.fn();
    render(<ProductionReviewPanel project={prototype} review={review} onOpenArtifact={vi.fn()} stage="proof" onNavigate={onNavigate} />);
    expect(screen.getByRole('region', { name: 'Approve: Animated proof' })).toBeTruthy();
    const prerequisites = screen.getByLabelText('Proof approval prerequisites');
    expect(prerequisites.textContent).toContain('feasibility prototype, not a registered production proof');
    expect(prerequisites.textContent).toContain('Verify alignment against the current master.');
    expect(prerequisites.textContent).toContain('Import a matching document shot manifest.');
    expect(screen.getByRole('button', { name: approvalAction }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Render animated proof' }).disabled).toBe(true);
    fireEvent.loadedData(screen.getByLabelText('Unapproved feasibility prototype'));
    expect(screen.getByRole('button', { name: approvalAction }).disabled).toBe(true);
    fireEvent.click(within(prerequisites).getByRole('link', { name: 'Resolve storyboard prerequisites and approve it' }));
    // The storyboard approval and its planning edits live on the Board step, so the links cross steps.
    expect(onNavigate).toHaveBeenLastCalledWith('board', 'mv-review-storyboard');
    fireEvent.click(within(prerequisites).getByRole('link', { name: 'Open planning edits for document shot manifests' }));
    expect(onNavigate).toHaveBeenLastCalledWith('board', 'mv-review-planning');
    fireEvent.click(within(prerequisites).getByRole('link', { name: 'Song step' }));
    expect(onNavigate).toHaveBeenLastCalledWith('setup', 'mv-lyric-timing');
    expect(review.approve).not.toHaveBeenCalled();
  });

  it('clears evidence when the creative revision changes even if the excerpt and filename are unchanged', () => {
    const review = reviewFixture();
    const view = render(<ProductionReviewPanel project={project} review={review} onOpenArtifact={vi.fn()} stage="proof" />);
    recordPlayback();
    const changedReview = { ...review, readiness: { ...review.readiness,
      basis: { ...review.readiness.basis, proof: 'new-creative-basis' },
      proof: { approved: false, problems: ['Render and watch a current animated chorus proof with the master song.'] },
    } };
    view.rerender(<ProductionReviewPanel project={project} review={changedReview} onOpenArtifact={vi.fn()} stage="proof" />);
    expect(screen.getByLabelText('Timecoded playback notes').value).toBe('');
    expect(screen.getByRole('button', { name: approvalAction }).disabled).toBe(true);
    expect(screen.getByText(/Source changed — render a new proof/)).toBeTruthy();
    expect(review.approve).not.toHaveBeenCalled();
  });

  it('shows a persisted capture failure after reconnect and keeps proof approval blocked', () => {
    render(<ProductionReviewPanel project={{ ...project, excerpts: [{ id: 'proof-a', status: 'error',
      error: 'Composition capture failed at frame 0 (song 12s): Browser command timed out: Page.captureScreenshot' }] }}
      review={reviewFixture()} onOpenArtifact={vi.fn()} stage="proof" />);
    expect(screen.getByRole('alert').textContent).toContain('capture failed at frame 0');
    expect(screen.getByRole('button', { name: proofAction }).disabled).toBe(true);
    expect(screen.queryByLabelText('Animated proof with master audio')).toBeNull();
  });

  it('submits substantive machine evidence for the exact proof without claiming playback', () => {
    const review = reviewFixture();
    const view = render(<ProductionReviewPanel project={project} review={review} onOpenArtifact={vi.fn()} stage="proof" />);
    recordPlayback();
    fireEvent.change(screen.getByLabelText('Review method'), { target: { value: 'machine' } });
    expect(screen.queryByRole('checkbox')).toBeNull();
    const approve = screen.getByRole('button', { name: proofAction });
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
    expect(screen.getByRole('button', { name: approvalAction }).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Review method'), { target: { value: 'machine' } });
    view.rerender(<ProductionReviewPanel project={{ ...project, excerpts: [{ ...project.excerpts[0], filename: 'replacement.mp4' }] }} review={review} onOpenArtifact={vi.fn()} stage="proof" />);
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
    render(<ProductionReviewPanel project={project} review={{ ...review, error: 'The proof revision changed; review the current proof.' }} onOpenArtifact={vi.fn()} stage="proof" />);
    expect(screen.getByRole('alert').textContent).toContain('proof revision changed');
    expect(screen.getByLabelText('Review method').disabled).toBe(true);
    fireEvent.loadedData(screen.getByLabelText('Animated proof with master audio'));
    fireEvent.change(screen.getByLabelText('Review method'), { target: { value: 'machine' } });
    for (const label of ['Visual and motion observations', 'Audio and alignment observations', 'Review limitations']) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: 'Specific evidence from the exact proof and the current master audio.' } });
    }
    fireEvent.change(screen.getByLabelText('Playback energy compared with the saved plan'), { target: { value: 'Driving movement matches the saved plan.' } });
    fireEvent.change(screen.getByLabelText('Timecoded playback notes'), { target: { value: 'Missing timestamp' } });
    const approve = screen.getByRole('button', { name: proofAction });
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
    render(<ProductionReviewPanel project={art} review={review} onOpenArtifact={vi.fn()} stage="art" />);
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

  it('shows the document shots beside storyboard approval and targets change requests to that stage', async () => {
    const review = { ...reviewFixture(), feedback: vi.fn(async () => true) }; review.readiness.storyboard.approved = false;
    const doc = { ...project, composition: { mode: 'document', document: { directory: 'synthetic/doc-2' } },
      productionReview: { ...project.productionReview, draft: { ...project.productionReview.draft, storyboardSource: 'document',
        storyboard: [{ id: 'shot-a', label: 'Doorway', startSec: 0, endSec: 10, action: 'Open the doorway on the downbeat', camera: 'Push in', staging: 'Figure left', transition: 'Match cut', lyricCueIds: [] }] } } };
    render(<ProductionReviewPanel project={doc} review={review} onOpenArtifact={vi.fn()} stage="storyboard" />);
    const content = screen.getByLabelText('Storyboard review content');
    expect(content.textContent).toContain('1 document shots');
    expect(content.textContent).toContain('doc-2');
    expect(content.textContent).toContain('Open the doorway on the downbeat');
    const box = screen.getByRole('region', { name: 'Approve: Lyric-timed storyboard' });
    expect(box.contains(content)).toBe(true);
    fireEvent.click(within(box).getByRole('button', { name: 'Request changes' }));
    expect(screen.queryByLabelText('Feedback stage')).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Requested change'));
    expect(screen.getByLabelText('Requested change').closest('details').open).toBe(true);
    fireEvent.change(screen.getByLabelText('Feedback target'), { target: { value: 'shot: Doorway' } });
    fireEvent.change(screen.getByLabelText('Requested change'), { target: { value: 'Hold the doorway one beat longer.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save revision feedback' }));
    expect(review.feedback).toHaveBeenCalledWith({ stage: 'storyboard', target: 'shot: Doorway', text: 'Hold the doorway one beat longer.', decision: 'request-changes' });
    await waitFor(() => expect(screen.getByLabelText('Requested change').value).toBe(''));
  });

  it('offers a stage revision for open change requests and explains the blocked approval', async () => {
    const review = { ...reviewFixture(), revise: vi.fn(async () => ({ revision: { stage: 'storyboard', sceneIds: ['scene-a', 'scene-b'] } })) };
    review.readiness.storyboard = { approved: false, problems: ['Resolve storyboard feedback for shot: Chorus: Land the leap on the downbeat'] };
    const withRequests = { ...project, scenes: [{ sceneId: 'scene-a', label: 'Chorus', startSec: 0, endSec: 10 }],
      productionReview: { ...project.productionReview, feedback: [
        { id: 'fb-open', stage: 'storyboard', target: 'shot: Chorus', text: 'Land the leap on the downbeat', decision: 'request-changes', basis: 'board' },
        { id: 'fb-done', stage: 'storyboard', target: 'shot: Intro', text: 'Already handled', decision: 'request-changes', basis: 'board', resolvedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'fb-proof', stage: 'proof', target: 'frame: 0:04', text: 'Prop lands late', decision: 'request-changes', basis: 'same-creative-basis' },
      ] } };
    const board = render(<ProductionReviewPanel project={withRequests} review={review} onOpenArtifact={vi.fn()} stage="storyboard" />);
    expect(screen.queryByRole('group', { name: 'Animated proof change requests' })).toBeNull();
    const requests = screen.getByRole('group', { name: 'Lyric-timed storyboard change requests' });
    expect(requests.textContent).toContain('Approval stays blocked until these are resolved. Revise from feedback, or edit and resolve manually.');
    expect(requests.textContent).toContain('Land the leap on the downbeat');
    expect(requests.textContent).not.toContain('Already handled');
    fireEvent.click(within(requests).getByRole('button', { name: 'Revise from feedback' }));
    expect(review.revise).toHaveBeenCalledWith('storyboard');
    await waitFor(() => expect(requests.textContent).toContain('Revised 2 shots. Review them, then resolve each request.'));
    // A document-mode proof with no imported source can be re-authored as a generated candidate.
    board.unmount();
    render(<ProductionReviewPanel project={withRequests} review={review} onOpenArtifact={vi.fn()} stage="proof" />);
    expect(screen.queryByRole('group', { name: 'Lyric-timed storyboard change requests' })).toBeNull();
    const proofRequests = screen.getByRole('group', { name: 'Animated proof change requests' });
    expect(within(proofRequests).getByRole('button', { name: 'Revise from feedback' })).toBeTruthy();
  });

  it('keeps the hash-selected art approval open and highlighted when readiness arrives, until approved', () => {
    window.location.hash = '#mv-review-art';
    const review = reviewFixture(); review.readiness.art.approved = false;
    const view = render(<ProductionReviewPanel project={project} review={{ ...review, readiness: null }} onOpenArtifact={vi.fn()} stage="art" />);
    view.rerender(<ProductionReviewPanel project={project} review={review} onOpenArtifact={vi.fn()} stage="art" />);
    const box = document.getElementById('mv-review-art');
    expect(box).toBe(screen.getByRole('region', { name: 'Approve: Art direction' }));
    expect(box.tagName).toBe('SECTION');
    expect(within(box).getByRole('heading', { name: 'Approve the art direction' })).toBeTruthy();
    expect(box.className).toContain('border-port-accent');
    const approved = reviewFixture();
    view.rerender(<ProductionReviewPanel project={project} review={approved} onOpenArtifact={vi.fn()} stage="art" />);
    expect(within(box).getByRole('heading', { name: 'Art direction approved' })).toBeTruthy();
    expect(box.className).not.toContain('border-port-accent');
  });

  it('shows the recorded review for an approved artifact without treating it as fresh playback evidence', () => {
    const review = reviewFixture();
    review.readiness.proof.approved = true;
    const approved = { ...project, productionReview: { ...project.productionReview, approvals: { proof: { proofReview: {
      excerptId: 'proof-a', filename: 'proof-a.mp4', watchedWithAudio: true,
      energyComparison: 'The driving turn matches the saved energy target.', timecodedNotes: '0:04 — the figure turns on the downbeat.',
    } } } } };
    const view = render(<ProductionReviewPanel project={approved} review={review} onOpenArtifact={vi.fn()} stage="proof" />);
    expect(screen.getByLabelText('Recorded proof review').textContent).toContain('0:04 — the figure turns on the downbeat.');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByLabelText('Timecoded playback notes').value).toBe('');
    view.rerender(<ProductionReviewPanel project={{ ...approved, excerpts: [{ id: 'proof-a', filename: 'replacement.mp4', status: 'complete' }] }} review={review} onOpenArtifact={vi.fn()} stage="proof" />);
    expect(screen.queryByLabelText('Recorded proof review')).toBeNull();
  });

  it.each([
    { id: 'proof-b', filename: 'proof-b.mp4' },
    { id: 'proof-a', filename: 'replacement.mp4' },
  ])('requires new playback notes when the proof artifact changes to $filename without a creative-basis change', ({ id, filename }) => {
    const review = reviewFixture();
    const view = render(<ProductionReviewPanel project={project} review={review} onOpenArtifact={vi.fn()} stage="proof" />);
    recordPlayback();
    expect(screen.getByRole('button', { name: proofAction }).disabled).toBe(false);
    const replacement = { ...project, productionReview: { ...project.productionReview, proof: { ...project.productionReview.proof, excerptId: id } },
      excerpts: [{ id, filename, status: 'complete' }] };
    view.rerender(<ProductionReviewPanel project={replacement} review={review} onOpenArtifact={vi.fn()} stage="proof" />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByLabelText('Playback energy compared with the saved plan').value).toBe('');
    expect(screen.getByLabelText('Timecoded playback notes').value).toBe('');
    expect(screen.getByRole('button', { name: proofAction }).disabled).toBe(true);
    recordPlayback();
    fireEvent.click(screen.getByRole('button', { name: proofAction }));
    expect(review.approve).toHaveBeenCalledWith('proof', expect.objectContaining({
      excerptId: id, filename, watchedWithAudio: true, energyComparison: 'The driving turn matches the chosen energy.',
      timecodedNotes: '0:04 — figure turns on the downbeat; prop follows at 4.5s.',
    }));
  });

  it('blocks approval and explains a failed proof player', () => {
    const review = reviewFixture();
    render(<ProductionReviewPanel project={project} review={review} onOpenArtifact={vi.fn()} stage="proof" />);
    recordPlayback();
    fireEvent.error(screen.getByLabelText('Animated proof with master audio'));
    expect(screen.getByRole('alert').textContent).toContain('could not be played');
    expect(screen.getByRole('button', { name: proofAction }).disabled).toBe(true);
  });

  it('keeps failed choreography saves dirty and blocks approval', async () => {
    const review = reviewFixture();
    // The page owns the planning draft so unsaved edits on the art step still block the proof step.
    function Steps({ stage }) {
      const planning = useState(null);
      return <ProductionReviewPanel key={stage} project={project} review={review} onOpenArtifact={vi.fn()} stage={stage} planning={planning} />;
    }
    const view = render(<Steps stage="art" />);
    fireEvent.change(screen.getByLabelText('Timed choreography and energy plan'), { target: { value: 'Energy target: explosive. 0:04 — replace the turn with a leap.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save planning edits', hidden: true }));
    await waitFor(() => expect(review.save).toHaveBeenCalled());
    expect(screen.getByText('Save edits before preparing, approving or rendering.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve art direction' }).disabled).toBe(true);
    view.rerender(<Steps stage="proof" />);
    fireEvent.loadedData(screen.getByLabelText('Animated proof with master audio'));
    expect(screen.getByText('Save your planning edits before approving this revision.', { selector: '#mv-review-example-project-proof-approval-help' })).toBeTruthy();
    expect(screen.getByLabelText('Timecoded playback notes').disabled).toBe(true);
    expect(screen.getByRole('button', { name: proofAction }).disabled).toBe(true);
    expect(review.approve).not.toHaveBeenCalled();
  });
});

describe('Lyric timing lives on the Song step', () => {
  it('leaves song content and timing verification out of the storyboard planning editor', () => {
    const review = reviewFixture();
    review.readiness.alignment = { status: 'stale', basis: 'current-word-times' };
    render(<ProductionReviewPanel project={project} review={review} onOpenArtifact={vi.fn()} stage="storyboard" />);
    fireEvent.click(screen.getByText('Edit storyboard shots'));
    expect(screen.queryByLabelText('Song content')).toBeNull();
    expect(screen.queryByLabelText('Alignment status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reverify current timings' })).toBeNull();
    // The storyboard source stays here: it is the storyboard's own input.
    expect(screen.getByLabelText('Storyboard source')).toBeTruthy();
  });
});

describe('Per-stage approval sections (#10151)', () => {
  it('renders only its own stage and sends a missing prerequisite to the tab that owns it', () => {
    const review = reviewFixture();
    review.readiness.art.approved = false;
    const prototype = { ...project, productionReview: { ...project.productionReview, proof: null, prototype: { excerptId: 'proof-a' } } };
    const onNavigate = vi.fn();
    render(<ProductionReviewPanel project={prototype} review={review} onOpenArtifact={vi.fn()} stage="proof" onNavigate={onNavigate} />);
    expect(screen.queryByText('Art direction', { selector: 'summary' })).toBeNull();
    expect(screen.queryByText('Edit art direction and visual guide')).toBeNull();
    fireEvent.click(screen.getByText('Review and approve art direction'));
    expect(onNavigate).toHaveBeenCalledWith('cast-sets', 'mv-review-art');
  });

  it('keeps the art fields on the art section and the shot editor on the board section', () => {
    const art = render(<ProductionReviewPanel project={project} review={reviewFixture()} onOpenArtifact={vi.fn()} stage="art" />);
    expect(screen.getByLabelText('Cast guide')).toBeTruthy();
    expect(screen.queryByLabelText('Storyboard source')).toBeNull();
    art.unmount();
    render(<ProductionReviewPanel project={project} review={reviewFixture()} onOpenArtifact={vi.fn()} stage="storyboard" />);
    expect(screen.getByLabelText('Storyboard source')).toBeTruthy();
    expect(screen.queryByLabelText('Cast guide')).toBeNull();
  });

  it('shows the approval on its step as an open box that closes the step, not a fold', () => {
    const review = reviewFixture();
    review.readiness.storyboard.approved = false;
    const { container } = render(<ProductionReviewPanel project={project} review={review} onOpenArtifact={vi.fn()} stage="storyboard" />);
    const box = screen.getByRole('region', { name: 'Approve: Lyric-timed storyboard' });
    expect(box.id).toBe('mv-review-storyboard');
    expect(box.tagName).toBe('SECTION');
    expect(within(box).getByRole('heading', { name: 'Approve the lyric-timed storyboard' })).toBeTruthy();
    expect(within(box).getByRole('button', { name: 'Approve lyric-timed storyboard' })).toBeTruthy();
    expect(within(box).getByRole('button', { name: 'Request changes' })).toBeTruthy();
    expect(container.querySelector('details#mv-review-storyboard')).toBeNull();
    expect(screen.queryByText('About production approvals')).toBeNull();
  });
});
