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

  // Uniquely catches a removed reference's preview staying open (its chip unmounts under the cursor, so no pointerleave).
  it('closes the preview of a reference taken off the shot', () => {
    render(<SceneFrameReferences project={project} scene={scene} onEditLocal={vi.fn()} onSave={vi.fn()} />);
    fireEvent.pointerEnter(screen.getByTitle(/^Lead/), { pointerType: 'mouse' });
    expect(screen.getByRole('figure', { name: /Preview of Lead/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Don't send Lead/ }));
    expect(screen.queryByRole('figure')).toBeNull();
  });

  it('shows an approved overflow face sheet and lets the director remove it from the shot', () => {
    const onSave = vi.fn();
    const full = {
      visualSpec: { references: [{ id: 'mvr-cs-character', imageId: 'lead.png', role: 'character', label: 'Lead' }] },
      castAndSets: { status: 'approved', direction: { cast: [] }, overflowFaceReferences: [{ id: 'mvr-cs-expressions', imageId: 'face.png', role: 'character', label: 'Lead face sheet' }] },
    };
    render(<SceneFrameReferences project={full} scene={{ sceneId: 's1', framePrompt: 'Close up of Lead' }} onEditLocal={vi.fn()} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: "Don't send Lead face sheet" }));
    expect(onSave).toHaveBeenCalledWith('s1', { frameReferenceIds: ['mvr-cs-character'] });
  });
});

describe('a shot that names a Casting cast member', () => {
  // Uniquely catches the References row hiding the Casting guides a frame render sends, or removing one dropping the rest.
  it('shows only age-compatible guides and keeps them when another reference is taken off', () => {
    const cast = { ...project, concept: { subjects: [{ id: 'mvc-1', kind: 'character', name: 'Example Lead', ingredientId: 'cat-chr-x' }] } };
    const castMedia = { 'cat-chr-x': [
      { mediaKey: 'adult.png', kind: 'reference', library: { variant: { age: 30 }, guide: true } },
      { mediaKey: 'child.png', kind: 'reference', library: { variant: { age: 7 }, guide: true } },
    ] };
    const onSave = vi.fn();
    render(<SceneFrameReferences project={cast} scene={{ sceneId: 's1', characterVariant: { ingredientId: 'cat-chr-x', age: 7 } }} castMedia={castMedia} onEditLocal={vi.fn()} onSave={onSave} />);
    expect(screen.getAllByRole('listitem').map((li) => li.getAttribute('title')).filter(Boolean)).toEqual(['Example Lead · age 7', expect.stringMatching(/^Lead/)]);
    fireEvent.click(screen.getByRole('button', { name: /Don't send Lead/ }));
    expect(onSave).toHaveBeenCalledWith('s1', { frameReferenceIds: ['mvr-guide-child.png'] });
  });
});

describe('a shot whose Casting guides are still loading', () => {
  // Uniquely catches an edit made before the guides load saving the shot's references without them.
  it('locks the row until the cast member\'s media arrives', () => {
    const scene = { sceneId: 's1', characterVariant: { ingredientId: 'cat-chr-x' }, frameReferenceIds: ['r1', 'mvr-guide-child.png'] };
    const { rerender } = render(<SceneFrameReferences project={project} scene={scene} castMedia={{}} onEditLocal={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Don't send Lead/ }).disabled).toBe(true);
    rerender(<SceneFrameReferences project={project} scene={scene} castMedia={{ 'cat-chr-x': null }} onEditLocal={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Don't send Lead/ }).disabled).toBe(false);
  });
});

describe('a shot whose Casting guides failed to load', () => {
  // Uniquely catches an edit made while guides are unresolved permanently dropping the saved guide ids.
  it('keeps saved guide ids that do not resolve when another reference is taken off', () => {
    const onSave = vi.fn();
    const scene = { sceneId: 's1', characterVariant: { ingredientId: 'cat-chr-x' }, frameReferenceIds: ['r1', 'r2', 'mvr-guide-child.png'] };
    render(<SceneFrameReferences project={project} scene={scene} castMedia={{ 'cat-chr-x': null }} onEditLocal={vi.fn()} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Don't send Lead/ }));
    expect(onSave).toHaveBeenCalledWith('s1', { frameReferenceIds: ['r2', 'mvr-guide-child.png'] });
  });
});
