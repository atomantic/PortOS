import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SceneCastVariant from './SceneCastVariant.jsx';

const project = { concept: { subjects: [
  { id: 'mvc-1', kind: 'character', name: 'Example Lead', ingredientId: 'cat-chr-x' },
  { id: 'mvc-2', kind: 'character', name: 'Not in Casting' },
] } };

describe('a shot\'s Cast guides picker', () => {
  // Uniquely catches the picker offering subjects with no Casting record, or the variant not reaching the scene PATCH.
  it('saves the picked Casting member, then its age, era and look', () => {
    const onSave = vi.fn();
    const { rerender } = render(<SceneCastVariant project={project} scene={{ sceneId: 's1' }} onEditLocal={vi.fn()} onSave={onSave} />);
    const member = screen.getByLabelText('Cast guides');
    expect([...member.options].map((o) => o.textContent)).toEqual(['None', 'Example Lead']);
    fireEvent.change(member, { target: { value: 'cat-chr-x' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { characterVariant: { ingredientId: 'cat-chr-x' } });

    const castMedia = { 'cat-chr-x': [{ mediaKey: 'a.png', kind: 'reference', library: { variant: { wardrobeId: 'look-1' } } }] };
    rerender(<SceneCastVariant project={project} scene={{ sceneId: 's1', characterVariant: { ingredientId: 'cat-chr-x' } }} castMedia={castMedia} onEditLocal={vi.fn()} onSave={onSave} />);
    const age = screen.getByLabelText('Age');
    fireEvent.change(age, { target: { value: '7' } });
    fireEvent.blur(age);
    expect(onSave).toHaveBeenLastCalledWith('s1', { characterVariant: { ingredientId: 'cat-chr-x', age: 7 } });

    rerender(<SceneCastVariant project={project} scene={{ sceneId: 's1', characterVariant: { ingredientId: 'cat-chr-x', age: 7 } }} castMedia={castMedia} onEditLocal={vi.fn()} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('Era'), { target: { value: 'child' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { characterVariant: { ingredientId: 'cat-chr-x', age: 7, era: 'child' } });
    fireEvent.change(screen.getByLabelText('Look'), { target: { value: 'look-1' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { characterVariant: { ingredientId: 'cat-chr-x', age: 7, wardrobeId: 'look-1' } });
    fireEvent.change(screen.getByLabelText('Cast guides'), { target: { value: '' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { characterVariant: null });
  });

  it('renders nothing when no subject is saved to Casting', () => {
    const { container } = render(<SceneCastVariant project={{ concept: { subjects: [project.concept.subjects[1]] } }} scene={{ sceneId: 's1' }} onEditLocal={vi.fn()} onSave={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
