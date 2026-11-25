import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

/**
 * Manage animation types (#3153).
 *
 * The server owns every refusal that matters (id/discriminator collisions, the
 * in-use delete, a record kind losing its baseline) and `animationTrackCrud.test.js`
 * proves those. What only this component can get wrong is:
 *
 *   - the built-in row being editable/deletable at all (`walk` must be neither)
 *   - sending a DERIVED field, which the server's `.strict()` schema would 400 —
 *     so the form must submit the authored subset and nothing else
 *   - swallowing the server's message: a 409 that names the conflicting field or the
 *     sprites holding approved work is the whole value of the refusal, and a generic
 *     "save failed" makes it unactionable
 *   - the bounds pre-check, which exists so the user sees the problem in the field
 *   - the sentinel distinction between "not loaded" and "loaded and empty"
 */

const listSpriteAnimationTracks = vi.fn();
const createSpriteAnimationTrack = vi.fn();
const updateSpriteAnimationTrack = vi.fn();
const deleteSpriteAnimationTrack = vi.fn();

vi.mock('../../services/apiSprites.js', () => ({
  listSpriteAnimationTracks: (...args) => listSpriteAnimationTracks(...args),
  createSpriteAnimationTrack: (...args) => createSpriteAnimationTrack(...args),
  updateSpriteAnimationTrack: (...args) => updateSpriteAnimationTrack(...args),
  deleteSpriteAnimationTrack: (...args) => deleteSpriteAnimationTrack(...args),
}));

vi.mock('../ui/Toast');

import AnimationTypesDrawer from './AnimationTypesDrawer.jsx';

const WALK = {
  id: 'walk', label: 'Walk cycle', builtin: true, directional: true, kinds: ['character'],
  minFrameCount: 6, maxFrameCount: 16, defaultFrameCount: 12, minFps: 4, maxFps: 24, defaultFps: 10,
  standaloneContract: true, contractFrameCountField: 'walkFrameCount',
  selectionKind: 'reviewed-directional-walk-selection', setKind: 'finalized-eight-direction-walk-set',
};
const CHEST = {
  id: 'chest-opening', label: 'Chest opening', builtin: false, directional: false, kinds: ['object'],
  minFrameCount: 2, maxFrameCount: 8, defaultFrameCount: 4, minFps: 2, maxFps: 12, defaultFps: 6,
  standaloneContract: true, contractFrameCountField: 'chestOpeningFrameCount',
  selectionKind: 'reviewed-chest-opening-selection', setKind: 'finalized-chest-opening-set',
  promptTemplate: 'Animate the {{kind}} {{name}} opening once.',
};

const renderDrawer = (initialEntry = '/sprites') => render(
  <MemoryRouter initialEntries={[initialEntry]}>
    <AnimationTypesDrawer open onClose={vi.fn()} />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  listSpriteAnimationTracks.mockResolvedValue({ tracks: [WALK, CHEST], storePath: 'sprites/animation-tracks.json', origin: 'store' });
  createSpriteAnimationTrack.mockResolvedValue({ tracks: [WALK], restartRequired: true });
  updateSpriteAnimationTrack.mockResolvedValue({ tracks: [WALK, CHEST], restartRequired: true });
  deleteSpriteAnimationTrack.mockResolvedValue({ tracks: [WALK], restartRequired: true });
});

/** Fill the create form with a valid type; returns the values submitted. */
async function fillNewType(overrides = {}) {
  fireEvent.click(screen.getByRole('button', { name: /add animation type/i }));
  const values = {
    id: 'jetpack', label: 'Jetpack burst', promptTemplate: 'Animate {{name}} firing a jetpack.', ...overrides,
  };
  fireEvent.change(await screen.findByLabelText(/^Id/), { target: { value: values.id } });
  fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: values.label } });
  fireEvent.change(screen.getByLabelText(/^Prompt template/), { target: { value: values.promptTemplate } });
  return values;
}

describe('AnimationTypesDrawer listing', () => {
  it('lists every registered type with its bounds', async () => {
    renderDrawer();
    expect(await screen.findByText('Walk cycle')).toBeInTheDocument();
    expect(screen.getByText('Chest opening')).toBeInTheDocument();
    expect(screen.getByText(/2–8 frames \(default 4\)/)).toBeInTheDocument();
  });

  it('marks the built-in as built-in and offers it no Edit or Delete', async () => {
    renderDrawer();
    await screen.findByText('Walk cycle');
    expect(screen.getByText('Built-in')).toBeInTheDocument();
    // Exactly one editable row (the stored one) — walk must not be mutable through a
    // data edit: its bounds feed the server's Zod schemas and its set gates every
    // character compile.
    expect(screen.getAllByRole('button', { name: /^Edit$/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^Delete$/ })).toHaveLength(1);
  });

  it('distinguishes "not loaded yet" from "loaded and empty"', async () => {
    let resolve;
    listSpriteAnimationTracks.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderDrawer();
    // Pending: a loading note, never an empty list that reads as "you have none".
    expect(screen.getByText(/Loading…/)).toBeInTheDocument();
    resolve({ tracks: [WALK], storePath: 'p', origin: 'seed' });
    expect(await screen.findByText('Walk cycle')).toBeInTheDocument();
  });

  it('surfaces a load failure with a retry instead of an empty list', async () => {
    listSpriteAnimationTracks.mockRejectedValueOnce(new Error('animation-tracks.json is not valid JSON'));
    renderDrawer();
    expect(await screen.findByText(/not valid JSON/)).toBeInTheDocument();
    listSpriteAnimationTracks.mockResolvedValueOnce({ tracks: [WALK], storePath: 'p', origin: 'store' });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Walk cycle')).toBeInTheDocument();
  });

  it('says the rows are shipped starters until this install has its own copy', async () => {
    listSpriteAnimationTracks.mockResolvedValue({ tracks: [WALK, CHEST], storePath: 'p', origin: 'seed' });
    renderDrawer();
    expect(await screen.findByText(/starter types PortOS ships with/)).toBeInTheDocument();
  });
});

describe('AnimationTypesDrawer create', () => {
  it('submits the authored subset only — no derived field the server would 400', async () => {
    renderDrawer();
    await screen.findByText('Chest opening');
    const values = await fillNewType();
    fireEvent.click(screen.getByRole('button', { name: /create type/i }));

    await waitFor(() => expect(createSpriteAnimationTrack).toHaveBeenCalled());
    const [body, options] = createSpriteAnimationTrack.mock.calls[0];
    expect(body).toEqual({
      id: values.id,
      label: values.label,
      directional: false,
      kinds: ['object'],
      minFrameCount: 2,
      maxFrameCount: 8,
      defaultFrameCount: 4,
      minFps: 2,
      maxFps: 12,
      defaultFps: 6,
      promptTemplate: values.promptTemplate,
    });
    // The five on-disk/contract discriminators are PortOS's to derive; sending one
    // would be refused by the server's `.strict()` schema.
    for (const derived of ['setKind', 'selectionKind', 'contractFrameCountField', 'standaloneContract', 'builtin']) {
      expect(body).not.toHaveProperty(derived);
    }
    // The caller owns its error UI, so the helper must not also toast.
    expect(options).toEqual({ silent: true });
  });

  it('renders the server\'s collision message verbatim rather than a generic failure', async () => {
    createSpriteAnimationTrack.mockRejectedValueOnce(new Error(
      "animationTracks: contract field 'jetpackFrameCount' is claimed by both 'jetpack.contractFrameCountField' and 'jetpack.contractFpsField'",
    ));
    renderDrawer();
    await screen.findByText('Chest opening');
    await fillNewType();
    fireEvent.click(screen.getByRole('button', { name: /create type/i }));
    expect(await screen.findByText(/jetpackFrameCount/)).toBeInTheDocument();
  });

  it('blocks an out-of-order bounds triple in the field, before any request', async () => {
    renderDrawer();
    await screen.findByText('Chest opening');
    await fillNewType();
    fireEvent.change(screen.getByLabelText(/^Min frames/), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: /create type/i }));
    expect(await screen.findByText(/minimum ≤ default ≤ maximum/i)).toBeInTheDocument();
    expect(createSpriteAnimationTrack).not.toHaveBeenCalled();
  });

  it('blocks a CLEARED bound rather than letting Number("") pass as 0', async () => {
    // The number inputs hold `''` when emptied, and `Number('') === 0` would satisfy
    // the ordering check — so without an explicit empty check the user gets a raw
    // "expected number" from Zod instead of a message naming the knob.
    renderDrawer();
    await screen.findByText('Chest opening');
    await fillNewType();
    fireEvent.change(screen.getByLabelText(/^Min frames/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /create type/i }));
    expect(await screen.findByText(/fill in the minimum, default and maximum/i)).toBeInTheDocument();
    expect(createSpriteAnimationTrack).not.toHaveBeenCalled();
  });

  it('blocks a duplicate id, a blank label, and a blank prompt locally', async () => {
    renderDrawer();
    await screen.findByText('Chest opening');
    // A duplicate id is caught here so the user isn't told "already exists" only
    // after a round-trip.
    await fillNewType({ id: 'chest-opening' });
    fireEvent.click(screen.getByRole('button', { name: /create type/i }));
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    expect(createSpriteAnimationTrack).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/^Id/), { target: { value: 'jetpack' } });
    fireEvent.change(screen.getByLabelText(/^Prompt template/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /create type/i }));
    expect(await screen.findByText(/prompt template is required/i)).toBeInTheDocument();
    expect(createSpriteAnimationTrack).not.toHaveBeenCalled();
  });

  it('requires at least one sprite kind', async () => {
    renderDrawer();
    await screen.findByText('Chest opening');
    await fillNewType();
    // Deselect the default kind (labels come from the shared NEW_SPRITE_KINDS).
    fireEvent.click(screen.getByRole('button', { name: 'Object' }));
    fireEvent.click(screen.getByRole('button', { name: /create type/i }));
    expect(await screen.findByText(/at least one sprite kind/i)).toBeInTheDocument();
    expect(createSpriteAnimationTrack).not.toHaveBeenCalled();
  });

  it('warns that a restart is needed to publish with a new type', async () => {
    createSpriteAnimationTrack.mockResolvedValueOnce({ tracks: [WALK, CHEST], restartRequired: true });
    renderDrawer();
    await screen.findByText('Chest opening');
    await fillNewType();
    fireEvent.click(screen.getByRole('button', { name: /create type/i }));
    // The registry itself is live after the write; only the publish-contract field is
    // registered at start-up, and saying so is the difference between a documented
    // boundary and a field that silently does nothing.
    expect(await screen.findByText(/Restart the PortOS server to publish/)).toBeInTheDocument();
  });
});

describe('AnimationTypesDrawer edit', () => {
  it('deep-links to a type via ?editTrack and opens its form', async () => {
    renderDrawer('/sprites?editTrack=chest-opening');
    expect(await screen.findByDisplayValue('Chest opening')).toBeInTheDocument();
    expect(screen.getByText(/id is fixed/i)).toBeInTheDocument();
  });

  it('says so on a STALE ?editTrack instead of silently offering the create form', async () => {
    // A shared link to a since-deleted type must not read as "your link worked" while
    // presenting a different action.
    renderDrawer('/sprites?editTrack=long-gone');
    expect(await screen.findByText(/No animation type called/)).toBeInTheDocument();
    expect(screen.getByText('long-gone')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create type/i })).not.toBeInTheDocument();
  });

  it('loads the row, hides the id as immutable, and shows the derived fields', async () => {
    renderDrawer();
    await screen.findByText('Chest opening');
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    // No id input — renaming would have to migrate the on-disk directories, so it is
    // a delete-plus-create.
    expect(screen.queryByLabelText(/^Id/)).not.toBeInTheDocument();
    expect(screen.getByText(/id is fixed/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Chest opening')).toBeInTheDocument();
    // The derivation is shown so a collision refusal naming one of these is legible.
    expect(screen.getByText('finalized-chest-opening-set')).toBeInTheDocument();
  });

  it('PUTs the authored subset for the edited id', async () => {
    renderDrawer();
    await screen.findByText('Chest opening');
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    fireEvent.change(await screen.findByLabelText(/^Label/), { target: { value: 'Chest opens' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateSpriteAnimationTrack).toHaveBeenCalled());
    const [trackId, patch, options] = updateSpriteAnimationTrack.mock.calls[0];
    expect(trackId).toBe('chest-opening');
    expect(patch.label).toBe('Chest opens');
    // The update schema is `.strict()` and declares no `id` — the path param owns it
    // and a rename is a delete-plus-create — so an `id` in the patch is a 400 that
    // would make every save fail. Neither it nor any derived field may ride along.
    for (const forbidden of ['id', 'setKind', 'selectionKind', 'contractFrameCountField', 'standaloneContract', 'builtin']) {
      expect(patch).not.toHaveProperty(forbidden);
    }
    expect(options).toEqual({ silent: true });
  });
});

describe('AnimationTypesDrawer delete', () => {
  // The confirm copy interleaves a <span> around the label, so match on the
  // surrounding sentence rather than a string spanning both nodes.
  const confirmPrompt = () => screen.findByText(/keep those files, and the delete is refused/);

  it('confirms inline (never window.confirm) and deletes on the second click', async () => {
    renderDrawer();
    await screen.findByText('Chest opening');
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    expect(await confirmPrompt()).toBeInTheDocument();
    // A discoverable Cancel/Delete pair, not a two-click arm.
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(deleteSpriteAnimationTrack).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await confirmPrompt();
    // Two Delete buttons exist once armed (the row trigger is replaced by the
    // confirm row's pair) — the confirm row's is the last in the DOM.
    const deletes = screen.getAllByRole('button', { name: /^Delete$/ });
    fireEvent.click(deletes[deletes.length - 1]);
    await waitFor(() => expect(deleteSpriteAnimationTrack).toHaveBeenCalledWith('chest-opening', { silent: true }));
  });

  it('shows the in-use refusal, naming the sprites that hold approved work', async () => {
    deleteSpriteAnimationTrack.mockRejectedValueOnce(new Error(
      "Cannot delete 'chest-opening' — 2 sprites already carry approved chest-opening work: pioneer, crates. Reopen or unlock those sets first.",
    ));
    renderDrawer();
    await screen.findByText('Chest opening');
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await confirmPrompt();
    const deletes = screen.getAllByRole('button', { name: /^Delete$/ });
    fireEvent.click(deletes[deletes.length - 1]);
    expect(await screen.findByText(/pioneer, crates/)).toBeInTheDocument();
    // The row survives — a refused delete must not optimistically vanish. (The
    // label appears twice while the confirm row is still open: once as the row
    // heading, once in the confirm copy.)
    expect(screen.getAllByText('Chest opening').length).toBeGreaterThan(0);
    expect(screen.getByText(/2–8 frames \(default 4\)/)).toBeInTheDocument();
  });
});
