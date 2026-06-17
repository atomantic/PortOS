import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CharacterDetailEditor from './CharacterDetailEditor';

// Mock VoicePicker — it pulls in the voice API/socket layer the relationship
// tests don't care about.
vi.mock('../voice/VoicePicker', () => ({ default: () => null }));

const ARIA = { id: 'chr-aria', name: 'Aria' };
const BRAM = { id: 'chr-bram', name: 'Bram' };
const CASS = { id: 'chr-cass', name: 'Cass' };

// CollapsibleSection starts closed — open the Relationships one by clicking its
// header button.
const openRelationships = () => {
  fireEvent.click(screen.getByRole('button', { name: /Relationships/i }));
};

describe('CharacterDetailEditor — Relationships (#1287)', () => {
  it('prompts to add more cast when there are no other characters', () => {
    render(<CharacterDetailEditor entry={ARIA} characters={[ARIA]} onPatch={() => {}} />);
    openRelationships();
    expect(screen.getByText(/Add another character to the cast/i)).toBeInTheDocument();
  });

  it('adds a link defaulting to the first other character + custom type', () => {
    const onPatch = vi.fn();
    render(<CharacterDetailEditor entry={ARIA} characters={[ARIA, BRAM, CASS]} onPatch={onPatch} />);
    openRelationships();
    fireEvent.click(screen.getByRole('button', { name: /Add relationship/i }));
    expect(onPatch).toHaveBeenCalledWith({
      relationshipLinks: [{ targetCharacterId: 'chr-bram', type: 'custom', description: '' }],
    });
  });

  it('renders an existing link with target + type selects', () => {
    const entry = {
      ...ARIA,
      relationshipLinks: [{ id: 'rel-1', targetCharacterId: 'chr-bram', type: 'ally' }],
    };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA, BRAM]} onPatch={() => {}} />);
    openRelationships();
    const target = screen.getByRole('combobox', { name: /relationship 1 target character/i });
    expect(target).toHaveValue('chr-bram');
    const type = screen.getByRole('combobox', { name: /relationship 1 type/i });
    expect(type).toHaveValue('ally');
  });

  it('patches the type when the type select changes', () => {
    const onPatch = vi.fn();
    const entry = {
      ...ARIA,
      relationshipLinks: [{ id: 'rel-1', targetCharacterId: 'chr-bram', type: 'ally' }],
    };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA, BRAM]} onPatch={onPatch} />);
    openRelationships();
    fireEvent.change(screen.getByRole('combobox', { name: /relationship 1 type/i }), {
      target: { value: 'rival' },
    });
    expect(onPatch).toHaveBeenCalledWith({
      relationshipLinks: [{ id: 'rel-1', targetCharacterId: 'chr-bram', type: 'rival' }],
    });
  });

  it('tags an opposing force, surfacing the axis editor', () => {
    const onPatch = vi.fn();
    const entry = {
      ...ARIA,
      relationshipLinks: [{ id: 'rel-1', targetCharacterId: 'chr-bram', type: 'antagonist' }],
    };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA, BRAM]} onPatch={onPatch} />);
    openRelationships();
    fireEvent.click(screen.getByRole('button', { name: /Tag opposing force/i }));
    expect(onPatch).toHaveBeenCalledWith({
      relationshipLinks: [{
        id: 'rel-1',
        targetCharacterId: 'chr-bram',
        type: 'antagonist',
        opposition: { axis: 'custom', thisRole: '', targetRole: '', note: '' },
      }],
    });
  });

  it('shows the opposition count in the collapsed summary', () => {
    const entry = {
      ...ARIA,
      relationshipLinks: [
        { id: 'rel-1', targetCharacterId: 'chr-bram', opposition: { axis: 'hunter/prey' } },
        { id: 'rel-2', targetCharacterId: 'chr-cass' },
      ],
    };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA, BRAM, CASS]} onPatch={() => {}} />);
    // Summary renders inside the collapsed header.
    expect(screen.getByText(/2 links · 1 opposing/i)).toBeInTheDocument();
  });
});
