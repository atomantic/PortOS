import { useRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MediaLightbox from './MediaLightbox';
import BulkTargetPicker from './BulkTargetPicker';

// Keep the actual lightbox and organization pickers together: mocking those
// children hid the portal's interaction with the viewer's focus/Escape trap.
vi.mock('./PromptRefineModal', () => ({ default: () => null }));
vi.mock('./PromptFromMedia', () => ({ PromptFromMediaModal: () => null }));
const api = vi.hoisted(() => ({
  listMediaCollections: vi.fn(), createMediaCollection: vi.fn(),
  addMediaCollectionItem: vi.fn(), removeMediaCollectionItem: vi.fn(),
  listMoodBoards: vi.fn(), createMoodBoard: vi.fn(),
  addMoodBoardItem: vi.fn(), removeMoodBoardItem: vi.fn(),
}));
vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
const item = {
  kind: 'image', key: 'image:fixture.png', filename: 'fixture.png',
  previewUrl: '/data/images/fixture.png', downloadUrl: '/data/images/fixture.png',
};
const records = (count) => Array.from({ length: count }, (_, index) => ({
  id: `fixture-${index}`, name: `Fixture ${index}`, items: [], source: 'user',
}));

beforeEach(() => vi.clearAllMocks());

describe('lightbox organization keyboard ownership', () => {
  it.each([
    ['Add to collection', 'Collections', 0], ['Add to collection', 'Collections', 1],
    ['Add to collection', 'Collections', 6], ['Pin to mood board', 'Mood boards', 0],
    ['Pin to mood board', 'Mood boards', 1], ['Pin to mood board', 'Mood boards', 6],
  ])('%s / %s contains focus and Escape with %i records', async (triggerName, dialogName, count) => {
    api.listMediaCollections.mockResolvedValue(records(count));
    api.listMoodBoards.mockResolvedValue(records(count));
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<MediaLightbox item={item} onClose={onClose} />);
    const trigger = screen.getByRole('button', { name: triggerName });
    trigger.focus();
    await user.keyboard('{Enter}');
    const picker = await screen.findByRole('dialog', { name: dialogName });
    await waitFor(() => expect(picker.contains(document.activeElement)).toBe(true));
    if (count > 0) await within(picker).findByRole('button', { name: 'Fixture 0' });
    const controls = within(picker).getAllByRole('textbox');
    expect(controls).toHaveLength(count >= 6 ? 2 : 1);
    const first = count >= 6 ? controls[0] : count ? within(picker).getByRole('button', { name: 'Fixture 0' }) : controls[0];
    first.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(controls.at(-1));
    await user.tab();
    expect(document.activeElement).toBe(first);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: dialogName })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.addMediaCollectionItem).not.toHaveBeenCalled();
    expect(api.addMoodBoardItem).not.toHaveBeenCalled();
  });

  it('keeps the loading focus target usable, then preserves row focus after a successful action', async () => {
    let resolveList;
    api.listMediaCollections.mockReturnValue(new Promise((resolve) => { resolveList = resolve; }));
    api.addMediaCollectionItem.mockResolvedValue({ ...records(1)[0], items: [{ kind: item.kind, ref: item.filename }] });
    const user = userEvent.setup();
    render(<MediaLightbox item={item} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Add to collection' }));
    const picker = screen.getByRole('dialog', { name: 'Collections' });
    const createField = within(picker).getByRole('textbox', { name: 'New collection name' });
    await waitFor(() => expect(document.activeElement).toBe(createField));
    await act(async () => resolveList(records(1)));
    expect(document.activeElement).toBe(createField);
    await user.tab();
    const row = within(picker).getByRole('button', { name: 'Fixture 0' });
    expect(document.activeElement).toBe(row);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(row).toHaveAttribute('aria-pressed', 'true'));
    expect(document.activeElement).toBe(row);
    await user.click(screen.getByRole('button', { name: 'Pin to mood board' }));
    expect(screen.queryByRole('dialog', { name: 'Collections' })).toBeNull();
    expect(document.activeElement.closest('[role="dialog"]')).toHaveAttribute('aria-label', 'Mood boards');
  });
});

it('returns the bulk picker to its trigger after choosing a destination', async () => {
  const onPick = vi.fn();
  function BulkHost() {
    const anchorRef = useRef(null);
    const [open, setOpen] = useState(false);
    return <>
      <button ref={anchorRef} onClick={() => setOpen(true)}>Copy selected</button>
      {open && <BulkTargetPicker anchorRef={anchorRef} collections={records(1)} onClose={() => setOpen(false)}
        onPick={(...args) => { onPick(...args); setOpen(false); }} />}
    </>;
  }
  const user = userEvent.setup();
  render(<BulkHost />);
  const trigger = screen.getByRole('button', { name: 'Copy selected' });
  trigger.focus();
  await user.keyboard('{Enter}');
  const picker = screen.getByRole('dialog', { name: 'Pick a collection' });
  expect(picker.contains(document.activeElement)).toBe(true);
  await user.keyboard('{Enter}');
  expect(onPick).toHaveBeenCalledWith('fixture-0', 'Fixture 0');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
