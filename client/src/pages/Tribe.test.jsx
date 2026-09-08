import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation, useSearchParams } from 'react-router';

vi.mock('../services/api', () => ({
  getTribePeople: vi.fn(() => Promise.resolve({ people: [] })),
  // OutreachQueue (care tab) fetches unanswered threads on mount (#2158).
  getTribeOutreach: vi.fn(() => Promise.resolve({ threads: [] })),
  createTribeTouchpoint: vi.fn(),
  // Non-blocking duplicate-identifier report (#5908); defaults to clean so
  // tests unrelated to it never see the banner.
  getTribeDuplicateIdentifiers: vi.fn(() => Promise.resolve({ emails: [], phones: [] })),
  // Single-person read (#99) — the "Linked on Beeper" block's data source;
  // defaults to no identities so tests unrelated to it never see the block.
  getTribePerson: vi.fn(() => Promise.resolve({ identities: [] })),
  unlinkBeeperIdentity: vi.fn(() => Promise.resolve({ success: true })),
  // Circle tab's aside mounts MemoryLinksPanel/TouchpointsPanel once a
  // person is selected (`draft.id` set) — the `?person=` deep-link tests and
  // the "Linked on Beeper" tests below both select a real person, so these
  // need real (empty) defaults too.
  getTribeMemoryLinks: vi.fn(() => Promise.resolve({ links: [] })),
  getMemories: vi.fn(() => Promise.resolve({ memories: [] })),
  getTribeTouchpoints: vi.fn(() => Promise.resolve({ touchpoints: [] })),
}));

vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

import Tribe from './Tribe';
import * as api from '../services/api';

afterEach(() => {
  vi.useRealTimers();
});

// Surfaces the current URL (path + search) so tests can assert deep-link state.
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

const renderAt = (entry) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Tribe />
      <LocationProbe />
    </MemoryRouter>
  );

const isoDaysAgo = (days) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
};

// Obviously-fake people covering each cadence state.
const PEOPLE = [
  { id: 'p1', name: 'Example Person', ring: 'tribe', cadenceDays: 45, lastContact: isoDaysAgo(200) }, // overdue
  { id: 'p2', name: 'Sample Neighbor', ring: 'core', cadenceDays: 21, lastContact: isoDaysAgo(18) }, // soon (3d left)
  { id: 'p3', name: 'Placeholder Pal', ring: 'tribe', cadenceDays: 45, lastContact: isoDaysAgo(1) }, // steady
];

describe('Tribe deep-linkable tabs', () => {
  beforeEach(() => {
    api.getTribePeople.mockClear();
    api.getTribePeople.mockResolvedValue({ people: [] });
    // localStorage is used for the legacy-import path; keep it empty.
    window.localStorage.clear();
  });

  it('opens the tab named in the URL (?tab=focus)', async () => {
    renderAt('/tribe?tab=focus');
    // FocusPanel is the only tab that renders the "Energy Mix" panel.
    expect(await screen.findByText('Energy Mix')).toBeTruthy();
  });

  it('falls back to the default Care Queue tab for an unknown tab value', async () => {
    api.getTribePeople.mockResolvedValue({ people: PEOPLE });
    renderAt('/tribe?tab=bogus');
    // The Care Queue leads with the care filter bar and Touch buttons; the
    // Circle tab's search field is not on the first screen.
    expect(await screen.findByRole('group', { name: 'Care filter' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Touch/ }).length).toBeGreaterThan(0);
    expect(screen.queryByPlaceholderText('Search relationships')).toBeNull();
  });

  it('writes the active tab to the URL when a tab is selected', async () => {
    renderAt('/tribe');
    await screen.findByRole('tab', { name: /Focus/i });
    fireEvent.click(screen.getByRole('tab', { name: /Focus/i }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/tribe?tab=focus')
    );
  });

  it('omits the default tab from the URL when returning to the Care Queue', async () => {
    renderAt('/tribe?tab=focus');
    await screen.findByText('Energy Mix');
    fireEvent.click(screen.getByRole('tab', { name: /Care Queue/i }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/tribe')
    );
  });

  it('preserves a non-default tab when the Add action fires a functional update', async () => {
    // "Add" calls startNewRelationship, which uses a functional setActiveTab
    // updater that keeps the current tab unless it is focus/map. On Circle it must
    // resolve against the fresh URL and stay on circle — not fall back to care.
    renderAt('/tribe?tab=circle');
    await screen.findByRole('button', { name: 'Add' });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/tribe?tab=circle')
    );
  });
});

describe('Tribe care filter', () => {
  beforeEach(() => {
    api.getTribePeople.mockClear();
    api.getTribePeople.mockResolvedValue({ people: PEOPLE });
    window.localStorage.clear();
  });

  it('filters the care queue to overdue people when the Needs Care tile is clicked', async () => {
    renderAt('/tribe');
    await screen.findByText('Example Person');
    fireEvent.click(screen.getByRole('button', { name: /^Needs Care \d/ }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/tribe?status=overdue')
    );
    expect(screen.getByText('Example Person')).toBeTruthy();
    expect(screen.queryByText('Placeholder Pal')).toBeNull();
    expect(screen.queryByText('Sample Neighbor')).toBeNull();
  });

  it('clears the filter when the active tile is clicked again', async () => {
    renderAt('/tribe?status=overdue');
    await screen.findByText('Example Person');
    fireEvent.click(screen.getByRole('button', { name: /^Needs Care \d/ }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/tribe')
    );
    expect(await screen.findByText('Placeholder Pal')).toBeTruthy();
  });

  it('routes the Coming Up tile into the care tab from another tab', async () => {
    renderAt('/tribe?tab=circle');
    await screen.findByPlaceholderText('Search relationships');
    fireEvent.click(screen.getByRole('button', { name: /^Coming Up \d/ }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/tribe?status=soon')
    );
    expect(await screen.findByText('Sample Neighbor')).toBeTruthy();
    expect(screen.queryByText('Example Person')).toBeNull();
  });

  it('applies a deep-linked status filter to the Circle roster', async () => {
    renderAt('/tribe?tab=circle&status=overdue');
    expect(await screen.findByText('Example Person')).toBeTruthy();
    expect(screen.queryByText('Placeholder Pal')).toBeNull();
  });

  it('records a manual touch on the local calendar date', async () => {
    vi.setSystemTime(new Date(2026, 0, 1, 20));
    api.createTribeTouchpoint.mockResolvedValue({ id: 'touch-1' });

    renderAt('/tribe');
    await screen.findByText('Example Person');
    fireEvent.click(screen.getAllByRole('button', { name: 'Touch' })[0]);

    await waitFor(() => expect(api.createTribeTouchpoint).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ localDate: '2026-01-01' }),
      { silent: true },
    ));
    expect(await screen.findByText('Last 2026-01-01')).toBeTruthy();
  });
});

/**
 * #98 part C: Beeper's Tribe chip and its participants-panel "Linked ·
 * <name>" rows deep-link here via `?person=<id>`. On load (and whenever the
 * param changes) the page takes the exact path a click on the person's own
 * `ContactCard` takes (`selectContact`) — switch to Circle, populate the
 * form — and scrolls that card into view. An id nothing recognizes (a
 * deleted person, or someone else's stale bookmark) is silently ignored:
 * PortOS never toasts an error for it.
 */
describe('Tribe person deep link (#98 part C)', () => {
  beforeEach(() => {
    api.getTribePeople.mockClear();
    api.getTribePeople.mockResolvedValue({ people: PEOPLE });
    window.localStorage.clear();
  });

  it('selects the named person, switches to Circle, and opens the form on their record', async () => {
    renderAt('/tribe?person=p2');

    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('tab=circle'));
    expect(screen.getByLabelText('Name')).toHaveValue('Sample Neighbor');
    // Circle-only content — proves the tab actually switched, not just the draft.
    expect(screen.getByPlaceholderText('Search relationships')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Relationship' })).toBeInTheDocument();
  });

  it('scrolls the matching card into view', async () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    renderAt('/tribe?person=p2');

    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    scrollSpy.mockRestore();
  });

  it('re-applies when the person param changes to a different id, without remounting the page', async () => {
    // `MemoryRouter`'s `initialEntries` is read once at construction, so
    // exercising a real in-place param change needs an in-tree navigator
    // rather than a fresh `render`/`rerender` with different entries.
    function ChangePersonButton() {
      const [, setPersonParams] = useSearchParams();
      return (
        <button type="button" onClick={() => setPersonParams({ person: 'p2' })}>
          Switch to p2
        </button>
      );
    }
    render(
      <MemoryRouter initialEntries={['/tribe?person=p1']}>
        <Tribe />
        <ChangePersonButton />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Example Person'));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to p2' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Sample Neighbor'));
  });

  it('ignores an id the roster does not recognize, with no error toast and no tab switch', async () => {
    renderAt('/tribe?person=does-not-exist');

    await screen.findByRole('group', { name: 'Care filter' }); // stayed on the default Care Queue tab
    expect(screen.queryByPlaceholderText('Search relationships')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Tribe shared-identifier banner (#5908)', () => {
  beforeEach(() => {
    api.getTribePeople.mockClear();
    api.getTribePeople.mockResolvedValue({ people: PEOPLE });
    api.getTribeDuplicateIdentifiers.mockReset();
    window.localStorage.clear();
  });

  it('renders nothing when the report comes back clean', async () => {
    api.getTribeDuplicateIdentifiers.mockResolvedValue({ emails: [], phones: [] });
    renderAt('/tribe');
    await screen.findByText('Example Person');
    expect(screen.queryByText(/shared contact info/i)).toBeNull();
  });

  it('names the colliding people for a shared email', async () => {
    api.getTribeDuplicateIdentifiers.mockResolvedValue({
      emails: [{ identifier: 'shared@example.com', people: [{ id: 'p1', name: 'Example Person' }, { id: 'p2', name: 'Sample Neighbor' }] }],
      phones: [],
    });
    renderAt('/tribe');

    expect(await screen.findByText(/shared contact info/i)).toBeTruthy();
    expect(screen.getByText('shared@example.com')).toBeTruthy();
    expect(screen.getByText(/Example Person and Sample Neighbor/)).toBeTruthy();
  });

  it('dismisses on click and does not reappear until the next fetch', async () => {
    api.getTribeDuplicateIdentifiers.mockResolvedValue({
      emails: [{ identifier: 'shared@example.com', people: [{ id: 'p1', name: 'Example Person' }, { id: 'p2', name: 'Sample Neighbor' }] }],
      phones: [],
    });
    renderAt('/tribe');
    await screen.findByText(/shared contact info/i);

    fireEvent.click(screen.getByRole('button', { name: /dismiss shared contact info/i }));
    expect(screen.queryByText(/shared contact info/i)).toBeNull();
  });
});

describe('Tribe "Linked on Beeper" block (#99)', () => {
  beforeEach(() => {
    api.getTribePeople.mockClear();
    api.getTribePeople.mockResolvedValue({ people: PEOPLE });
    api.getTribePerson.mockReset();
    api.getTribePerson.mockResolvedValue({ identities: [] });
    api.unlinkBeeperIdentity.mockReset();
    api.unlinkBeeperIdentity.mockResolvedValue({ success: true });
    window.localStorage.clear();
  });

  it('renders nothing when the selected person has no Beeper identities', async () => {
    renderAt('/tribe?tab=circle');
    fireEvent.click(await screen.findByText('Example Person'));
    await waitFor(() => expect(api.getTribePerson).toHaveBeenCalledWith('p1', { silent: true }));
    expect(screen.queryByText('Linked on Beeper')).toBeNull();
  });

  it('renders a chip per identity with its network + handle and a thread link', async () => {
    api.getTribePerson.mockResolvedValue({
      identities: [
        {
          id: 'identity-1', personId: 'p1', kind: 'beeper-user', network: 'account-1', handle: 'user-1',
          source: 'user', linkedAt: '2026-06-01T00:00:00.000Z',
          conversations: [{ conversationId: 'conv-1', network: 'whatsapp', title: 'Example Thread', accountId: 'account-1', displayName: 'Example Contact' }],
        },
        {
          id: 'identity-2', personId: 'p1', kind: 'handle', network: 'discord', handle: 'ada',
          source: 'user', linkedAt: '2026-06-01T00:00:00.000Z', conversations: [],
        },
      ],
    });

    renderAt('/tribe?tab=circle');
    fireEvent.click(await screen.findByText('Example Person'));

    expect(await screen.findByText('Linked on Beeper')).toBeTruthy();
    expect(screen.getByText('whatsapp')).toBeTruthy();
    expect(screen.getByText('Example Contact')).toBeTruthy();
    expect(screen.getByText('discord')).toBeTruthy();
    expect(screen.getByText('ada')).toBeTruthy();
    const threadLink = screen.getByRole('link', { name: /Open "Example Thread"/ });
    expect(threadLink.getAttribute('href')).toBe('/messages/beeper/conv-1');
  });

  it('unlinks an identity and removes its chip', async () => {
    api.getTribePerson.mockResolvedValue({
      identities: [{
        id: 'identity-1', personId: 'p1', kind: 'handle', network: 'discord', handle: 'ada',
        source: 'user', linkedAt: '2026-06-01T00:00:00.000Z', conversations: [],
      }],
    });

    renderAt('/tribe?tab=circle');
    fireEvent.click(await screen.findByText('Example Person'));
    await screen.findByText('Linked on Beeper');

    fireEvent.click(screen.getByRole('button', { name: 'Unlink ada' }));

    await waitFor(() => expect(api.unlinkBeeperIdentity).toHaveBeenCalledWith('identity-1', { silent: true }));
    await waitFor(() => expect(screen.queryByText('Linked on Beeper')).toBeNull());
  });
});
