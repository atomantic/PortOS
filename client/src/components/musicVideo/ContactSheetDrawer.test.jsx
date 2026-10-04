import { act, render, screen, fireEvent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import ContactSheetDrawer from './ContactSheetDrawer.jsx';

const take = (id, kind, status = 'candidate') => ({ takeId: `t-${id}`, kind, assetId: id, source: 'generated', status });
const scenes = [
  { sceneId: 's1', order: 0, label: 'Decided', referenceImageId: 'a.png', takes: [take('a.png', 'image')] },
  { sceneId: 's2', order: 1, label: 'Undecided', referenceImageId: 'b.png', takes: [take('b.png', 'image'), take('c.png', 'image')] },
];
const props = { open: true, onClose: () => {}, project: { name: 'Example', scenes }, busy: false, onSelectTake: vi.fn(), onReviewTake: vi.fn(), onOpenPreview: vi.fn() };

it('Pending decisions shows only scenes with an undecided candidate', () => {
  const { rerender } = render(<ContactSheetDrawer {...props} />);
  expect(screen.getByText(/Decided/)).toBeInTheDocument();
  rerender(<ContactSheetDrawer {...props} pendingOnly />);
  expect(screen.queryByText(/1\. Decided/)).not.toBeInTheDocument();
  expect(screen.getByText(/2\. Undecided/)).toBeInTheDocument();
});

it('regenerates a scene frame and moves focus with the arrow keys', () => {
  const onRegenerateFrame = vi.fn();
  render(<ContactSheetDrawer {...props} onRegenerateFrame={onRegenerateFrame} />);
  fireEvent.click(screen.getAllByRole('button', { name: /Regenerate frame/ })[1]);
  expect(onRegenerateFrame).toHaveBeenCalledWith(scenes[1]);
  const thumbs = screen.getAllByRole('button', { name: /View frame take full size/ });
  act(() => thumbs[1].focus());
  fireEvent.keyDown(thumbs[1], { key: 'ArrowRight' });
  expect(document.activeElement).toBe(thumbs[2]);
  fireEvent.keyDown(thumbs[2], { key: 'ArrowUp' });
  expect(document.activeElement).toBe(thumbs[0]);
});
