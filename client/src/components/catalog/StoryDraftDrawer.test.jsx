import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StoryDraftDrawer from './StoryDraftDrawer';
import { draftCatalogStoryMember } from '../../services/apiCatalog.js';

vi.mock('../../services/apiCatalog.js', () => ({
  createCatalogIngredient: vi.fn(),
  draftCatalogStoryMember: vi.fn(),
  joinCatalogStory: vi.fn(),
}));

vi.mock('../musicVideo/MusicVideoLlmPicker', () => ({ default: () => null }));
vi.mock('./CatalogFamilyPicker', () => ({
  default: ({ items, onAdd }) => (
    <button type="button" onClick={() => onAdd('mother', { id: 'cast-1', name: 'Example relative' })}>
      {items[0]?.name || 'Add relative'}
    </button>
  ),
}));

const character = { type: 'character', singular: 'character', label: 'Casting' };
const object = { type: 'object', singular: 'object', label: 'Objects' };
const universes = [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }];
const story = { id: 'story-1', kind: 'series', name: 'First Story', joinable: true, universeIds: ['first'] };
const result = (name) => ({ draft: { name, content: 'Description' } });

function renderDrawer() {
  const onClose = vi.fn();
  const view = (props) => (
    <StoryDraftDrawer open library={character} universes={universes} stories={[story]} initialStory={story}
      initialUniverseId="first" onClose={onClose} onSaved={vi.fn()} {...props} />
  );
  const { rerender } = render(view());
  return { onClose, update: (props) => rerender(view(props)) };
}

function startDraft(prompt = 'A draft prompt') {
  fireEvent.change(screen.getByLabelText(/^Describe the/), { target: { value: prompt } });
  fireEvent.click(screen.getByRole('button', { name: 'Draft', exact: true }));
}

function queueDraft() {
  const pending = Promise.withResolvers();
  vi.mocked(draftCatalogStoryMember).mockReturnValueOnce(pending.promise);
  return pending;
}

describe('StoryDraftDrawer', () => {
  beforeEach(() => vi.resetAllMocks());

  it('resets edited draft and family on reopen with a different destination', async () => {
    const { update } = renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Add relative' }));
    vi.mocked(draftCatalogStoryMember).mockResolvedValueOnce(result('Generated'));
    startDraft();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Edited' } });
    expect(screen.getByRole('button', { name: 'Example relative' })).toBeInTheDocument();

    update({ open: false });
    update({ initialUniverseId: 'second', initialStory: null });
    expect(screen.getByLabelText('Universe')).toHaveValue('second');
    expect(screen.getByLabelText('Joins story')).toHaveValue('');
    expect(screen.getByLabelText('Describe the character')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Add relative' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).toBeNull();
  });

  it.each(['reopen', 'library change', 'universe change'])('ignores a superseded response after %s', async (transition) => {
    const { update } = renderDrawer();
    const stale = queueDraft();
    startDraft();
    if (transition === 'reopen') {
      update({ open: false });
      update();
    } else if (transition === 'library change') {
      update({ library: object });
      expect(screen.getByLabelText('Describe the object')).toHaveValue('');
    } else {
      fireEvent.change(screen.getByLabelText('Universe'), { target: { value: 'second' } });
      expect(screen.getByLabelText('Joins story')).toHaveValue('');
    }

    const current = queueDraft();
    startDraft('Current prompt');
    await act(async () => stale.resolve(result('Stale')));
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.getByRole('button', { name: 'Drafting…' })).toBeDisabled();
    await act(async () => current.resolve(result('Current')));
    expect(screen.getByLabelText('Name')).toHaveValue('Current');
  });

  it('protects running and edited drafts from accidental dismissal and blocks Save during a redraft', async () => {
    const { onClose } = renderDrawer();
    const tryDismiss = () => {
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.click(screen.getByRole('dialog').previousElementSibling);
    };
    tryDismiss();
    expect(onClose).toHaveBeenCalledTimes(2);
    onClose.mockClear();

    const first = queueDraft();
    startDraft();
    tryDismiss();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => first.resolve(result('Generated')));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Edited' } });
    tryDismiss();
    expect(onClose).not.toHaveBeenCalled();

    const second = queueDraft();
    startDraft();
    expect(screen.getByRole('button', { name: 'Save to First Story' })).toBeDisabled();
    await act(async () => second.resolve(result('Updated')));
    expect(screen.getByRole('button', { name: 'Save to First Story' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Close new from prompt' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
