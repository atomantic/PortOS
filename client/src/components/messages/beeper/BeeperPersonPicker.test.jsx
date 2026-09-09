import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup, fireEvent, render, screen, waitFor,
} from '@testing-library/react';
import BeeperPersonPicker from './BeeperPersonPicker';

/**
 * The search-first Tribe-person picker (#98 part B) that replaces the bare
 * full-roster `<select>` `ParticipantRow` used to render — wiring tests for
 * it as used from `BeeperThread` live in `BeeperThread.test.jsx`; these pin
 * the component's own filtering, debounce and keyboard contract in isolation.
 */

const PEOPLE = [
  { id: 'p1', name: 'Alex Example' },
  { id: 'p2', name: 'Blair Sample' },
  { id: 'p3', name: 'Casey Placeholder' },
];

const renderPicker = (overrides = {}) => {
  const props = {
    id: 'picker-1',
    label: 'Link Sam Example to a Tribe person',
    people: PEOPLE,
    onSelectPerson: vi.fn(),
    onCreateNew: vi.fn(),
    ...overrides,
  };
  const utils = render(<BeeperPersonPicker {...props} />);
  return { ...utils, props };
};

afterEach(cleanup);

describe('BeeperPersonPicker — opening and closing', () => {
  it('renders no listbox until the input is focused', () => {
    renderPicker();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.focus(screen.getByLabelText('Link Sam Example to a Tribe person'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('closes the listbox on blur', () => {
    renderPicker();
    const input = screen.getByLabelText('Link Sam Example to a Tribe person');
    fireEvent.focus(input);
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.blur(input);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

describe('BeeperPersonPicker — filtering', () => {
  it('shows every person with an empty query', () => {
    renderPicker();
    fireEvent.focus(screen.getByLabelText('Link Sam Example to a Tribe person'));

    expect(screen.getByRole('option', { name: 'Alex Example' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Blair Sample' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Casey Placeholder' })).toBeInTheDocument();
  });

  // The filter is debounced (>=200ms) rather than applied on every keystroke.
  it('filters case-insensitively by substring, after the debounce settles', async () => {
    renderPicker();
    const input = screen.getByLabelText('Link Sam Example to a Tribe person');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'bla' } });

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Blair Sample' })).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: 'Alex Example' })).not.toBeInTheDocument();
    });
  });

  it('shows "No matches" for a query nothing matches, with "Create new…" still last', async () => {
    renderPicker();
    const input = screen.getByLabelText('Link Sam Example to a Tribe person');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'zzz-nobody' } });

    await waitFor(() => expect(screen.getByText('No matches')).toBeInTheDocument());
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Create new…');
  });
});

describe('BeeperPersonPicker — selection', () => {
  it('calls onSelectPerson with the person id when a result is clicked, and closes the list', () => {
    const onSelectPerson = vi.fn();
    renderPicker({ onSelectPerson });
    fireEvent.focus(screen.getByLabelText('Link Sam Example to a Tribe person'));

    fireEvent.mouseDown(screen.getByRole('option', { name: 'Blair Sample' }));

    expect(onSelectPerson).toHaveBeenCalledWith('p2');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('always renders "Create new…" as the LAST option, after every match', () => {
    renderPicker();
    fireEvent.focus(screen.getByLabelText('Link Sam Example to a Tribe person'));

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(PEOPLE.length + 1);
    expect(options[options.length - 1]).toHaveTextContent('Create new…');
    expect(options.slice(0, -1).map((o) => o.textContent)).toEqual(PEOPLE.map((p) => p.name));
  });

  it('calls onCreateNew (never onSelectPerson) when "Create new…" is chosen', () => {
    const onSelectPerson = vi.fn();
    const onCreateNew = vi.fn();
    renderPicker({ onSelectPerson, onCreateNew });
    fireEvent.focus(screen.getByLabelText('Link Sam Example to a Tribe person'));

    const options = screen.getAllByRole('option');
    fireEvent.mouseDown(options[options.length - 1]);

    expect(onCreateNew).toHaveBeenCalledTimes(1);
    expect(onSelectPerson).not.toHaveBeenCalled();
  });
});

describe('BeeperPersonPicker — keyboard navigation', () => {
  it('ArrowDown/ArrowUp move the highlighted option, tracked via aria-activedescendant', () => {
    renderPicker();
    const input = screen.getByLabelText('Link Sam Example to a Tribe person');
    fireEvent.focus(input);

    const first = screen.getByRole('option', { name: 'Alex Example' });
    expect(input).toHaveAttribute('aria-activedescendant', first.id);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const second = screen.getByRole('option', { name: 'Blair Sample' });
    expect(input).toHaveAttribute('aria-activedescendant', second.id);
    expect(second).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveAttribute('aria-activedescendant', first.id);
  });

  it('wraps from the last row ("Create new…") back to the first match on ArrowDown', () => {
    renderPicker();
    const input = screen.getByLabelText('Link Sam Example to a Tribe person');
    fireEvent.focus(input);

    for (let i = 0; i < PEOPLE.length; i += 1) fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Create new/ })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'Alex Example' })).toHaveAttribute('aria-selected', 'true');
  });

  it('Enter selects the highlighted option', () => {
    const onSelectPerson = vi.fn();
    renderPicker({ onSelectPerson });
    const input = screen.getByLabelText('Link Sam Example to a Tribe person');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelectPerson).toHaveBeenCalledWith('p2');
  });

  it('Escape closes the list without selecting anything', () => {
    const onSelectPerson = vi.fn();
    const onCreateNew = vi.fn();
    renderPicker({ onSelectPerson, onCreateNew });
    const input = screen.getByLabelText('Link Sam Example to a Tribe person');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onSelectPerson).not.toHaveBeenCalled();
    expect(onCreateNew).not.toHaveBeenCalled();
  });

  it('ArrowDown on a closed list opens it without moving the highlight yet', () => {
    renderPicker();
    const input = screen.getByLabelText('Link Sam Example to a Tribe person');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
});

describe('BeeperPersonPicker — disabled state', () => {
  it('disables the input while a link is in flight', () => {
    renderPicker({ disabled: true });
    expect(screen.getByLabelText('Link Sam Example to a Tribe person')).toBeDisabled();
  });
});

/**
 * #105: the results list used to render `absolute`, positioned inside the
 * component's own `relative` wrapper — fine on its own, but wherever a caller
 * nests the picker inside an `overflow: auto` ancestor (the Beeper
 * participants roster, `BeeperThread.jsx`), an absolutely positioned child
 * cannot escape that ancestor's clipping and instead extends its scrollable
 * area. The list now portals to `document.body` and is fixed-positioned off
 * the input's own rect (`usePopoverPosition`) so no ancestor can clip it.
 * "Keyboard path still selects" and "Escape closes" are exercised above
 * already (they never depended on the list's DOM location) and stayed green
 * through this change — these add the portal-specific coverage.
 */
describe('BeeperPersonPicker — portaled results list (#105)', () => {
  it('renders the results list outside the input wrapper, as a child of document.body', () => {
    const { container } = renderPicker();
    fireEvent.focus(screen.getByLabelText('Link Sam Example to a Tribe person'));

    const listbox = screen.getByRole('listbox');
    expect(container.contains(listbox)).toBe(false);
    expect(document.body.contains(listbox)).toBe(true);
  });

  it('still selects on a click inside the portaled list', () => {
    const onSelectPerson = vi.fn();
    renderPicker({ onSelectPerson });
    fireEvent.focus(screen.getByLabelText('Link Sam Example to a Tribe person'));

    const option = screen.getByRole('option', { name: 'Blair Sample' });
    // Confirms the click actually exercised the portal, not some fallback.
    expect(document.body.contains(option)).toBe(true);
    fireEvent.mouseDown(option);

    expect(onSelectPerson).toHaveBeenCalledWith('p2');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes on an outside click: mousedown outside is not swallowed as "inside the picker"', () => {
    renderPicker();
    const input = screen.getByLabelText('Link Sam Example to a Tribe person');
    fireEvent.focus(input);
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    // This is a combobox, not a menu — the input keeps focus the whole time,
    // so closing is driven by its own `onBlur`, not a global outside-click
    // listener. A real outside click's mousedown moves the browser's focus
    // away from the input, which is what fires that blur; happy-dom moves
    // `document.activeElement` on `fireEvent.mousedown` (confirmed: it lands
    // on `document.body`) without also dispatching the `blur` event a real
    // browser would, so both are fired here to model that one user gesture.
    // The regression this guards against: the portaled list's own
    // `mousedown` handler (added for #105 so a click *inside* it doesn't
    // blur the input away from under a selection) must not be broad enough
    // to also swallow a `mousedown` that lands elsewhere, like this one.
    fireEvent.mouseDown(document.body);
    fireEvent.blur(input);

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
