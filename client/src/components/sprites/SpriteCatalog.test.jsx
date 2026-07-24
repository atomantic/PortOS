/**
 * Sprite Catalog — the routable Library view. Covers the two record-CRUD paths
 * the modal never had: rename in place (the user has records whose generated
 * names are wrong) and delete behind a cautious inline confirm. Also pins the
 * grouped/filtered grid and that opening a card reports the id up.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SpriteCatalog from './SpriteCatalog.jsx';

const updateSpriteRecord = vi.fn();
const deleteSpriteRecord = vi.fn();
vi.mock('../../services/apiSprites.js', () => ({
  updateSpriteRecord: (...a) => updateSpriteRecord(...a),
  deleteSpriteRecord: (...a) => deleteSpriteRecord(...a),
}));

const RECORDS = [
  { id: 'trail-hand', name: 'Trail Hand', kind: 'character', status: 'draft' },
  { id: 'bad-name-9x', name: 'sdxl_0007_final', kind: 'character', status: 'draft' },
  { id: 'saloon', name: 'Saloon', kind: 'place', status: 'imported' },
];

function renderCatalog(props = {}) {
  return render(
    <SpriteCatalog
      records={RECORDS}
      thumbs={new Map([['trail-hand', 'reference/main.png']])}
      onOpen={props.onOpen || (() => {})}
      onRenamed={props.onRenamed || (() => {})}
      onDeleted={props.onDeleted || (() => {})}
    />,
  );
}

beforeEach(() => { updateSpriteRecord.mockReset(); deleteSpriteRecord.mockReset(); });

describe('SpriteCatalog', () => {
  it('groups records and opens a card by id', async () => {
    const onOpen = vi.fn();
    renderCatalog({ onOpen });

    // Grouped headings (Characters has 2, Places has 1).
    expect(screen.getByText('Characters (2)')).toBeInTheDocument();
    expect(screen.getByText('Places (1)')).toBeInTheDocument();

    // Anchor to the start so this hits the open-card button, not its
    // "Rename …" / "Delete …" action icons.
    await userEvent.click(screen.getByRole('button', { name: /^Trail Hand/ }));
    expect(onOpen).toHaveBeenCalledWith('trail-hand');
  });

  it('filters the grid by the search box', async () => {
    renderCatalog();
    await userEvent.type(screen.getByLabelText('Filter sprites'), 'saloon');
    expect(screen.getByText('Places (1)')).toBeInTheDocument();
    expect(screen.queryByText(/Characters/)).not.toBeInTheDocument();
  });

  it('renames a record and reports the updated record up', async () => {
    const onRenamed = vi.fn();
    const updated = { id: 'bad-name-9x', name: 'Rattlesnake Kate', kind: 'character', status: 'draft' };
    updateSpriteRecord.mockResolvedValue(updated);
    renderCatalog({ onRenamed });

    await userEvent.click(screen.getByRole('button', { name: 'Rename sdxl_0007_final' }));
    const input = screen.getByRole('textbox');
    await userEvent.clear(input);
    await userEvent.type(input, 'Rattlesnake Kate');
    await userEvent.click(screen.getByRole('button', { name: /Save/ }));

    expect(updateSpriteRecord).toHaveBeenCalledWith('bad-name-9x', { name: 'Rattlesnake Kate' }, { silent: true });
    expect(onRenamed).toHaveBeenCalledWith(updated);
  });

  it('will not save an empty rename', async () => {
    renderCatalog();
    await userEvent.click(screen.getByRole('button', { name: 'Rename Saloon' }));
    const input = screen.getByRole('textbox');
    await userEvent.clear(input);
    await userEvent.click(screen.getByRole('button', { name: /Save/ }));

    expect(updateSpriteRecord).not.toHaveBeenCalled();
    expect(screen.getByText('Name can’t be empty')).toBeInTheDocument();
  });

  it('deletes only after the confirm step and reports the id up', async () => {
    const onDeleted = vi.fn();
    deleteSpriteRecord.mockResolvedValue({ deleted: true });
    renderCatalog({ onDeleted });

    // First click arms the confirm — it does NOT delete.
    await userEvent.click(screen.getByRole('button', { name: 'Delete Trail Hand' }));
    expect(deleteSpriteRecord).not.toHaveBeenCalled();
    expect(screen.getByText(/This can’t be undone/)).toBeInTheDocument();

    // Confirm.
    await userEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    expect(deleteSpriteRecord).toHaveBeenCalledWith('trail-hand', { silent: true });
    expect(onDeleted).toHaveBeenCalledWith('trail-hand');
  });

  it('cancels a delete without calling the API', async () => {
    const onDeleted = vi.fn();
    renderCatalog({ onDeleted });

    await userEvent.click(screen.getByRole('button', { name: 'Delete Saloon' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(deleteSpriteRecord).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    // Back to the card view.
    expect(screen.getByRole('button', { name: 'Delete Saloon' })).toBeInTheDocument();
  });
});
