import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// Mock the api barrel — the editor loads both picker lists on mount.
const api = vi.hoisted(() => ({ listRounds: vi.fn(), listTracks: vi.fn() }));
vi.mock('../../services/api', () => api);

import { SongLinkChips, SongLinksEditor } from './SongLinks.jsx';

// Invented fixture data only (privacy convention).
const ROUNDS = [{ id: 'r1', title: 'Example Round' }, { id: 'r2', title: 'Second Round' }];
const TRACKS = [{ id: 't1', title: 'Example Track' }];

const renderEditor = (links, onChange = vi.fn()) => {
  render(<MemoryRouter><SongLinksEditor links={links} onChange={onChange} /></MemoryRouter>);
  return onChange;
};

describe('SongLinkChips', () => {
  it('renders nothing for an empty or absent list', () => {
    const { container, rerender } = render(<MemoryRouter><SongLinkChips links={[]} /></MemoryRouter>);
    expect(container.textContent).toBe('');
    rerender(<MemoryRouter><SongLinkChips links={undefined} /></MemoryRouter>);
    expect(container.textContent).toBe('');
  });

  it('falls back through fresh title → stored label → raw id, never blank', () => {
    render(
      <MemoryRouter>
        <SongLinkChips links={[
          { type: 'round', id: 'r1', label: 'Example Round' },
          { type: 'track', id: 't1', label: '' },
        ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /Example Round/ })).toBeTruthy();
    // No label stored (a link made before the field carried one) → the id shows.
    expect(screen.getByRole('link', { name: /t1/ })).toBeTruthy();
  });
});

describe('SongLinksEditor', () => {
  beforeEach(() => {
    api.listRounds.mockReset().mockResolvedValue({ rounds: ROUNDS });
    api.listTracks.mockReset().mockResolvedValue(TRACKS);
  });

  it('hides already-linked records from the picker options', async () => {
    renderEditor([{ type: 'round', id: 'r1', label: 'Example Round' }]);
    const target = await screen.findByLabelText('Record to link');
    // Placeholder + the one unlinked round (r1 is already linked).
    await waitFor(() => expect(within(target).getAllByRole('option')).toHaveLength(2));
    expect(within(target).queryByRole('option', { name: 'Example Round' })).toBeNull();
    expect(within(target).getByRole('option', { name: 'Second Round' })).toBeTruthy();
  });

  it('switches the option list with the type select and resets the pending target', async () => {
    renderEditor([]);
    const target = await screen.findByLabelText('Record to link');
    await waitFor(() => expect(within(target).getAllByRole('option')).toHaveLength(3));
    fireEvent.change(target, { target: { value: 'r1' } });
    expect(target.value).toBe('r1');

    fireEvent.change(screen.getByLabelText('Link type'), { target: { value: 'track' } });
    // The round id would be meaningless under `track` — the pending pick clears.
    expect(screen.getByLabelText('Record to link').value).toBe('');
    expect(within(screen.getByLabelText('Record to link')).getByRole('option', { name: 'Example Track' })).toBeTruthy();
  });

  // The stored label is a snapshot from link time. When the target IS present
  // locally its CURRENT title wins, so a renamed record doesn't read stale.
  it('prefers the target record\'s current title over a stale stored label', async () => {
    renderEditor([{ type: 'round', id: 'r1', label: 'Old Name' }]);
    expect(await screen.findByText('Example Round')).toBeTruthy();
    expect(screen.queryByText('Old Name')).toBeNull();
  });

  // …but a link whose target is missing on THIS machine (Rounds/Tracks are not
  // brain records and need not exist on every peer) still shows its name.
  it('keeps showing the stored label when the target is not on this machine', async () => {
    renderEditor([{ type: 'round', id: 'elsewhere', label: 'Remote Round' }]);
    expect(await screen.findByText('Remote Round')).toBeTruthy();
  });

  it('removes a link through onChange without mutating the passed array', async () => {
    const links = [{ type: 'round', id: 'r1', label: 'Example Round' }];
    const onChange = renderEditor(links);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove link to Example Round' }));
    expect(onChange).toHaveBeenCalledWith([]);
    expect(links).toHaveLength(1);
  });

  // Nothing dedupes the stored array — brain records sync raw with no
  // receive-side validation, so a record can arrive holding the same {type,id}
  // twice. Removing one must not take its twin with it.
  it('removes only the clicked row when the record holds a duplicate link', async () => {
    const dupe = [
      { type: 'round', id: 'r1', label: 'Example Round' },
      { type: 'round', id: 'r1', label: 'Example Round' },
      { type: 'track', id: 't1', label: 'Example Track' },
    ];
    const onChange = renderEditor(dupe);
    const buttons = await screen.findAllByRole('button', { name: 'Remove link to Example Round' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    expect(onChange).toHaveBeenCalledWith([dupe[1], dupe[2]]);
  });

  it('disables Add until a record is picked', async () => {
    const onChange = renderEditor([]);
    const add = await screen.findByRole('button', { name: 'Add link' });
    expect(add.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Link type'), { target: { value: 'track' } });
    fireEvent.change(await screen.findByLabelText('Record to link'), { target: { value: 't1' } });
    expect(add.disabled).toBe(false);

    fireEvent.click(add);
    // The label is captured from the picked record, not left blank.
    expect(onChange).toHaveBeenCalledWith([{ type: 'track', id: 't1', label: 'Example Track' }]);
  });

  // `null` (not fetched / failed) must not read the same as `[]` (fetched, this
  // install genuinely has none) — but both leave the picker unusable, so the
  // message has to say which.
  it('distinguishes "loading" from "this install has none"', async () => {
    api.listRounds.mockResolvedValue({ rounds: [] });
    renderEditor([]);
    const target = await screen.findByLabelText('Record to link');
    await waitFor(() => expect(target.textContent).toContain('No rounds available'));
    expect(target.disabled).toBe(true);
  });
});
