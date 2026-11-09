import { plateReviewEvidence, plateRequirements } from '../../../../server/lib/musicVideoPlateEvidence.js';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SceneTakeStrip from './SceneTakeStrip.jsx';

const take = (takeId, assetId, extra = {}) => ({ takeId, kind: 'image', assetId, status: 'candidate', source: 'generated', ...extra });
const scene = { sceneId: 's1', order: 0, referenceImageId: 'a.png', takes: [take('t1', 'a.png'), take('t2', 'b.png', { status: 'rejected' })] };

it('flags a clip whose external cast guides cannot be tracked', () => {
  const clip = { takeId: 'v1', kind: 'video', assetId: 'clip', status: 'candidate',
    dependencies: { version: 1, references: [{ role: 'clipReferences', untrackedCastGuides: true }] } };
  render(<SceneTakeStrip scene={{ ...scene, takes: [clip] }} kind="video" />);
  expect(screen.getByText(/Cast guide changes are not tracked/)).toBeTruthy();
});

describe('rejecting a take versus marking it bad', () => {
  // Uniquely catches a take rejected from this shot reading as bad, or the Bad toggle not reaching the project-wide mark.
  it('offers Restore on a rejected take without a label, and marks or clears bad on its own', () => {
    const onMark = vi.fn();
    const { rerender } = render(<SceneTakeStrip scene={scene} kind="image" marks={{}} onMark={onMark} />);
    expect(screen.queryByText('Not for this shot')).toBeNull();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
    expect(screen.queryByText(/generated/)).toBeNull();
    expect(screen.queryByText('Bad', { selector: 'span' })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Bad' })[1]);
    expect(onMark).toHaveBeenCalledWith(scene.takes[1], 'bad');
    rerender(<SceneTakeStrip scene={scene} kind="image" marks={{ 'image:b.png': 'bad' }} onMark={onMark} />);
    const toggle = screen.getAllByRole('button', { name: 'Bad' })[1];
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    expect(onMark).toHaveBeenLastCalledWith(scene.takes[1], null);
  });
});

// Uniquely pins the displayed defect and exact acknowledgement payload on the take the operator saw.
it('shows a rendering defect with an acknowledgement bound to that image and note', () => {
  const selected = { ...scene, framePrompt: 'A desk with a chair', takes: [take('t1', 'a.png')] };
  selected.takes[0].plateEvidence = plateReviewEvidence(selected, 'a.png', 'run-example', JSON.stringify({ checks: plateRequirements(selected).map(({ id }) => ({
    id, status: id === 'render-quality' ? 'fail' : 'pass', note: id === 'render-quality' ? 'The chair is fused into the desk.' : 'Matches',
  })) }));
  const onReview = vi.fn();
  render(<SceneTakeStrip scene={selected} kind="image" onReview={onReview} />);
  expect(screen.getByText('Rendering defect: The chair is fused into the desk.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge rendering defect' }));
  expect(onReview).toHaveBeenCalledWith(selected.takes[0], { acknowledgeRenderQuality: { basis: selected.takes[0].plateEvidence.basis, note: 'The chair is fused into the desk.' } });
});

// Uniquely catches an unchecked frame wearing a verdict badge, the Check action not reaching its handler,
// or a check's misses staying hidden behind the badge.
it('shows a verdict only after a check, opens it to the misses, and checks a frame in place', () => {
  const onCheck = vi.fn();
  const fresh = { ...scene, framePrompt: 'A desk with a chair', takes: [take('t1', 'a.png')] };
  const { rerender } = render(<SceneTakeStrip scene={fresh} kind="image" onCheck={onCheck} checking={new Set()} />);
  expect(screen.queryByText(/Unverified|Unclear|Issues|Checked/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  expect(onCheck).toHaveBeenCalledWith(fresh.takes[0]);

  rerender(<SceneTakeStrip scene={fresh} kind="image" onCheck={onCheck} checking={new Set(['t1'])} />);
  expect(screen.getByRole('button', { name: 'Checking' })).toBeDisabled();

  fresh.takes[0].plateEvidence = plateReviewEvidence(fresh, 'a.png', 'manual-example', JSON.stringify({ checks: plateRequirements(fresh).map(({ id }) => ({
    id, status: id === 'plate-prompt' ? 'fail' : 'pass', note: id === 'plate-prompt' ? 'There is no chair.' : 'Clean',
  })) }));
  rerender(<SceneTakeStrip scene={{ ...fresh }} kind="image" onCheck={onCheck} checking={new Set()} />);
  expect(screen.queryByText('There is no chair.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Issues (1)' }));
  expect(screen.getByText('There is no chair.')).toBeInTheDocument();
});

// Uniquely catches the take card's copy actions reverting to the full-width buttons.
it('shows compact copy chips on a take card', () => {
  render(<SceneTakeStrip scene={scene} kind="image" />);
  const copyId = screen.getAllByRole('button', { name: 'Copy ID' })[0];
  expect(copyId.textContent.trim()).toBe('ID');
});
