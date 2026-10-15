import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import SceneFrameReferences from './SceneFrameReferences.jsx';

const project = { visualSpec: { references: [
  { id: 'r1', imageId: 'lead.png', role: 'character', label: 'Lead — character sheet, black sweater', condition: true },
  { id: 'r2', imageId: 'pier.png', role: 'set', label: 'The pier at night', note: 'wet boards, sodium lights', condition: false },
] } };
const scene = { sceneId: 's1' };

describe('a shot\'s References row', () => {
  // Uniquely catches a truncated reference chip with no way to see its sheet and full name, or a long-press that also adds it.
  it('previews a reference large on mouse hover, and on a long-press without adding it', () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    render(<SceneFrameReferences project={project} scene={scene} onEditLocal={vi.fn()} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const pier = screen.getByRole('button', { name: /The pier at night/ });

    fireEvent.pointerEnter(pier, { pointerType: 'mouse' });
    const preview = screen.getByRole('figure', { name: 'Preview of The pier at night' });
    expect(preview.textContent).toContain('wet boards, sodium lights');
    fireEvent.pointerLeave(pier, { pointerType: 'mouse' });
    expect(screen.queryByRole('figure')).toBeNull();

    fireEvent.pointerDown(pier, { pointerType: 'touch' });
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.pointerUp(pier, { pointerType: 'touch' });
    fireEvent.click(pier);
    expect(screen.getByRole('figure', { name: 'Preview of The pier at night' })).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByRole('figure')).toBeNull();

    // A plain tap still adds it.
    fireEvent.click(pier);
    expect(onSave).toHaveBeenCalledWith('s1', { frameReferenceIds: ['r1', 'r2'] });
    vi.useRealTimers();
  });
});
