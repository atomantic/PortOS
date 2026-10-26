// Manual add creates an owned canonical primitive before server-side attachment.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/apiCatalog', () => ({
  getCatalogIngredientCards: vi.fn(async ids => ids.map(id => ({ id, type: 'character', name: 'Catalog character', payload: {} }))),
  setCatalogIngredientLock: vi.fn(),
  listCatalogIngredients: vi.fn(),
  createCatalogIngredient: vi.fn(),
  linkCatalogIngredient: vi.fn(),
}));

vi.mock('../../services/apiUniverseBuilder', () => ({
  extractUniverseCanon: vi.fn(),
  refineUniverseCharacter: vi.fn(),
  differentiateUniverseCast: vi.fn(),
  updateUniverse: vi.fn(),
  getUniverseCanonUsage: vi.fn(),
  setUniverseCanonLock: vi.fn(),
  setUniverseCanonLockAll: vi.fn(),
  removeUniverseCanonEntry: vi.fn(),
  expandUniverseCharacter: vi.fn(),
}));

vi.mock('../../services/apiSystem', () => ({ generateImage: vi.fn() }));

vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import UniverseCanonSection from './UniverseCanonSection';
import { createCatalogIngredient, linkCatalogIngredient } from '../../services/apiCatalog';
import { updateUniverse, getUniverseCanonUsage } from '../../services/apiUniverseBuilder';
import toast from '../ui/Toast';

const baseUniverse = (over = {}) => ({
  id: 'uni-1',
  name: 'Test World',
  characters: [],
  places: [],
  objects: [],
  ...over,
});

const renderSection = (props = {}) => render(
  <MemoryRouter>
    <UniverseCanonSection
      universe={baseUniverse(props.universe)}
      universeId="uni-1"
      onUniverseChange={props.onUniverseChange || vi.fn()}
      imageCfg={{}}
      kindFilter={props.kindFilter || 'characters'}
      {...props}
    />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  getUniverseCanonUsage.mockResolvedValue({});
  createCatalogIngredient.mockImplementation(async (input) => ({ ...input, id: `cat-${input.type}-new` }));
  linkCatalogIngredient.mockImplementation(async () => {
    const input = createCatalogIngredient.mock.calls.at(-1)[0];
    const field = { character: 'characters', place: 'places', object: 'objects' }[input.type];
    return { success: true, universe: baseUniverse({ [field]: [{ ...input.payload, id: `${input.type}-server`, ingredientId: `cat-${input.type}-new`, name: input.name }] }) };
  });
});

describe('UniverseCanonSection — manual Add', () => {
  it('opens the form and persists a new character with locked:false + description in physicalDescription', async () => {
    const onUniverseChange = vi.fn();
    updateUniverse.mockResolvedValue(baseUniverse({
      characters: [{ id: 'chr-server', name: 'Rust Vega', physicalDescription: 'drifter', locked: false }],
    }));

    renderSection({ onUniverseChange });

    fireEvent.click(screen.getByRole('button', { name: /add character/i }));
    fireEvent.change(screen.getByLabelText(/new character name/i), { target: { value: '  Rust Vega  ' } });
    fireEvent.change(screen.getByLabelText(/new character description/i), { target: { value: 'drifter' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(onUniverseChange).toHaveBeenCalled());
    expect(createCatalogIngredient).toHaveBeenCalledWith(expect.objectContaining({
      type: 'character', name: 'Rust Vega', universeId: 'uni-1', payload: { locked: false, physicalDescription: 'drifter' }, operationKey: expect.any(String),
    }), { silent: true });
    expect(onUniverseChange.mock.calls.at(-1)[0].characters[0]).toMatchObject({ ingredientId: 'cat-character-new', locked: false });
    expect(updateUniverse).not.toHaveBeenCalled();
  });

  it('writes the description to `description` for places', async () => {
    const onUniverseChange = vi.fn();
    updateUniverse.mockResolvedValue(baseUniverse({
      places: [{ id: 'plc-server', name: 'The Hollow', description: 'a tunnel', locked: false }],
    }));

    renderSection({ onUniverseChange, kindFilter: 'places' });

    fireEvent.click(screen.getByRole('button', { name: /add place/i }));
    fireEvent.change(screen.getByLabelText(/new place name/i), { target: { value: 'The Hollow' } });
    fireEvent.change(screen.getByLabelText(/new place description/i), { target: { value: 'a tunnel' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(createCatalogIngredient).toHaveBeenCalled());
    expect(createCatalogIngredient.mock.calls[0][0]).toMatchObject({ type: 'place', universeId: 'uni-1', payload: { description: 'a tunnel' } });
  });

  it('omits the description field entirely when left blank', async () => {
    const onUniverseChange = vi.fn();
    updateUniverse.mockResolvedValue(baseUniverse({
      characters: [{ id: 'chr-server', name: 'Nameless', locked: false }],
    }));

    renderSection({ onUniverseChange });
    fireEvent.click(screen.getByRole('button', { name: /add character/i }));
    fireEvent.change(screen.getByLabelText(/new character name/i), { target: { value: 'Nameless' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(createCatalogIngredient).toHaveBeenCalled());
    expect(createCatalogIngredient.mock.calls[0][0].payload).toEqual({ locked: false });
  });

  it('refuses to add a duplicate name (case-insensitive) without calling the server', async () => {
    const onUniverseChange = vi.fn();
    renderSection({
      onUniverseChange,
      universe: { characters: [{ id: 'chr-1', name: 'Dup' }] },
    });

    fireEvent.click(screen.getByRole('button', { name: /add character/i }));
    fireEvent.change(screen.getByLabelText(/new character name/i), { target: { value: 'dup' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/already in this universe/i)));
    expect(updateUniverse).not.toHaveBeenCalled();
  });

  it('keeps the typed draft when the Add toggle collapses the form, and clears it on Cancel', async () => {
    // The toolbar "Add" button is a toggle, so collapsing mid-typing must not
    // throw the draft away — this is why the draft is owned by the section and
    // CanonAddEntryForm is a controlled leaf. Cancel, by contrast, discards.
    renderSection({ onUniverseChange: vi.fn() });
    // Settle the mount-time usage fetch before driving the form.
    await act(async () => {});

    const toggle = screen.getByRole('button', { name: /add character/i });
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText(/new character name/i), { target: { value: 'Half Typed' } });
    fireEvent.change(screen.getByLabelText(/new character description/i), { target: { value: 'wip' } });

    fireEvent.click(toggle); // collapse
    expect(screen.queryByLabelText(/new character name/i)).toBeNull();

    fireEvent.click(toggle); // reopen — draft survives
    expect(screen.getByLabelText(/new character name/i).value).toBe('Half Typed');
    expect(screen.getByLabelText(/new character description/i).value).toBe('wip');

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    fireEvent.click(toggle);
    expect(screen.getByLabelText(/new character name/i).value).toBe('');
    expect(screen.getByLabelText(/new character description/i).value).toBe('');
  });

  it('keeps the draft intact and reuses its operation key after a failed create', async () => {
    const onUniverseChange = vi.fn();
    createCatalogIngredient.mockRejectedValueOnce(new Error('boom'));
    renderSection({ onUniverseChange });
    fireEvent.click(screen.getByRole('button', { name: /add character/i }));
    fireEvent.change(screen.getByLabelText(/new character name/i), { target: { value: 'Rust Vega' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('boom')));
    expect(onUniverseChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/new character name/i).value).toBe('Rust Vega');
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(onUniverseChange).toHaveBeenCalled());
    expect(createCatalogIngredient.mock.calls[1][0].operationKey).toBe(createCatalogIngredient.mock.calls[0][0].operationKey);
  });
});
