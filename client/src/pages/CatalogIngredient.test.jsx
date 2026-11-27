// Render the character-sheet editor, including enriched canon fields,
// reference sheets and the links into the rendering workflow.
import { CHAR_FIXTURE, detailsOf, emitSocket, renderPage, installCatalogIngredientHooks } from './CatalogIngredient.test.fixture.jsx';
import { describe, it, expect, vi } from 'vitest';
import { act, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { buildGenerationPromptSeed } from '../lib/catalogImagePrompt';
import {
  getCatalogIngredientDetails,
  getCatalogUniverseContext,
  listCatalogIngredientRevisions,
  unlinkCatalogIngredientRelation,
  updateCatalogIngredient,
  detachCatalogIngredientMedia,
  restoreCatalogIngredientRevision,
  uploadCatalogIngredientMediaFile,
} from '../services/apiCatalog';
import toast from '../components/ui/Toast';
import { getCatalogIdentity, acceptCatalogIdentity, abortCatalogIdentity } from '../services/apiCatalogIdentity';

installCatalogIngredientHooks();

describe('CatalogIngredient — character sheet', () => {
  it.each(['character', 'place', 'object'])('puts the %s creative redesign action beside Save without a separate body trigger', async (type) => {
    getCatalogIngredientDetails.mockImplementation(async () => detailsOf({ ...CHAR_FIXTURE, type }));
    await renderPage(`/catalog/${type}/cat-chr-1`);
    const header = screen.getByRole('button', { name: 'Save', exact: true }).closest('header');
    expect(within(header).getByRole('button', { name: 'Redesign with a creative assistant' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('button', { name: 'Redesign with a creative assistant' })).toHaveLength(1);
    expect(document.getElementById('catalog-redesign')).not.toBeVisible();
  });

  it('aborts an uncommitted agreement without saving or discarding the existing creative draft', async () => {
    const receipt = { id: 'example-abort-operation', sourceId: 'example-source', survivorId: CHAR_FIXTURE.id, localOwner: 'canonical-owner', sourceOwner: 'source-owner', survivorOwner: 'canonical-owner', state: 'proposed', planHash: 'example-hash',
      plan: { sourceId: 'example-source', survivorId: CHAR_FIXTURE.id, sourceOwner: 'source-owner', survivorOwner: 'canonical-owner', source: { ingredients: [{ id: 'example-source', type: 'character', name: 'Original subject' }] }, survivor: { ingredients: [CHAR_FIXTURE] }, proposed: { name: CHAR_FIXTURE.name } } };
    getCatalogIdentity.mockResolvedValue(receipt);
    abortCatalogIdentity.mockResolvedValue({ ...receipt, state: 'aborted' });
    await renderPage('/catalog/character/cat-chr-1?identityOperation=example-abort-operation');
    fireEvent.change(screen.getByLabelText('Name', { exact: true }), { target: { value: 'Unsaved creative name' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Abort uncommitted proposal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm coordinator abort' }));
    await screen.findByText('Aborted · no canonical consolidation applied');
    expect(screen.getByLabelText('Name', { exact: true })).toHaveValue('Unsaved creative name');
    expect(updateCatalogIngredient).not.toHaveBeenCalled();
  });

  it('disables profile inputs for the duration of an owner acceptance so its refresh cannot discard newly typed edits', async () => {
    const receipt = { id: 'example-pending-operation', sourceId: 'example-source', survivorId: CHAR_FIXTURE.id, localOwner: 'canonical-owner', sourceOwner: 'source-owner', survivorOwner: 'canonical-owner', state: 'proposed', planHash: 'example-hash',
      plan: { sourceId: 'example-source', survivorId: CHAR_FIXTURE.id, sourceOwner: 'source-owner', survivorOwner: 'canonical-owner', source: { ingredients: [{ id: 'example-source', type: 'character', name: 'Original subject' }] }, survivor: { ingredients: [CHAR_FIXTURE] }, proposed: { name: CHAR_FIXTURE.name } } };
    getCatalogIdentity.mockResolvedValue(receipt);
    let finishAcceptance;
    acceptCatalogIdentity.mockImplementationOnce(() => new Promise(resolve => { finishAcceptance = resolve; }));
    await renderPage('/catalog/character/cat-chr-1?identityOperation=example-pending-operation');
    fireEvent.click(await screen.findByRole('checkbox', { name: /I accept this exact reviewed plan/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Accept as this owner' }));
    await waitFor(() => expect(acceptCatalogIdentity).toHaveBeenCalled());
    expect(screen.getByLabelText('Name', { exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    getCatalogIngredientDetails.mockResolvedValue({ ...detailsOf(CHAR_FIXTURE), sharedIdentity: { ...receipt, operationId: receipt.id, writable: false, reason: 'CATALOG_IDENTITY_FENCED', state: 'prepared' } });
    await act(async () => { finishAcceptance({ ...receipt, state: 'prepared' }); });
    await screen.findByText(/This identity is reserved while the owners complete/);
    expect(screen.getByLabelText('Name', { exact: true })).toBeDisabled();
    expect(screen.getByLabelText('Name', { exact: true })).toHaveValue(CHAR_FIXTURE.name);
  });

  it('retains source-ID ownership restrictions after canonical resolution while keeping evidence and images inspectable', async () => {
    getCatalogIngredientDetails.mockImplementation(async () => ({
      ...detailsOf(CHAR_FIXTURE),
      sharedIdentity: { operationId: 'shared-example', sourceId: 'retained-original', survivorId: CHAR_FIXTURE.id,
        localOwner: 'source-owner', survivorOwner: 'canonical-owner', sourceOwner: 'source-owner', writable: false, reason: 'CATALOG_IDENTITY_RETAINED', state: 'committed' },
      media: [{ ingredientId: 'retained-original', kind: 'reference', mediaKey: 'retained.png' }],
      revisions: [{ id: 'latest', source: 'save', name: 'Current' }, { id: 'old', source: 'save', name: 'Old original' }],
    }));
    await renderPage('/catalog/character/retained-original');
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete ingredient' })).toBeDisabled();
    expect(screen.getByLabelText('Name', { exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add relation' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Detach', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pick from gallery|Upload file|Record memo/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Open canonical owner' })).toHaveAttribute('href', 'https://canonical.example:5555/casting/cat-chr-1');
    fireEvent.click(screen.getByRole('button', { name: /Old original/ }));
    expect(screen.getByRole('button', { name: /Old original/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Read-only provenance/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(updateCatalogIngredient).not.toHaveBeenCalled();
  });

  it('keeps canonical editing available but retains source-only media and relations as immutable provenance', async () => {
    getCatalogIngredientDetails.mockImplementation(async () => ({
      ...detailsOf(CHAR_FIXTURE),
      sharedIdentity: { operationId: 'shared-example', sourceId: 'retained-original', survivorId: CHAR_FIXTURE.id,
        localOwner: 'canonical-owner', survivorOwner: 'canonical-owner', sourceOwner: 'source-owner', writable: true, state: 'committed' },
      media: [{ ingredientId: 'retained-original', kind: 'reference', mediaKey: 'retained.png' }, { ingredientId: CHAR_FIXTURE.id, kind: 'reference', mediaKey: 'canonical.png' }],
      relations: { outbound: [{ fromId: 'retained-original', toId: 'place-one', kind: 'lives_in', other: { id: 'place-one', name: 'Retained place', type: 'place' } }], inbound: [] },
    }));
    await renderPage();
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    expect(screen.getAllByRole('button', { name: 'Detach', exact: true })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Remove relation to Retained place' })).not.toBeInTheDocument();
    expect(screen.getByText('Retained source relation · read-only')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Retained place/ })).toBeInTheDocument();
  });

  it('reports a rejected file read and re-enables the upload control', async () => {
    await renderPage();
    const fileInput = document.querySelector('input[type="file"][accept="image/*,audio/*,video/*"]');
    const unreadable = { name: 'example.png', type: 'image/png', arrayBuffer: vi.fn().mockRejectedValue(new Error('File unavailable')) };

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [unreadable] } });
      await Promise.resolve();
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('File unavailable'));
    await waitFor(() => expect(fileInput).toBeEnabled());
    expect(uploadCatalogIngredientMediaFile).not.toHaveBeenCalled();
  });

  it('keeps the new ingredient draft when an earlier restore completes', async () => {
    let finishRestore;
    restoreCatalogIngredientRevision.mockImplementationOnce(() => new Promise(resolve => { finishRestore = resolve; }));
    getCatalogIngredientDetails.mockImplementation(async id => ({
      ...detailsOf({ ...CHAR_FIXTURE, id, name: id === 'cat-chr-1' ? 'First ingredient' : 'Second ingredient' }),
      revisions: [{ id: 'latest', name: 'Current' }, { id: 'old', name: 'Earlier' }],
    }));
    const { router } = await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    await waitFor(() => expect(restoreCatalogIngredientRevision).toHaveBeenCalledTimes(1));
    await act(async () => router.navigate('/catalog/character/cat-chr-2'));
    await screen.findByDisplayValue('Second ingredient');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Second draft' } });
    await act(async () => finishRestore({ ...CHAR_FIXTURE, name: 'Restored first ingredient' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Second draft');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('keeps revision restore confirmation open when restore fails', async () => {
    getCatalogIngredientDetails.mockImplementation(async () => ({
      ...detailsOf(CHAR_FIXTURE),
      revisions: [
        { id: 'rev-latest', source: 'save', name: 'Current', createdAt: '2026-10-17T00:00:00Z' },
        { id: 'rev-old', source: 'save', name: 'Earlier', createdAt: '2026-10-16T00:00:00Z' },
      ],
    }));
    restoreCatalogIngredientRevision.mockRejectedValue(new Error('Restore failed'));
    await renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    const confirmation = screen.getByRole('group', { name: 'Confirm restore of Earlier' });
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Restore failed'));
    expect(confirmation).toBeInTheDocument();
    expect(confirmation.querySelector('button')).toHaveTextContent('Restore');
  });

  // The h1 is the ONLY place the ingredient's name appears on this route, and
  // clipped text is neither selectable nor expandable — the tooltip is the sole
  // access path to the rest of a long name on a phone (#5694).
  it('exposes the full record name through the heading title attribute', async () => {
    const longName = 'Augusta Ada King, Countess of Lovelace, Analytical Engine Programmer and Mathematician';
    getCatalogIngredientDetails.mockImplementation(async () => detailsOf({ ...CHAR_FIXTURE, name: longName }));
    await renderPage();

    const heading = await screen.findByRole('heading', { name: longName });
    expect(heading.getAttribute('title')).toBe(longName);
  });

  it('requires confirmation before detaching media', async () => {
    detachCatalogIngredientMedia.mockResolvedValue({});
    getCatalogIngredientDetails.mockImplementation(async () => ({
      ...detailsOf(CHAR_FIXTURE),
      media: [{ mediaKey: 'portrait.png', kind: 'portrait' }],
    }));
    await renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Detach' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Detach' }));
    expect(detachCatalogIngredientMedia).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Detach', exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Detach', exact: true }));
    await waitFor(() => expect(detachCatalogIngredientMedia).toHaveBeenCalledWith(
      'cat-chr-1', { mediaKey: 'portrait.png', kind: 'portrait' }, { silent: true },
    ));
  });

  it('requires confirmation before removing an outbound relation', async () => {
    unlinkCatalogIngredientRelation.mockResolvedValue({});
    getCatalogIngredientDetails.mockImplementation(async () => ({
      ...detailsOf(CHAR_FIXTURE),
      relations: {
        outbound: [{
          fromId: CHAR_FIXTURE.id,
          toId: 'cat-place-1',
          kind: 'lives-at',
          other: { id: 'cat-place-1', name: 'Example Place', type: 'place' },
        }],
        inbound: [],
      },
    }));
    await renderPage();

    const removeButton = await screen.findByRole('button', { name: 'Remove relation to Example Place' });
    fireEvent.click(removeButton);
    expect(unlinkCatalogIngredientRelation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(unlinkCatalogIngredientRelation).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove relation to Example Place' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove relation to Example Place' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(unlinkCatalogIngredientRelation).toHaveBeenCalledWith(
      CHAR_FIXTURE.id,
      { toId: 'cat-place-1', kind: 'lives-at' },
      { silent: true },
    ));
    await waitFor(() => expect(screen.queryByText('Example Place')).toBeNull());
  });

  it('keeps a character’s family in the Family picker, out of the generic Relations list', async () => {
    unlinkCatalogIngredientRelation.mockResolvedValue({});
    getCatalogIngredientDetails.mockImplementation(async () => ({
      ...detailsOf(CHAR_FIXTURE),
      relations: {
        outbound: [{ fromId: CHAR_FIXTURE.id, toId: 'cat-chr-frank', kind: 'wife-of', other: { id: 'cat-chr-frank', name: 'Example Frank', type: 'character' } }],
        inbound: [{ fromId: 'cat-chr-kid', toId: CHAR_FIXTURE.id, kind: 'daughter-of', other: { id: 'cat-chr-kid', name: 'Example Kid', type: 'character' } }],
      },
    }));
    await renderPage();

    const remove = await screen.findByRole('button', { name: 'Remove Wife of Example Frank' });
    expect(screen.getByRole('link', { name: 'Example Kid' })).toHaveAttribute('href', '/casting/cat-chr-kid');
    expect(screen.queryByRole('button', { name: 'Remove relation to Example Frank' })).toBeNull();
    fireEvent.click(remove);
    await waitFor(() => expect(unlinkCatalogIngredientRelation).toHaveBeenCalledWith(
      CHAR_FIXTURE.id, { toId: 'cat-chr-frank', kind: 'wife-of' }, { silent: true }));
  });

  describe('unsaved changes', () => {
    it('tracks name, tags, and payload edits in the unsaved indicator', async () => {
      await renderPage();
      const nameInput = await screen.findByLabelText('Name');
      const descriptionInput = screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.');
      const tagButton = screen.getByRole('button', { name: 'Change tag' });

      expect(screen.queryByText('Unsaved changes')).toBeNull();

      fireEvent.change(nameInput, { target: { value: 'Edited ingredient' } });
      expect(screen.getByText('Unsaved changes')).toBeTruthy();
      fireEvent.change(nameInput, { target: { value: CHAR_FIXTURE.name } });
      await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());

      fireEvent.click(tagButton);
      expect(screen.getByText('Unsaved changes')).toBeTruthy();
      fireEvent.click(tagButton);
      await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());

      fireEvent.change(descriptionInput, { target: { value: 'Edited description' } });
      expect(screen.getByText('Unsaved changes')).toBeTruthy();
    });

    it('confirms before the Back link discards dirty edits', async () => {
      const { router } = await renderPage();
      const nameInput = await screen.findByLabelText('Name');
      fireEvent.change(nameInput, { target: { value: 'Edited ingredient' } });

      fireEvent.click(screen.getByRole('link', { name: /Back/ }));
      expect(await screen.findByText('Discard your unsaved changes to this ingredient?')).toBeTruthy();
      expect(screen.queryByText('Catalog index')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
      await waitFor(() => expect(screen.queryByText('Discard your unsaved changes to this ingredient?')).toBeNull());
      expect(router.state.location.pathname).toBe('/catalog/character/cat-chr-1');

      fireEvent.click(screen.getByRole('link', { name: /Back/ }));
      expect(await screen.findByText('Discard your unsaved changes to this ingredient?')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(await screen.findByText('Catalog index')).toBeTruthy();
    });

    it('clears the unsaved indicator after a successful save', async () => {
      updateCatalogIngredient.mockResolvedValue({ ...CHAR_FIXTURE, name: 'Saved ingredient' });
      await renderPage();
      const nameInput = await screen.findByLabelText('Name');
      fireEvent.change(nameInput, { target: { value: 'Saved ingredient' } });
      expect(screen.getByText('Unsaved changes')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalled());
      await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
    });

    // Catches an added age/look never reaching the saved payload.
    it('saves an added age or look as payload.forms', async () => {
      updateCatalogIngredient.mockImplementation(async (_id, body) => ({ ...CHAR_FIXTURE, ...body }));
      await renderPage();
      fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
      fireEvent.click(await screen.findByRole('button', { name: /Add age or look/ }));
      fireEvent.change(screen.getAllByLabelText('Name')[1], { target: { value: 'Age 7' } });
      fireEvent.change(screen.getByLabelText('Hair, clothing & appearance'), { target: { value: 'yellow raincoat' } });
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalled());
      expect(updateCatalogIngredient.mock.calls[0][1].payload.forms).toEqual([
        expect.objectContaining({ id: expect.stringMatching(/^form-/), label: 'Age 7', description: 'yellow raincoat' }),
      ]);
    });

    it('keeps edits typed during a save and submits them on the next save', async () => {
      let finishSave;
      updateCatalogIngredient.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
      await renderPage();
      const nameInput = await screen.findByLabelText('Name');
      const descriptionInput = screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.');
      const tagButton = screen.getByRole('button', { name: 'Change tag' });

      fireEvent.change(nameInput, { target: { value: 'First draft' } });
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledTimes(1));
      fireEvent.change(nameInput, { target: { value: 'Newer draft' } });
      fireEvent.change(descriptionInput, { target: { value: 'Newer description' } });
      fireEvent.click(tagButton);

      await act(async () => finishSave({ ...CHAR_FIXTURE, name: 'First draft' }));
      expect(nameInput.value).toBe('Newer draft');
      expect(descriptionInput.value).toBe('Newer description');
      expect(screen.getByText('Unsaved changes')).toBeTruthy();

      updateCatalogIngredient.mockResolvedValueOnce({
        ...CHAR_FIXTURE, name: 'Newer draft', tags: [...CHAR_FIXTURE.tags, 'example-tag'],
        payload: { ...CHAR_FIXTURE.payload, physicalDescription: 'Newer description' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledTimes(2));
      expect(updateCatalogIngredient.mock.calls[1][1]).toMatchObject({
        name: 'Newer draft', tags: [...CHAR_FIXTURE.tags, 'example-tag'],
        payload: { physicalDescription: 'Newer description' },
      });
      await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
    });

    it('applies server normalization only to fields unchanged since submission', async () => {
      let finishSave;
      updateCatalogIngredient.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
      await renderPage();
      const nameInput = await screen.findByLabelText('Name');
      const descriptionInput = screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.');
      fireEvent.change(nameInput, { target: { value: '  Normalized name  ' } });
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledTimes(1));
      fireEvent.change(descriptionInput, { target: { value: 'Unsaved description' } });

      await act(async () => finishSave({
        ...CHAR_FIXTURE, name: 'Normalized name', tags: ['Mentor'],
      }));
      expect(nameInput.value).toBe('Normalized name');
      expect(descriptionInput.value).toBe('Unsaved description');
      expect(screen.getByText('Unsaved changes')).toBeTruthy();
      updateCatalogIngredient.mockResolvedValueOnce({
        ...CHAR_FIXTURE, name: 'Normalized name', tags: ['Mentor'],
        payload: { ...CHAR_FIXTURE.payload, physicalDescription: 'Unsaved description' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledTimes(2));
      expect(updateCatalogIngredient.mock.calls[1][1].tags).toEqual(['Mentor']);
    });

    it('keeps the draft dirty after a failed save', async () => {
      let failSave;
      updateCatalogIngredient.mockImplementationOnce(() => new Promise((_resolve, reject) => { failSave = reject; }));
      await renderPage();
      const nameInput = await screen.findByLabelText('Name');
      fireEvent.change(nameInput, { target: { value: 'Unsaved draft' } });
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledTimes(1));
      await act(async () => failSave(new Error('Save failed')));
      expect(nameInput.value).toBe('Unsaved draft');
      expect(screen.getByText('Unsaved changes')).toBeTruthy();
    });

    it('ignores a save response after switching records and returning', async () => {
      let finishSave;
      updateCatalogIngredient.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
      getCatalogIngredientDetails.mockImplementation(async (id) => detailsOf({
        ...CHAR_FIXTURE, id, name: id === 'cat-chr-1' ? 'First ingredient' : 'Second ingredient',
      }));
      const { router } = await renderPage();
      await screen.findByDisplayValue('First ingredient');
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledTimes(1));
      await act(async () => router.navigate('/catalog/character/cat-chr-2'));
      await screen.findByDisplayValue('Second ingredient');
      await act(async () => router.navigate('/catalog/character/cat-chr-1'));
      await screen.findByDisplayValue('First ingredient');

      await act(async () => finishSave({ ...CHAR_FIXTURE, name: 'Stale response' }));
      expect(screen.getByLabelText('Name').value).toBe('First ingredient');
      expect(screen.queryByText('Stale response')).toBeNull();
    });
  });

  it('opens one compact sheet with identity beside Attributes and lazy Story/Appearance/Voice pages', async () => {
    const { getUniverse } = await import('../services/apiUniverseBuilder');
    getUniverse.mockClear();
    await renderPage('/casting/cat-chr-1');
    expect(screen.getByLabelText('Pronouns')).toHaveValue('she/her');
    expect(screen.getByDisplayValue('Decode the machine.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Being underestimated.')).toBeInTheDocument();
    expect(screen.getByLabelText('Physical Description')).toHaveValue('Sharp eyes, ink-stained cuffs.');
    expect(screen.queryByRole('button', { name: 'Edit full character sheet' })).not.toBeInTheDocument();
    expect(getUniverse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    expect(screen.getByLabelText('Physical Description')).toHaveValue('Sharp eyes, ink-stained cuffs.');
    expect(screen.getByLabelText('Pronouns')).toHaveValue('she/her');
  });

  it('shows the music-video limit and prevents saving an overlong linked description', async () => {
    const linked = { ...CHAR_FIXTURE, refs: [...CHAR_FIXTURE.refs, { refKind: 'music-video', refId: 'mv-example', role: 'cast' }] };
    getCatalogIngredientDetails.mockResolvedValue(detailsOf(linked));
    await renderPage('/casting/cat-chr-1');
    const description = screen.getByLabelText('Physical Description');
    fireEvent.change(description, { target: { value: 'x'.repeat(1001) } });
    expect(screen.getByText('1,001 / 1,000 characters for linked music videos')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    fireEvent.change(description, { target: { value: 'A concise appearance.' } });
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  });

  it('edits the full shared character sheet and preserves unedited legacy fields', async () => {
    const character = { ...CHAR_FIXTURE, payload: { ...CHAR_FIXTURE.payload, futureCanon: { retained: true } } };
    getCatalogIngredientDetails.mockResolvedValue(detailsOf(character));
    updateCatalogIngredient.mockImplementation(async (_id, patch) => ({ ...character, ...patch }));
    await renderPage('/casting/cat-chr-1');
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: 'Story' })));
    const ghost = screen.getByLabelText(/^Ghost/);
    fireEvent.change(ghost, { target: { value: 'Lost the first dispatch.' } });
    fireEvent.blur(ghost);
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledWith(character.id,
      expect.objectContaining({ payload: expect.objectContaining({ ghost: 'Lost the first dispatch.', futureCanon: { retained: true } }) }), { silent: true }));
  });

  it('keeps ambiguous legacy ownership visible and never picks a universe style by reference order', async () => {
    const { getUniverse } = await import('../services/apiUniverseBuilder');
    getUniverse.mockClear();
    getCatalogIngredientDetails.mockResolvedValue(detailsOf({ ...CHAR_FIXTURE, refs: [
      { refKind: 'universe', refId: 'first', refName: 'First world', role: 'canon-character' },
      { refKind: 'universe', refId: 'second', refName: 'Second world', role: 'canon-character' },
    ] }));
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Universe: Needs review' }));
    expect(screen.getByText('Ownership needs review')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Usage (2)'));
    expect(screen.getByRole('link', { name: /First world/ })).toHaveAttribute('href', '/universes/first');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    await screen.findByPlaceholderText(/Describe the image to render/);
    expect(getUniverse).not.toHaveBeenCalled();
  });

  it('offers to add an owned character missing from its universe cast, then loads its canon tools', async () => {
    const { getUniverse } = await import('../services/apiUniverseBuilder');
    const { linkCatalogIngredient } = await import('../services/apiCatalog');
    const ownerOnly = { ...CHAR_FIXTURE, refs: CHAR_FIXTURE.refs.filter((ref) => ref.role === 'owner') };
    getCatalogIngredientDetails.mockResolvedValue(detailsOf(ownerOnly));
    getUniverse.mockResolvedValue({ id: 'u-1', name: 'Example World', characters: [] });
    await renderPage('/casting/cat-chr-1');
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: 'Story' })));
    expect(await screen.findByText(/isn’t in Example World’s cast/)).toBeInTheDocument();
    getUniverse.mockResolvedValue({ id: 'u-1', name: 'Example World', characters: [{ id: 'character-1', ingredientId: ownerOnly.id, name: ownerOnly.name }] });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add to cast' })));
    expect(linkCatalogIngredient).toHaveBeenCalledWith(ownerOnly.id, { refKind: 'universe', refId: 'u-1', role: 'canon-character' });
    await waitFor(() => expect(screen.queryByText(/isn’t in Example World’s cast/)).not.toBeInTheDocument());
    getUniverse.mockResolvedValue({ id: 'u-1' });
  });

  it('retains the union of story, appearance, voice and evidence while a lock protects creative actions', async () => {
    const character = { ...CHAR_FIXTURE, payload: { ...CHAR_FIXTURE.payload, locked: true,
      ghost: 'Lost the first dispatch.', background: 'Raised by cartographers.', notes: 'Long form notes.',
      psychology: { assessment: 'unknown', assessmentNote: 'The narrator cannot read this mind.' },
      props: [{ name: 'Compass', notes: 'One dent.' }],
      voiceCanon: { description: 'Low and steady.', approved: false },
      firstAppearance: 'Opening chapter', missingFromProse: ['The compass origin.'], futureCanon: { retained: true } } };
    getCatalogIngredientDetails.mockResolvedValue(detailsOf(character));
    updateCatalogIngredient.mockImplementation(async (_id, patch) => ({ ...character, ...patch }));
    await renderPage('/casting/cat-chr-1');
    expect(screen.getByRole('button', { name: /Unlock Ada/ })).toBeEnabled();
    expect(screen.getByLabelText('Name')).toBeEnabled();
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: 'Story' })));
    expect(screen.getByLabelText(/^Ghost/)).toHaveValue('Lost the first dispatch.');
    expect(screen.getByLabelText('Background')).toHaveValue('Raised by cartographers.');
    expect(screen.getByLabelText('Notes', { exact: true })).toHaveValue('Long form notes.');
    expect(screen.getByText(/First appearance: Opening chapter/)).toBeInTheDocument();
    expect(screen.getByText('The compass origin.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('The Countess')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    expect(screen.getByDisplayValue('Compass')).toBeInTheDocument();
    expect(screen.getByDisplayValue('One dent.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Example route keeper' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledWith(character.id,
      expect.objectContaining({ name: 'Example route keeper', payload: character.payload }), expect.anything()));
  });

  it('preserves an explicit not-applicable assessment and safely skips malformed optional canon', async () => {
    const malformed = { ...CHAR_FIXTURE, payload: { ...CHAR_FIXTURE.payload, ghost: { invalid: true }, secrets: [null, {}],
      props: [null, {}, { name: { invalid: true } }], expressions: 'invalid', handGestures: [false],
      relationshipLinks: [null], psychology: { assessment: 'not-applicable', drives: { survival: null } } } };
    getCatalogIngredientDetails.mockResolvedValue(detailsOf(malformed));
    await renderPage('/casting/cat-chr-1');
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: 'Story' })));
    expect(screen.getByRole('option', { name: 'not-applicable' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Ghost/)).toHaveValue('');
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    expect(screen.getByText('No props yet.')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('[object Object]')).not.toBeInTheDocument();
  });

  it('shows a stored production prompt on Appearance without copying it into an editable field', async () => {
    const prompt = 'An example courier in a blue coat, standing beside a milestone.';
    getCatalogIngredientDetails.mockResolvedValue(detailsOf({ ...CHAR_FIXTURE, payload: { prompt } }));
    await renderPage();
    expect(screen.getByText(prompt)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(prompt)).not.toBeInTheDocument();
  });

  it.each([
    ['nested canon', { psychology: { strategy: 'Takes the long route.' } }, 'Psychology'],
    ['array fields', { aliases: ['Example alias'] }, 'Aliases'],
    ['previously absent fields', { notes: '' }, 'Notes'],
  ])('reports revision changes to %s even when editable scalar text matches', async (_label, changed, fieldLabel) => {
    getCatalogIngredientDetails.mockResolvedValue({
      ...detailsOf(CHAR_FIXTURE),
      revisions: [{ ...CHAR_FIXTURE, id: 'rev-1', source: 'user', payload: { ...CHAR_FIXTURE.payload, ...changed } }],
    });
    await renderPage();
    const history = within(screen.getByRole('heading', { name: /Revision history/ }).closest('section'));
    fireEvent.click(history.getByRole('button'));
    expect(history.queryByText('Identical to the current saved state.')).not.toBeInTheDocument();
    expect(history.getByText('Additional fields changed')).toBeInTheDocument();
    expect(history.getByText(fieldLabel)).toBeInTheDocument();
  });

  it('recognizes an identical complete revision despite object key order', async () => {
    const payload = { ...CHAR_FIXTURE.payload, psychology: { strategy: 'Waits.', assessment: 'unknown' } };
    const revisionPayload = { ...payload, psychology: { assessment: 'unknown', strategy: 'Waits.' } };
    getCatalogIngredientDetails.mockResolvedValue({
      ...detailsOf({ ...CHAR_FIXTURE, payload }),
      revisions: [{ ...CHAR_FIXTURE, id: 'rev-1', source: 'user', payload: revisionPayload }],
    });
    await renderPage();
    const history = within(screen.getByRole('heading', { name: /Revision history/ }).closest('section'));
    fireEvent.click(history.getByRole('button'));
    expect(history.getByText('Identical to the current saved state.')).toBeInTheDocument();
  });

  it('shows the source scrap by TITLE (not the bare id) and links to it, with siblings from the same source (#7617)', async () => {
    getCatalogIngredientDetails.mockImplementation(async () => detailsOf({
      ...CHAR_FIXTURE,
      sources: [{
        scrapId: 'cat-scrap-abc123',
        scrapTitle: 'Notebook Page Three',
        extractedAt: '2026-01-01T00:00:00.000Z',
        siblings: [{ id: 'cat-plc-1', name: 'Sibling Place', type: 'place' }],
      }],
    }));
    await renderPage();
    await waitFor(() => expect(screen.getByText('Notebook Page Three')).toBeTruthy());
    // Never the raw id — that's the bug this issue fixes.
    expect(screen.queryByText('cat-scrap-abc123')).toBeNull();
    const scrapLink = screen.getByText('Notebook Page Three').closest('a');
    expect(scrapLink.getAttribute('href')).toBe('/catalog?scrap=cat-scrap-abc123');
    // The sibling extraction from the same source scrap is listed and links to
    // its own detail page.
    expect(screen.getByText('From the same source')).toBeTruthy();
    const siblingLink = screen.getByText('Sibling Place').closest('a');
    expect(siblingLink.getAttribute('href')).toBe('/environments/cat-plc-1');
  });

  it('renders no "From the same source" stub for a solo extraction or a manually-created ingredient (#7617)', async () => {
    getCatalogIngredientDetails.mockImplementation(async () => detailsOf({
      ...CHAR_FIXTURE,
      sources: [{ scrapId: 'cat-scrap-solo', scrapTitle: 'Lone Page', extractedAt: null, siblings: [] }],
    }));
    await renderPage();
    await waitFor(() => expect(screen.getByText('Lone Page')).toBeTruthy());
    expect(screen.queryByText('From the same source')).toBeNull();

    // No source scrap at all (created manually) — the existing message, no stub.
    getCatalogIngredientDetails.mockImplementation(async () => detailsOf({ ...CHAR_FIXTURE, sources: [] }));
    await renderPage();
    await waitFor(() => expect(screen.getByText('Created manually — no source scrap.')).toBeTruthy());
    expect(screen.queryByText('From the same source')).toBeNull();
  });

  it('renders EDITABLE array editors (color palette + stats + aliases) seeded from payload', async () => {
    await renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /Add swatch/i })).toBeTruthy());
    // Editors render their values as inputs now (editable), not static text.
    expect(screen.getByDisplayValue('Brass')).toBeTruthy();
    expect(screen.getByDisplayValue('Logic')).toBeTruthy();      // stat .label
    expect(screen.getByDisplayValue('9')).toBeTruthy();          // stat .value
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: 'Story' })));
    expect(screen.getByDisplayValue('The Countess')).toBeTruthy(); // alias
  });

  it('adds an alias chip, a palette swatch, and a stat row, then Save sends them in the payload', async () => {
    const { updateCatalogIngredient } = await import('../services/apiCatalog');
    updateCatalogIngredient.mockResolvedValue({ ...CHAR_FIXTURE, name: 'Ada Lovelace' });
    await renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /Add swatch/i })).toBeTruthy());

    // Add one of each list type.
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: 'Story' })));
    fireEvent.click(screen.getByRole('button', { name: /Add alias/i }));
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    fireEvent.click(screen.getByRole('button', { name: /Add swatch/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add stat/i }));

    // Fill the newly-added rows. The new alias input is the empty one (index 1).
    const aliasInputs = screen.getAllByLabelText(/^Aliases \d+$/);
    fireEvent.change(aliasInputs[aliasInputs.length - 1], { target: { value: 'Lady Byron' } });
    // New palette name input (empty) — last "Color Palette N name".
    const paletteNames = within(screen.getByRole('region', { name: 'Color palette' })).getAllByLabelText(/row \d+ name/);
    fireEvent.change(paletteNames[paletteNames.length - 1], { target: { value: 'Cobalt' } });
    const paletteHexes = screen.getAllByLabelText(/row \d+ hex/);
    fireEvent.change(paletteHexes[paletteHexes.length - 1], { target: { value: '#0047ab' } });
    // New stat label/value inputs (the empty pair).
    const statLabels = screen.getAllByLabelText(/row \d+ label/);
    fireEvent.change(statLabels[statLabels.length - 1], { target: { value: 'Charisma' } });
    const statValues = screen.getAllByLabelText(/row \d+ value/);
    fireEvent.change(statValues[statValues.length - 1], { target: { value: '7' } });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalled());
    const [, patch] = updateCatalogIngredient.mock.calls[0];
    // aliases array carries the original + the new one.
    expect(patch.payload.aliases).toEqual(['The Countess', 'Lady Byron']);
    // colorPalette carries the original + the new { name, hex } row.
    expect(patch.payload.colorPalette).toContainEqual({ name: 'Cobalt', hex: '#0047ab', role: '' });
    // stats carry the original + the new { label, value } row (NOT { key }).
    expect(patch.payload.stats).toContainEqual({ label: 'Charisma', value: '7' });
  });

  it('links to the Casting Sheets tab when no reference sheet exists', async () => {
    await renderPage();
    await waitFor(() => expect(screen.getByText(/Render in Casting/i)).toBeTruthy());
    const link = screen.getByText(/Render in Casting/i).closest('a');
    expect(link.getAttribute('href')).toBe(`/casting/${encodeURIComponent(CHAR_FIXTURE.id)}/sheets`);
  });

  it('shows an existing reference sheet image when payload carries one', async () => {
    getCatalogIngredientDetails.mockImplementation(async () => detailsOf({
      ...CHAR_FIXTURE,
      payload: { ...CHAR_FIXTURE.payload, referenceSheetImageRef: 'sheet-123.png' },
    }));
    await renderPage();
    await waitFor(() => {
      const img = screen.getByAltText('standard reference sheet');
      expect(img.getAttribute('src')).toBe('/data/image-refs/sheet-123.png');
    });
    expect(screen.getByText(/Manage in Casting/i)).toBeTruthy();
  });

  it('composes the prompt from name + visual fields + tags, then renders and sets the portrait', async () => {
    const { generateImage } = await import('../services/apiSystem');
    const { attachCatalogIngredientGeneratedImage } = await import('../services/apiCatalog');
    generateImage.mockResolvedValue({ jobId: 'job-1' });
    attachCatalogIngredientGeneratedImage.mockResolvedValue({ kind: 'portrait', attached: true });
    await renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.')).toBeTruthy());

    // Step 1: open the editor — the prompt prefills with the composed seed.
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => expect(screen.getByPlaceholderText(/Describe the image to render/i)).toBeTruthy());
    const promptBox = screen.getByPlaceholderText(/Describe the image to render/i);
    await waitFor(() => expect(promptBox.value).toMatch(/Ada Lovelace/));
    // Composed from the name + the type's visual fields + the ingredient's tags.
    expect(promptBox.value).toMatch(/Sharp eyes/);
    expect(promptBox.value).toMatch(/mentor/);

    // Step 2: render the (possibly-edited) prompt.
    fireEvent.click(screen.getByRole('button', { name: /^Render$/i }));

    await waitFor(() => expect(generateImage).toHaveBeenCalled());
    const [genPayload] = generateImage.mock.calls[0];
    expect(genPayload.prompt).toMatch(/Ada Lovelace/);
    expect(genPayload.prompt).toMatch(/Sharp eyes/);
    expect(genPayload.catalogIngredientId).toBe('cat-chr-1');
    // The MediaJobThumb stub fires onFilename → the server-decided generated
    // attach files the render (portrait when none exists).
    await waitFor(() => expect(attachCatalogIngredientGeneratedImage).toHaveBeenCalledWith(
      'cat-chr-1', { mediaKey: 'job-1.png' }, { silent: true },
    ));
  });

  it('attaches a synchronously-returned image (external mode, no jobId)', async () => {
    const { generateImage } = await import('../services/apiSystem');
    const { attachCatalogIngredientGeneratedImage } = await import('../services/apiCatalog');
    generateImage.mockResolvedValue({ filename: 'ext.png' }); // external SD-API: no jobId
    attachCatalogIngredientGeneratedImage.mockResolvedValue({ kind: 'portrait', attached: true });
    await renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Render$/i })).toBeTruthy());
    // Wait for the async prefill so Render is enabled before clicking.
    await waitFor(() => expect(screen.getByRole('button', { name: /^Render$/i })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: /^Render$/i }));

    await waitFor(() => expect(attachCatalogIngredientGeneratedImage).toHaveBeenCalledWith(
      'cat-chr-1', { mediaKey: 'ext.png' }, { silent: true },
    ));
  });

  it('re-enables Generate after a failed render (does not get stuck)', async () => {
    const { generateImage } = await import('../services/apiSystem');
    generateImage.mockResolvedValue({ jobId: 'fail-job' });
    await renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Render$/i })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: /^Render$/i }));
    // The MediaJobThumb stub drives onStatus('failed') for 'fail-job'; the
    // control must clear the job, close the editor, and re-enable Generate
    // rather than hang on "Generating…".
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /^Generate$/i });
      expect(btn).toHaveProperty('disabled', false);
    });
  });

  it('disables Render until a prompt is present (no description → name-only prefill still renders)', async () => {
    getCatalogIngredientDetails.mockImplementation(async () => detailsOf({
      ...CHAR_FIXTURE,
      tags: [],
      payload: { role: 'Mentor' }, // no physicalDescription/description/summary
    }));
    await renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Generate$/i })).toBeTruthy());
    // Generate is always enabled now — it opens the editor so the user can
    // compose a prompt even when no visual seed exists.
    expect(screen.getByRole('button', { name: /^Generate$/i })).toHaveProperty('disabled', false);

    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    // The name still seeds the prompt, so Render becomes enabled.
    await waitFor(() => expect(screen.getByRole('button', { name: /^Render$/i })).toHaveProperty('disabled', false));
    const promptBox = screen.getByPlaceholderText(/Describe the image to render/i);
    expect(promptBox.value).toMatch(/Ada Lovelace/);

    // Clearing the prompt disables Render.
    fireEvent.change(promptBox, { target: { value: '   ' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Render$/i })).toHaveProperty('disabled', true));
  });

  it('keeps ownership controls after reloading the same character through a library route', async () => {
    const { router } = await renderPage('/catalog/character/cat-chr-1');
    expect(await screen.findByRole('button', { name: 'Universe: My Cool Universe' })).toBeVisible();
    await act(async () => router.navigate('/casting/cat-chr-1'));
    expect(await screen.findByRole('button', { name: 'Universe: My Cool Universe' })).toBeVisible();
  });

  it.each([
    ['character', 'casting', 'references'],
    ['place', 'environments', 'plates'],
    ['object', 'objects', 'images'],
  ])('keeps the %s universe control in the header across library sections', async (type, library, tab) => {
    const item = { ...CHAR_FIXTURE, id: 'item-1', type, name: 'Example item', payload: {}, refs: [
      { refKind: 'universe', refId: 'u-1', refName: 'Example World', role: 'owner' },
    ] };
    getCatalogIngredientDetails.mockImplementation(async () => detailsOf(item));
    const { router } = await renderPage(`/${library}/item-1`);
    const header = screen.getByRole('heading', { name: 'Example item', level: 1 }).closest('header');
    const control = within(header).getByRole('button', { name: 'Universe: Example World' });
    expect(screen.queryByRole('dialog', { name: 'Universe ownership and usage' })).toBeNull();
    fireEvent.click(control);
    expect(screen.getByRole('dialog', { name: 'Universe ownership and usage' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => router.navigate(`/${library}/item-1/${tab}`));
    fireEvent.click(within(screen.getByRole('heading', { name: 'Example item', level: 1 }).closest('header')).getByRole('button', { name: 'Universe: Example World' }));
    expect(screen.getByRole('dialog', { name: 'Universe ownership and usage' })).toBeVisible();
  });

  it('uses the latest physical description when reopening generation after cancelling an edited prompt', async () => {
    await renderPage('/casting/cat-chr-1');
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    const prompt = await screen.findByPlaceholderText(/Describe the image to render/i);
    await waitFor(() => expect(prompt.value).toContain('Sharp eyes'));
    fireEvent.change(prompt, { target: { value: 'A temporary prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.change(screen.getByLabelText('Physical Description'), { target: { value: 'A silver coat' } });
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => expect(screen.getByPlaceholderText(/Describe the image to render/i).value).toContain('A silver coat'));
  });

  it('collapses a compact sheet group when its header is clicked', async () => {
    await renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('she/her')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Visual identity/ }));
    expect(screen.getByLabelText('Silhouette notes')).not.toBeVisible();
    expect(screen.getByLabelText('Physical Description')).toBeVisible();
    expect(screen.getByDisplayValue('she/her')).toBeInTheDocument();
  });

  // #11317: the box holds only the record's own words. The linked universe's
  // style rides beside it as a labeled addition, the preview shows the exact
  // composed text, and the render sends that same composed request.
  it('keeps the universe style out of the prompt box and sends it as a labeled addition', async () => {
    const { getUniverse } = await import('../services/apiUniverseBuilder');
    const { generateImage } = await import('../services/apiSystem');
    getUniverse.mockResolvedValue({
      influences: { embrace: ['neon noir', 'rain-slick streets'], avoid: ['cartoon', 'flat colors'] },
    });
    // No clearMocks config — clear prior tests' calls so calls[0] is this render's.
    generateImage.mockClear();
    generateImage.mockResolvedValue({ jobId: 'job-uni' });
    await renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    const promptBox = await screen.findByPlaceholderText(/Describe the image to render/i);
    // Fetched by the ingredient's universe refId, silently (no error toast).
    expect(getUniverse).toHaveBeenCalledWith('u-1', { silent: true });
    // The preview names the universe style as a chip once the universe loads.
    fireEvent.click(await screen.findByRole('button', { name: '+ Universe style' }));
    expect(screen.getByText(/neon noir, rain-slick streets/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Style negatives' })).toBeTruthy();
    // The editable prompt is only the record's own seed — no preset tokens.
    expect(promptBox.value).toBe('Ada Lovelace: Sharp eyes, ink-stained cuffs.. mentor, My Cool Universe');
    expect(screen.getByLabelText(/Negative prompt/).value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: /^Render$/i }));
    await waitFor(() => expect(generateImage).toHaveBeenCalled());
    const [payload] = generateImage.mock.calls[0];
    expect(payload.prompt).toMatch(/^neon noir, rain-slick streets\. Ada Lovelace: Sharp eyes/);
    expect(payload.negativePrompt).toMatch(/cartoon/);
    expect(payload.promptAdditions.map((addition) => addition.label)).toEqual(['Universe style', 'Style negatives']);
    getUniverse.mockResolvedValue({ id: 'u-1' });
  });

  // Regression: the textarea is editable during the awaited universe fetch, so a
  // user typing before it resolves must NOT have their input clobbered by the
  // async prefill (codex review). Deferred getUniverse controls the race window.
  it('does not overwrite a prompt the user typed during the universe prefill', async () => {
    const { getUniverse } = await import('../services/apiUniverseBuilder');
    let resolveUniverse;
    getUniverse.mockImplementation(() => new Promise((res) => { resolveUniverse = res; }));
    await renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    const promptBox = await screen.findByPlaceholderText(/Describe the image to render/i);
    // User types before the universe fetch resolves.
    fireEvent.change(promptBox, { target: { value: 'my hand-written prompt' } });
    // Now the fetch resolves with a universe whose preset would otherwise overwrite.
    resolveUniverse({ influences: { embrace: ['neon noir'], avoid: [] } });
    // The user's text survives — the prefill is skipped because the field is dirty.
    await waitFor(() => expect(screen.getByRole('button', { name: /^Render$/i })).toHaveProperty('disabled', false));
    expect(promptBox.value).toBe('my hand-written prompt');
    expect(promptBox.value).not.toMatch(/neon noir/);
    getUniverse.mockResolvedValue({ id: 'u-1' });
  });

  it('attributes relation evidence only to the matching outbound kind and target', async () => {
    const fixtureWithRelations = {
      ...CHAR_FIXTURE,
      payload: {
        ...CHAR_FIXTURE.payload,
        evidence: [
          'owned-by → Pocket Watch: Ada carries this golden pocket watch everywhere',
          'used-by → Pocket Watch: Ada times experiments with the watch',
          'used-by → Analytical Engine: Ada programmed the engine with punch cards',
        ],
      },
    };
    getCatalogIngredientDetails.mockImplementation(async () => ({
      ...detailsOf(fixtureWithRelations),
      relations: {
        outbound: [
          {
            toId: 'cat-obj-1',
            kind: 'owned-by',
            other: { id: 'cat-obj-1', name: 'Pocket Watch', type: 'object' },
          },
          {
            toId: 'cat-obj-1',
            kind: 'used-by',
            other: { id: 'cat-obj-1', name: 'Pocket Watch', type: 'object' },
          },
        ],
        inbound: [
          {
            fromId: 'cat-obj-2',
            kind: 'used-by',
            other: { id: 'cat-obj-2', name: 'Analytical Engine', type: 'object' },
          },
        ],
      },
    }));

    await renderPage();

    // Outbound uses getRelationKind('owned-by').label -> "Owned by" (appears in select option + relation list)
    const ownedByElements = await screen.findAllByText('Owned by');
    expect(ownedByElements.length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Pocket Watch')).toHaveLength(2);
    expect(screen.getAllByText(/Ada carries this golden pocket watch everywhere/)).toHaveLength(2);
    expect(screen.getAllByText(/Ada times experiments with the watch/)).toHaveLength(2);

    // Inbound uses getRelationKind('used-by').inverseLabel -> "Uses"
    expect(screen.getByText('Uses')).toBeTruthy();
    expect(screen.getByText('Analytical Engine')).toBeTruthy();
    // This ingredient's evidence cannot ground a relation owned by another ingredient.
    expect(screen.getAllByText(/Ada programmed the engine with punch cards/)).toHaveLength(1);

    // SourcesPanel grounded evidence
    expect(screen.getByText('Grounded evidence')).toBeTruthy();
  });
});

describe('buildGenerationPromptSeed', () => {
  const charType = { primaryContentKey: 'physicalDescription' };

  it('folds every populated visual field together in order', () => {
    const seed = buildGenerationPromptSeed({
      physicalDescription: 'Sharp eyes',
      visualNotes: 'ink-stained cuffs',
      visualIdentity: 'brass goggles',
    }, charType);
    expect(seed).toBe('Sharp eyes. ink-stained cuffs. brass goggles');
  });

  it('dedupes the primaryContentKey against the visual keys (no double-render)', () => {
    // physicalDescription is BOTH the primary key and a visual key — it must
    // only appear once.
    const seed = buildGenerationPromptSeed({ physicalDescription: 'Once only' }, charType);
    expect(seed).toBe('Once only');
  });

  it('appends string tags as comma-joined prompt tokens after the seed', () => {
    const seed = buildGenerationPromptSeed(
      { physicalDescription: 'Sharp eyes' }, charType, ['mentor', 'My Cool Universe'],
    );
    expect(seed).toBe('Sharp eyes. mentor, My Cool Universe');
  });

  it('falls back to tags alone when no visual field is present', () => {
    expect(buildGenerationPromptSeed({ role: 'Mentor' }, charType, ['villain'])).toBe('villain');
  });

  it('falls back to description / summary when the primary visual key is absent', () => {
    expect(buildGenerationPromptSeed({ description: 'A quiet place' }, { primaryContentKey: 'name' }))
      .toBe('A quiet place');
    expect(buildGenerationPromptSeed({ summary: 'In brief' }, null)).toBe('In brief');
  });

  it('ignores non-string and blank tags', () => {
    const seed = buildGenerationPromptSeed(
      { physicalDescription: 'Sharp eyes' }, charType, ['  ', 42, null, 'real'],
    );
    expect(seed).toBe('Sharp eyes. real');
  });

  it('tolerates a non-array tags argument', () => {
    expect(buildGenerationPromptSeed({ physicalDescription: 'Sharp eyes' }, charType, 'nope'))
      .toBe('Sharp eyes');
  });

  it('returns an empty string when nothing usable is present', () => {
    expect(buildGenerationPromptSeed({ role: 'Mentor' }, charType, [])).toBe('');
    expect(buildGenerationPromptSeed(null, null, [])).toBe('');
  });

  it('preserves a long visual description without silently truncating it)', () => {
    const seed = buildGenerationPromptSeed({ physicalDescription: 'x'.repeat(900) }, charType);
    expect(seed).toBe('x'.repeat(900));
  });
});

describe('contextual unlock in Create libraries', () => {
  it.each([['objects', 'object'], ['environments', 'place'], ['casting', 'character']])(
    'preserves draft edits and sheet selection in %s and renders only on request', async (library, type) => {
      const api = await import('../services/apiCatalog');
      const locked = { id: 'example-locked', type, name: 'Example locked record', tags: [], payload: { locked: true, description: 'Saved description' }, refs: [] };
      let persisted = locked;
      getCatalogIngredientDetails.mockImplementation(async () => detailsOf(persisted));
      updateCatalogIngredient.mockImplementation(async (_id, patch) => {
        persisted = { ...persisted, ...patch, updatedAt: '2026-01-01T00:00:01Z' };
        return persisted;
      });
      api.setCatalogIngredientLock.mockImplementation(async (_id, lockedFlag) => { persisted = { ...persisted, payload: { ...persisted.payload, locked: lockedFlag } }; return persisted; });
      api.listCatalogSheetVariants.mockResolvedValue({ variants: [{ id: 'standard', label: 'Standard' }, { id: 'alternate', label: 'Alternate' }] });
      api.renderCatalogSheet.mockReset().mockResolvedValue({ jobId: 'example-sheet-job', variant: 'alternate' });
      api.attachCatalogIngredientMedia.mockResolvedValue({});
      const { router } = await renderPage(`/${library}/example-locked/profile`);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Unsaved draft name' } });
      await act(async () => router.navigate(`/${library}/example-locked/sheets`));
      const picker = await screen.findByLabelText('Sheet kind');
      fireEvent.change(picker, { target: { value: 'alternate' } });
      expect(screen.getByRole('button', { name: /Generate sheet/ })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Unlock for rendering' }));
      await screen.findByText(/Unlocked. Choose Generate/);
      expect(picker).toHaveValue('alternate');
      expect(api.renderCatalogSheet).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /Generate sheet/ })).toBeDisabled();
      expect(api.setCatalogIngredientLock).toHaveBeenCalledWith('example-locked', false, { silent: true });
      expect(updateCatalogIngredient).not.toHaveBeenCalled();
      await act(async () => router.navigate(`/${library}/example-locked/profile`));
      expect(screen.getByLabelText('Name')).toHaveValue('Unsaved draft name');
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(persisted.name).toBe('Unsaved draft name'));
      await act(async () => router.navigate(`/${library}/example-locked/sheets`));
      await waitFor(() => expect(screen.getByRole('button', { name: /Generate sheet/ })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: /Generate sheet/ }));
      await waitFor(() => expect(api.renderCatalogSheet).toHaveBeenCalledTimes(1));
    },
  );
});

describe('Casting lean first render', () => {
  it('updates the open profile cover for an asset change and keeps the unsaved draft', async () => {
    const ingredient = { ...CHAR_FIXTURE, updatedAt: '2026-01-01T00:00:00.000Z' };
    const { media: _media, missingMedia: _missingMedia, ...profile } = detailsOf(ingredient);
    getCatalogIngredientDetails.mockClear().mockResolvedValue({ ...profile, coverMedia: { portraitKey: 'before.png' } });
    await renderPage('/casting/cat-chr-1/profile');
    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Unsaved name' } });
    expect(screen.getByAltText(`${ingredient.name} cover`)).toHaveAttribute('src', '/data/image-thumbnails/before.webp');

    getCatalogIngredientDetails.mockResolvedValue({ ...profile, coverMedia: { portraitKey: 'after.png' } });
    await act(async () => emitSocket('catalog:assets-changed', { ingredientId: 'cat-chr-other' }));
    expect(getCatalogIngredientDetails).toHaveBeenCalledTimes(1);
    await act(async () => emitSocket('catalog:assets-changed', { ingredientId: ingredient.id }));
    expect(screen.getByAltText(`${ingredient.name} cover`)).toHaveAttribute('src', '/data/image-thumbnails/after.webp');
    expect(name).toHaveValue('Unsaved name');
  });

  it('keeps loaded sheet selection mounted and updates its cover during a background identity refresh', async () => {
    const api = await import('../services/apiCatalog');
    api.listCatalogSheetVariants.mockResolvedValue({ variants: [{ id: 'standard', label: 'Standard' }, { id: 'expressions', label: 'Expressions' }] });
    const profile = detailsOf(CHAR_FIXTURE);
    delete profile.media; delete profile.missingMedia; delete profile.revisions;
    profile.coverMedia = { portraitKey: 'initial.png', referenceKey: null };
    const background = Promise.withResolvers();
    let mediaCalls = 0;
    getCatalogIngredientDetails.mockImplementation((_id, options) => options?.view === 'media'
      ? ++mediaCalls === 1 ? Promise.resolve({ media: [{ kind: 'portrait', mediaKey: 'loaded.png' }], missingMedia: [] }) : background.promise
      : Promise.resolve(profile));
    const { router } = await renderPage('/casting/cat-chr-1/sheets');
    const picker = await screen.findByLabelText('Sheet kind');
    fireEvent.change(picker, { target: { value: 'expressions' } });
    await act(async () => emitSocket('catalog:identity-changed', { sourceId: CHAR_FIXTURE.id }));
    expect(mediaCalls).toBe(2);
    expect(screen.getByLabelText('Sheet kind')).toBe(picker);
    expect(picker).toHaveValue('expressions');
    expect(screen.queryByText('Loading media…')).toBeNull();
    await act(async () => background.resolve({ media: [{ kind: 'portrait', mediaKey: 'fresh.png' }], missingMedia: [] }));
    expect(screen.getByLabelText('Sheet kind')).toBe(picker);
    expect(picker).toHaveValue('expressions');
    await act(async () => router.navigate('/casting/cat-chr-1/profile'));
    expect(screen.getByAltText(`${CHAR_FIXTURE.name} cover`)).toHaveAttribute('src', '/data/image-thumbnails/fresh.webp');
  });

  it('edits the profile while usage is pending and loads history/media only when requested, preserving its draft', async () => {
    const profile = detailsOf(CHAR_FIXTURE);
    delete profile.revisions; delete profile.media; delete profile.missingMedia;
    profile.universeContext = { ...profile.universeContext, usageComplete: false };
    profile.coverMedia = { portraitKey: 'example-cover.png', referenceKey: null };
    const usage = Promise.withResolvers();
    const images = Promise.withResolvers();
    getCatalogIngredientDetails.mockClear().mockImplementation((_id, options) => options?.view === 'media' ? images.promise : Promise.resolve(profile));
    getCatalogUniverseContext.mockImplementation(() => usage.promise);
    listCatalogIngredientRevisions.mockClear().mockResolvedValue({ items: [] });
    const { router } = await renderPage('/casting/cat-chr-1/profile');
    await screen.findByLabelText('Name');
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    const description = screen.getByDisplayValue(CHAR_FIXTURE.payload.physicalDescription);
    expect(screen.getByAltText(`${CHAR_FIXTURE.name} cover`)).toHaveAttribute('src', '/data/image-thumbnails/example-cover.webp');
    expect(getCatalogIngredientDetails.mock.calls.map(([, options]) => options.view)).toEqual(['profile']);
    expect(listCatalogIngredientRevisions).not.toHaveBeenCalled();
    expect(screen.queryByText('No revisions recorded yet.')).toBeNull();
    fireEvent.change(description, { target: { value: 'Draft remains local.' } });
    await act(async () => usage.resolve({ ...profile.universeContext, usageComplete: true }));
    expect(screen.getByDisplayValue('Draft remains local.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load revision history' }));
    await screen.findByText('No revisions recorded yet.');
    expect(listCatalogIngredientRevisions).toHaveBeenCalledTimes(1);
    await act(async () => router.navigate('/casting/cat-chr-1/references'));
    expect(getCatalogIngredientDetails.mock.calls.map(([, options]) => options.view)).toEqual(['profile', 'media']);
    expect(screen.getByText('Loading media…')).toBeInTheDocument();
    await act(async () => router.navigate('/casting/cat-chr-1/profile'));
    await act(async () => images.resolve({ media: [], missingMedia: [] }));
    expect(screen.getByDisplayValue('Draft remains local.')).toBeInTheDocument();
    expect(screen.queryByAltText(`${CHAR_FIXTURE.name} cover`)).toBeNull();
    expect(listCatalogIngredientRevisions).toHaveBeenCalledTimes(1);
  });
});

it('keeps meaningful incomplete compact rows dirty across tabs and refuses a Save that would drop them', async () => {
  const { router } = await renderPage('/casting/cat-chr-1');
  fireEvent.click(screen.getByRole('button', { name: 'Add stat' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'row 2 value' }), { target: { value: 'Tall' } });
  expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  expect(updateCatalogIngredient).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('stat label'));
  await act(async () => router.navigate('/casting/cat-chr-1/references'));
  await act(async () => router.navigate('/casting/cat-chr-1/profile'));
  expect(screen.getByRole('textbox', { name: 'row 2 value' })).toHaveValue('Tall');
  fireEvent.change(screen.getByRole('textbox', { name: 'row 2 label' }), { target: { value: 'Height' } });
  updateCatalogIngredient.mockImplementation(async (_id, patch) => ({ ...CHAR_FIXTURE, ...patch }));
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledWith(CHAR_FIXTURE.id,
    expect.objectContaining({ payload: expect.objectContaining({ stats: [{ label: 'Logic', value: '9' }, { label: 'Height', value: 'Tall' }] }) }), { silent: true }));
});

it('returns to an allowed Universe Cast context while retaining compact page query through media navigation', async () => {
  const back = '/universes/example-world?tab=cast&series=example-series';
  const { router } = await renderPage(`/casting/cat-chr-1?${new URLSearchParams({ returnTo: back })}`);
  expect(screen.getByRole('link', { name: 'Back to Casting' })).toHaveAttribute('href', back);
  await act(async () => fireEvent.click(screen.getByRole('tab', { name: 'Story' })));
  await act(async () => router.navigate(`/casting/cat-chr-1/references${router.state.location.search}`));
  await act(async () => router.navigate(`/casting/cat-chr-1/profile${router.state.location.search}`));
  expect(screen.getByRole('tab', { name: 'Story' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('link', { name: 'Back to Casting' })).toHaveAttribute('href', back);
});

it('returns to the music video that opened a cast member to revise its look', async () => {
  const back = '/music-video/example-project/cast-sets';
  await renderPage(`/casting/cat-chr-1?${new URLSearchParams({ returnTo: back })}`);
  expect(screen.getByRole('link', { name: 'Back to music video' })).toHaveAttribute('href', back);
});
