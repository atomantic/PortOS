/**
 * Pick an existing sprite's locked main reference to seed a new one (#sprite-i2i).
 *
 * The picker is the only thing standing between the user and an i2i seed, so
 * the behaviours worth pinning are the ones a re-render can quietly break:
 *   - `excludeId` dropping the sprite being edited (seeding a main from its own
 *     not-yet-locked reference is nonsensical)
 *   - case-insensitive search across BOTH name and id — an id-only match is the
 *     reason the filter concatenates the two
 *   - `onSelect(item)` handing back the whole row (the caller needs `path`, not
 *     just the id) and then closing
 *   - the empty-state sentinel: "nothing locked yet" and "nothing matches your
 *     search" are different problems with different fixes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const listSpriteReferenceSources = vi.fn();

vi.mock('../../services/apiSprites.js', () => ({
  listSpriteReferenceSources: (...args) => listSpriteReferenceSources(...args),
  // Pulled in transitively by SpritePreview → SpriteLightbox → AssetPromptSection.
  getSpriteAssetPrompt: vi.fn(() => Promise.resolve(null)),
}));

import SpriteReferencePicker from './SpriteReferencePicker.jsx';

const SOURCES = [
  { id: 'example-pioneer', name: 'Example Pioneer', path: 'reference/example-pioneer-main-v1.png' },
  { id: 'example-medic', name: 'Field Medic', path: 'reference/example-medic-main-v1.png' },
  { id: 'example-rover', name: 'Dust Rover', path: 'reference/example-rover-main-v1.png' },
];

const renderPicker = (props = {}) => render(
  <SpriteReferencePicker open onClose={vi.fn()} onSelect={vi.fn()} {...props} />,
);

const searchBox = () => screen.getByLabelText('Search reference sprites');

beforeEach(() => {
  vi.clearAllMocks();
  listSpriteReferenceSources.mockResolvedValue(SOURCES);
});

describe('SpriteReferencePicker', () => {
  it('fetches silently and drops the excluded sprite from the grid', async () => {
    renderPicker({ excludeId: 'example-pioneer' });

    expect(await screen.findByText('Field Medic')).toBeInTheDocument();
    expect(listSpriteReferenceSources).toHaveBeenCalledWith({ silent: true });
    expect(screen.getByText('Dust Rover')).toBeInTheDocument();
    expect(screen.queryByText('Example Pioneer')).not.toBeInTheDocument();
  });

  it('filters case-insensitively on the name', async () => {
    renderPicker();
    await screen.findByText('Field Medic');

    await userEvent.type(searchBox(), 'DUST');
    expect(screen.getByText('Dust Rover')).toBeInTheDocument();
    expect(screen.queryByText('Field Medic')).not.toBeInTheDocument();
  });

  it('filters on the id too, so an id-only match still resolves', async () => {
    renderPicker();
    await screen.findByText('Field Medic');

    // "example-rover" is nowhere in the display name "Dust Rover" — matching on
    // the id is what keeps a renamed sprite findable by what it's stored as.
    await userEvent.type(searchBox(), 'EXAMPLE-ROVER');
    expect(screen.getByText('Dust Rover')).toBeInTheDocument();
    expect(screen.queryByText('Field Medic')).not.toBeInTheDocument();
    expect(screen.queryByText('Example Pioneer')).not.toBeInTheDocument();
  });

  it('clears the search back to the full list', async () => {
    renderPicker();
    await screen.findByText('Field Medic');

    await userEvent.type(searchBox(), 'dust');
    expect(screen.queryByText('Field Medic')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(searchBox()).toHaveValue('');
    expect(screen.getByText('Field Medic')).toBeInTheDocument();
  });

  it('hands the whole row to onSelect and then closes', async () => {
    const order = [];
    const onSelect = vi.fn(() => order.push('select'));
    const onClose = vi.fn(() => order.push('close'));
    renderPicker({ onSelect, onClose });
    await screen.findByText('Field Medic');

    await userEvent.click(screen.getByText('Field Medic'));
    expect(onSelect).toHaveBeenCalledWith(SOURCES[1]);
    expect(order).toEqual(['select', 'close']);
  });

  it('distinguishes an empty catalog from an empty search result', async () => {
    const { unmount } = renderPicker();
    await screen.findByText('Field Medic');
    await userEvent.type(searchBox(), 'nothing matches this');
    expect(screen.getByText('No reference sprites match your search.')).toBeInTheDocument();
    unmount();

    listSpriteReferenceSources.mockResolvedValue([]);
    renderPicker();
    expect(await screen.findByText(/No sprites with a locked main reference yet/)).toBeInTheDocument();
  });

  it('falls back to an empty list when the fetch fails', async () => {
    listSpriteReferenceSources.mockRejectedValue(new Error('offline'));
    renderPicker();
    expect(await screen.findByText(/No sprites with a locked main reference yet/)).toBeInTheDocument();
  });

  it('refetches on each open and resets the search on close', async () => {
    const { rerender } = renderPicker();
    await screen.findByText('Field Medic');
    await userEvent.type(searchBox(), 'dust');

    rerender(<SpriteReferencePicker open={false} onClose={vi.fn()} onSelect={vi.fn()} />);
    rerender(<SpriteReferencePicker open onClose={vi.fn()} onSelect={vi.fn()} />);

    expect(await screen.findByText('Field Medic')).toBeInTheDocument();
    expect(searchBox()).toHaveValue('');
    expect(listSpriteReferenceSources).toHaveBeenCalledTimes(2);
  });
});
