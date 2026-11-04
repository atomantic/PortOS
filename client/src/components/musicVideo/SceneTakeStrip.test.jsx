import { plateReviewEvidence, plateRequirements } from '../../../../server/lib/musicVideoPlateEvidence.js';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SceneTakeStrip from './SceneTakeStrip.jsx';

const take = (takeId, assetId, extra = {}) => ({ takeId, kind: 'image', assetId, status: 'candidate', source: 'generated', ...extra });
const scene = { sceneId: 's1', order: 0, referenceImageId: 'a.png', takes: [take('t1', 'a.png'), take('t2', 'b.png', { status: 'rejected' })] };

describe('rejecting a take versus marking it bad', () => {
  // Uniquely catches a take rejected from this shot reading as bad, or the Bad toggle not reaching the project-wide mark.
  it('shows a rejected take as not for this shot, and marks or clears bad on its own', () => {
    const onMark = vi.fn();
    const { rerender } = render(<SceneTakeStrip scene={scene} kind="image" marks={{}} onMark={onMark} />);
    expect(screen.getByText('Not for this shot')).toBeTruthy();
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
