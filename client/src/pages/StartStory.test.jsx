import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import StartStory from './StartStory';
import { findEnabledByLabelText } from '../test/enabledBarrier.js';

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router', async (io) => {
  const actual = await io();
  return { ...actual, useNavigate: () => navigateMock };
});

const listUniverseNames = vi.hoisted(() => vi.fn());
vi.mock('../services/api', () => ({
  listUniverseNames: (...a) => listUniverseNames(...a),
}));

const toastError = vi.hoisted(() => vi.fn());
vi.mock('../components/ui/Toast', () => ({
  default: { error: (...a) => toastError(...a) },
}));

// Opt into "use an existing universe" and return the picker it renders.
//
// The radio is gated by the async universe list, but all three mode cards
// come from a static list and are on screen synchronously — a helper that
// waited on card text would resolve before the fetch and click a
// still-disabled radio (#7592). See enabledBarrier.js for the general hazard.
//
// Returning the select rather than nothing is deliberate — it makes the helper
// assert that opting in actually TOOK, so it stays honest even if the
// `disabled` gate it waits on is ever removed.
const openExistingUniversePicker = async () => {
  const radio = await findEnabledByLabelText('Use an existing universe');
  fireEvent.click(radio);
  return screen.findByLabelText('Existing universe');
};

describe('StartStory onramp', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    toastError.mockReset();
    listUniverseNames.mockReset().mockResolvedValue([
      { id: 'u1', name: 'Alpha' },
      { id: 'u2', name: 'Beta' },
    ]);
  });

  it('renders all three intake modes', async () => {
    render(<StartStory />);
    expect(await screen.findByText('From an idea')).toBeTruthy();
    expect(screen.getByText('From an existing work')).toBeTruthy();
    expect(screen.getByText('From writing prose')).toBeTruthy();
  });

  it('routes to the engine with no universe param when starting fresh', async () => {
    render(<StartStory />);
    fireEvent.click(await screen.findByText('From an idea'));
    expect(navigateMock).toHaveBeenCalledWith('/story-builder');
  });

  it('forwards the chosen universe to engines that consume it', async () => {
    render(<StartStory />);
    // Opt into an existing universe, then select one.
    const select = await openExistingUniversePicker();
    fireEvent.change(select, { target: { value: 'u2' } });

    fireEvent.click(screen.getByText('From an idea'));
    expect(navigateMock).toHaveBeenCalledWith('/story-builder?universeId=u2');

    fireEvent.click(screen.getByText('From an existing work'));
    expect(navigateMock).toHaveBeenCalledWith('/importer?universeId=u2');
  });

  it('does not forward a universe to prose mode (no universe link yet)', async () => {
    render(<StartStory />);
    const select = await openExistingUniversePicker();
    fireEvent.change(select, { target: { value: 'u1' } });

    fireEvent.click(screen.getByText('From writing prose'));
    expect(navigateMock).toHaveBeenCalledWith('/writers-room');
  });

  it('blocks the cards until a universe is picked when using an existing one', async () => {
    render(<StartStory />);
    await openExistingUniversePicker();
    // No universe selected yet — clicking a card should not navigate.
    fireEvent.click(screen.getByText('From an idea'));
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Pick a universe above/)).toBeTruthy();
  });

  it('excludes untitled universes from the attach dropdown', async () => {
    // The Importer matches universes by name, so an untitled one can't be an
    // attach target — it must not appear as a selectable option.
    listUniverseNames.mockResolvedValueOnce([
      { id: 'u1', name: 'Alpha' },
      { id: 'u2', name: '' },
      { id: 'u3', name: '   ' },
    ]);
    render(<StartStory />);
    const select = await openExistingUniversePicker();
    // Only the placeholder + the one named universe.
    const options = select.querySelectorAll('option');
    expect(options.length).toBe(2);
    expect(options[1].value).toBe('u1');
  });

  it('surfaces a toast when the universe list fails to load', async () => {
    listUniverseNames.mockRejectedValueOnce(new Error('boom'));
    render(<StartStory />);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });
});
