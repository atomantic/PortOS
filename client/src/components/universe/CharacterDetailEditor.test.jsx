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

  it('keeps an existing link removable even when there is no other cast', () => {
    // Target was deleted, leaving Aria the only character. The link must still
    // render (with a delete button) instead of being hidden behind the
    // add-more-cast prompt — otherwise the dangling-target check flags a
    // problem the UI won't let the user fix.
    const onPatch = vi.fn();
    const entry = {
      ...ARIA,
      relationshipLinks: [{ id: 'rel-1', targetCharacterId: 'chr-deleted', type: 'rival' }],
    };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA]} onPatch={onPatch} />);
    openRelationships();
    // Dangling target is surfaced as a "(missing: …)" option.
    expect(screen.getByText(/missing: chr-deleted/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /remove relationship 1/i }));
    expect(onPatch).toHaveBeenCalledWith({ relationshipLinks: [] });
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

describe('CharacterDetailEditor — character framework (#2175)', () => {
  const openArc = () => fireEvent.click(screen.getByRole('button', { name: /Arc type & sliders/i }));

  it('renders the arc-type select seeded from the entry and patches on change', () => {
    const onPatch = vi.fn();
    render(<CharacterDetailEditor entry={{ ...ARIA, arcType: 'positive' }} characters={[ARIA]} onPatch={onPatch} />);
    openArc();
    const select = screen.getByLabelText(/Arc type/i);
    expect(select).toHaveValue('positive');
    fireEvent.change(select, { target: { value: 'negative' } });
    expect(onPatch).toHaveBeenCalledWith({ arcType: 'negative' });
  });

  it('patches a slider value, merging with existing sliders', () => {
    const onPatch = vi.fn();
    const entry = { ...ARIA, sliders: { proactivity: 8, likability: null, competence: null } };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA]} onPatch={onPatch} />);
    openArc();
    fireEvent.change(screen.getByLabelText(/likability rating 1 to 10/i), { target: { value: '6' } });
    expect(onPatch).toHaveBeenCalledWith({ sliders: { proactivity: 8, likability: 6, competence: null } });
  });

  it('clears a set slider back to unset (null)', () => {
    const onPatch = vi.fn();
    const entry = { ...ARIA, sliders: { proactivity: 9, likability: null, competence: null } };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA]} onPatch={onPatch} />);
    openArc();
    fireEvent.click(screen.getByRole('button', { name: /Clear proactivity/i }));
    expect(onPatch).toHaveBeenCalledWith({ sliders: { proactivity: null, likability: null, competence: null } });
  });

  it('marshals the secrets string list to/from row objects', () => {
    const onPatch = vi.fn();
    const entry = { ...ARIA, secrets: ['forged the charter'] };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA]} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('button', { name: /Secrets/i }));
    // Existing secret is rendered in its row input.
    const input = screen.getByDisplayValue('forged the charter');
    fireEvent.change(input, { target: { value: 'forged the charter and the seal' } });
    fireEvent.blur(input);
    // Commits back as a plain string[] (not row objects).
    expect(onPatch).toHaveBeenCalledWith({ secrets: ['forged the charter and the seal'] });
  });

  it('exposes the Ghost→Wound→Lie→Want→Need prose fields', () => {
    render(<CharacterDetailEditor entry={{ ...ARIA, lie: 'I only matter if I win' }} characters={[ARIA]} onPatch={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Character framework/i }));
    expect(screen.getByDisplayValue('I only matter if I win')).toBeInTheDocument();
  });
});
