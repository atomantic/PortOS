import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PanelDrawer from './PanelDrawer';

const listCatalogIngredientsByIds = vi.fn();
const listCatalogIngredientMedia = vi.fn();
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listCatalogIngredientsByIds: (...args) => listCatalogIngredientsByIds(...args),
    listCatalogIngredientMedia: (...args) => listCatalogIngredientMedia(...args),
  };
});

const panel = {
  id: 'panel-1',
  castIds: ['cat-example-1'],
  environmentIds: [],
  objectIds: [],
  setShot: null,
  notes: '',
  takes: [],
  selectedTakeId: null,
};

function renderCast(extra = {}, onPatch = vi.fn()) {
  const current = { ...panel, ...extra };
  render(
    <MemoryRouter initialEntries={['/storyboards/sb-example/panel/panel-1?panelTab=cast']}>
      <PanelDrawer
        open
        board={{ id: 'sb-example', aspectRatio: '16:9', artStyle: 'production-sketch' }}
        found={{ panel: current, beat: { id: 'beat-1', title: 'Rink', panels: [current] }, beatIndex: 0 }}
        panelNumber={1}
        sketchNonce={0}
        busy={false}
        onClose={() => {}}
        handlers={{ onPatch }}
      />
    </MemoryRouter>,
  );
  return onPatch;
}

describe('panel cast image picker', () => {
  beforeEach(() => {
    listCatalogIngredientsByIds.mockReset();
    listCatalogIngredientMedia.mockReset();
    listCatalogIngredientsByIds.mockResolvedValue([{ id: 'cat-example-1', name: 'Aunt Mae', type: 'character' }]);
    listCatalogIngredientMedia.mockResolvedValue([
      { kind: 'portrait', mediaKey: 'funeral-suit.png', library: { variant: { label: 'Funeral suit' } } },
      { kind: 'reference', mediaKey: 'rink-clothes.png', caption: 'Rink clothes' },
      { kind: 'audio', mediaKey: 'voice.wav' },
    ]);
  });

  it('lets a panel choose one image of a linked record, and clear back to the newest portrait', async () => {
    const onPatch = renderCast();
    expect(await screen.findByRole('option', { name: 'Newest portrait (Funeral suit)' })).toBeTruthy();
    const select = screen.getByLabelText('Image for Aunt Mae');
    expect(select.value).toBe('');
    expect(screen.queryByRole('option', { name: 'voice.wav' })).toBeNull();

    fireEvent.change(select, { target: { value: 'rink-clothes.png' } });
    expect(onPatch).toHaveBeenCalledWith({ linkMedia: { 'cat-example-1': 'rink-clothes.png' } });

    cleanup();
    onPatch.mockClear();
    renderCast({ linkMedia: { 'cat-example-1': 'rink-clothes.png' } }, onPatch);
    expect(await screen.findByRole('option', { name: 'Rink clothes' })).toBeTruthy();
    const chosen = screen.getByLabelText('Image for Aunt Mae');
    expect(chosen.value).toBe('rink-clothes.png');
    fireEvent.change(chosen, { target: { value: '' } });
    expect(onPatch).toHaveBeenCalledWith({ linkMedia: null });
  });

  it('keeps a saved image that is no longer on the record visible so it can be cleared', async () => {
    renderCast({ linkMedia: { 'cat-example-1': 'gone.png' } });
    const select = await screen.findByLabelText('Image for Aunt Mae');
    expect(select.value).toBe('gone.png');
    expect(screen.getByRole('option', { name: 'Saved image missing' })).toBeTruthy();
  });
});
