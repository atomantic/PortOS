import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { finalApprovalPatch } from '../../../../server/lib/musicVideo/musicVideoFinalApproval.js';
import SceneFinalApproval from './SceneFinalApproval.jsx';

const draft = { takeId: 't1', kind: 'video', assetId: 'v1', tier: 'draft', status: 'candidate', createdAt: '2026-11-01T00:00:00Z' };
const base = { sceneId: 's1', prompt: 'a dancer', referenceImageId: 'f1.png', videoHistoryId: 'v1', takes: [draft] };
const approved = { ...base, ...finalApprovalPatch(base, true).patch };

it('ticks the selected draft for final and shows the tick only while the approval still matches', async () => {
  const onApprove = vi.fn().mockResolvedValue(true);
  const { rerender } = render(<SceneFinalApproval scene={base} onApprove={onApprove} />);
  const box = screen.getByLabelText(/Approve for final/);
  expect(box.checked).toBe(false);
  fireEvent.click(box);
  expect(onApprove).toHaveBeenCalledWith(['s1'], true);
  await waitFor(() => expect(screen.getByLabelText(/Approve for final/).disabled).toBe(false));

  rerender(<SceneFinalApproval scene={approved} onApprove={onApprove} />);
  expect(screen.getByLabelText(/Approve for final/).checked).toBe(true);
  expect(screen.queryByTestId('final-approval-cleared')).toBeNull();

  // A later reference change clears it, and the card says why instead of silently unticking.
  rerender(<SceneFinalApproval scene={{ ...approved, referenceImageId: 'f2.png' }} onApprove={onApprove} />);
  expect(screen.getByLabelText(/Approve for final/).checked).toBe(false);
  expect(screen.getByTestId('final-approval-cleared')).toBeTruthy();
});

it('compares an unselected final re-render beside the draft and uses it only when picked', () => {
  const finalTake = { takeId: 't2', kind: 'video', assetId: 'v2', tier: 'final', status: 'candidate', createdAt: '2026-11-02T00:00:00Z' };
  const onSelectTake = vi.fn();
  render(<SceneFinalApproval scene={{ ...approved, takes: [draft, finalTake] }} onApprove={vi.fn()} onSelectTake={onSelectTake} />);
  expect(screen.getByLabelText('Selected draft take').getAttribute('src')).toBe('/data/videos/v1.mp4');
  expect(screen.getByLabelText('Final re-render take').getAttribute('src')).toBe('/data/videos/v2.mp4');
  expect(onSelectTake).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Use the final take' }));
  expect(onSelectTake).toHaveBeenCalledWith(expect.objectContaining({ sceneId: 's1' }), finalTake);
});

it('says a final clip is final and offers no tick or compare', () => {
  const finalTake = { ...draft, tier: 'final' };
  render(<SceneFinalApproval scene={{ ...base, takes: [finalTake, { ...draft, takeId: 't0', assetId: 'v0' }] }} onApprove={vi.fn()} />);
  expect(screen.getByText(/The selected clip is the final render/)).toBeTruthy();
  expect(screen.queryByLabelText(/Approve for final/)).toBeNull();
  expect(screen.queryByTestId('final-take-compare')).toBeNull();
});
