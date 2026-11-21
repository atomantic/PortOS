import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation, useSearchParams } from 'react-router';

vi.mock('../services/apiTribe.js', () => ({
  getTribePeople: vi.fn(() => Promise.resolve({ people: [] })),
  getTribeOutreach: vi.fn(() => Promise.resolve({ threads: [] })),
  createTribeTouchpoint: vi.fn(),
  updateTribePerson: vi.fn(),
  deleteTribePerson: vi.fn(() => Promise.resolve({ success: true })),
  getTribeDuplicateIdentifiers: vi.fn(() => Promise.resolve({ emails: [], phones: [] })),
  getTribePerson: vi.fn(() => Promise.resolve({ identities: [] })),
  unlinkBeeperIdentity: vi.fn(() => Promise.resolve({ success: true })),
  getTribeMemoryLinks: vi.fn(() => Promise.resolve({ links: [] })),
  getTribeTouchpoints: vi.fn(() => Promise.resolve({ touchpoints: [] })),
}));
vi.mock('../services/apiMemory.js', () => ({
  getMemories: vi.fn(() => Promise.resolve({ memories: [] })),
}));

vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

import Tribe from './Tribe';
import {
  getTribePeople,
  createTribeTouchpoint,
  updateTribePerson,
  getTribeDuplicateIdentifiers,
  getTribePerson,
  unlinkBeeperIdentity,
  getTribeMemoryLinks,
  getTribeTouchpoints,
  getTribeOutreach,
  deleteTribePerson,
} from '../services/apiTribe.js';
import { getMemories } from '../services/apiMemory.js';
import socket from '../services/socket';

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
    getTribePeople.mockClear();
    getTribePeople.mockResolvedValue({ people: [] });
    // localStorage is used for the legacy-import path; keep it empty.
    window.localStorage.clear();
  });

  it('opens the tab named in the URL (?tab=focus)', async () => {
    renderAt('/tribe?tab=focus');
    // FocusPanel is the only tab that renders the "Energy Mix" panel.
    expect(await screen.findByText('Energy Mix')).toBeTruthy();
  });

  it('falls back to the default Care Queue tab for an unknown tab value', async () => {
    getTribePeople.mockResolvedValue({ people: PEOPLE });
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

describe('Tribe create actions', () => {
  beforeEach(() => {
    getTribePeople.mockClear();
    window.localStorage.clear();
  });

  it('starts a new relationship from the header Add only while the roster is empty', async () => {
    getTribePeople.mockResolvedValue({ people: [] });
    renderAt('/tribe?tab=circle');
    expect(await screen.findByText('No relationships yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Relationship' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'New Relationship' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New relationship' })).toBeNull();
  });

  it('offers the form plus action when editing an existing relationship', async () => {
    getTribePeople.mockResolvedValue({ people: PEOPLE });
    renderAt('/tribe?person=p2');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('tab=circle'));
    expect(screen.getByRole('heading', { name: 'Relationship' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New relationship' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
  });
});

describe('Tribe care filter', () => {
  beforeEach(() => {
    getTribePeople.mockClear();
    getTribePeople.mockResolvedValue({ people: PEOPLE });
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
    createTribeTouchpoint.mockResolvedValue({ id: 'touch-1' });

    renderAt('/tribe');
    await screen.findByText('Example Person');
    fireEvent.click(screen.getAllByRole('button', { name: 'Touch' })[0]);

    await waitFor(() => expect(createTribeTouchpoint).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ localDate: '2026-01-01' }),
      { silent: true },
    ));
    expect(await screen.findByText('Last 2026-01-01')).toBeTruthy();
  });

  it('keeps the page mounted while a tribe:changed reload is in flight', async () => {
    getTribePeople.mockResolvedValue({ people: PEOPLE });
    renderAt('/tribe');
    const card = await screen.findByText('Example Person');

    let release;
    getTribePeople.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const handler = socket.on.mock.calls.find(([event]) => event === 'tribe:changed')[1];
    act(() => { handler(); });

    // A reload must not swap the body for the spinner (that unmounted
    // OutreachQueue drafts and the sub-panels on every save).
    expect(screen.queryByText('Loading Tribe')).toBeNull();
    expect(card.isConnected).toBe(true);

    await act(async () => { release({ people: PEOPLE }); });
    expect(card.isConnected).toBe(true);
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
    getTribePeople.mockClear();
    getTribePeople.mockResolvedValue({ people: PEOPLE });
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

  it('omits lastContact from the update unless the user edited it (#15356)', async () => {
    updateTribePerson.mockResolvedValue({ ...PEOPLE[1] });
    renderAt('/tribe?person=p2');
    // Wait for the deep link to select the person; editing earlier hits the blank create form.
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Sample Neighbor'));
    const notes = screen.getByLabelText('Notes');
    fireEvent.change(notes, { target: { value: 'edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateTribePerson).toHaveBeenCalledTimes(1));
    expect(updateTribePerson.mock.calls[0][1]).not.toHaveProperty('lastContact');

    fireEvent.change(screen.getByLabelText('Last Contact'), { target: { value: '2020-01-02' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateTribePerson).toHaveBeenCalledTimes(2));
    expect(updateTribePerson.mock.calls[1][1]).toMatchObject({ lastContact: '2020-01-02' });
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
    getTribePeople.mockClear();
    getTribePeople.mockResolvedValue({ people: PEOPLE });
    getTribeDuplicateIdentifiers.mockReset();
    window.localStorage.clear();
  });

  it('renders nothing when the report comes back clean', async () => {
    getTribeDuplicateIdentifiers.mockResolvedValue({ emails: [], phones: [] });
    renderAt('/tribe');
    await screen.findByText('Example Person');
    expect(screen.queryByText(/shared contact info/i)).toBeNull();
  });

  it('names the colliding people for a shared email', async () => {
    getTribeDuplicateIdentifiers.mockResolvedValue({
      emails: [{ identifier: 'shared@example.com', people: [{ id: 'p1', name: 'Example Person' }, { id: 'p2', name: 'Sample Neighbor' }] }],
      phones: [],
    });
    renderAt('/tribe');

    expect(await screen.findByText(/shared contact info/i)).toBeTruthy();
    expect(screen.getByText('shared@example.com')).toBeTruthy();
    expect(screen.getByText(/Example Person and Sample Neighbor/)).toBeTruthy();
  });

  it('dismisses on click and does not reappear until the next fetch', async () => {
    getTribeDuplicateIdentifiers.mockResolvedValue({
      emails: [{ identifier: 'shared@example.com', people: [{ id: 'p1', name: 'Example Person' }, { id: 'p2', name: 'Sample Neighbor' }] }],
      phones: [],
    });
    renderAt('/tribe');
    await screen.findByText(/shared contact info/i);

    fireEvent.click(screen.getByRole('button', { name: /dismiss shared contact info/i }));
    expect(screen.queryByText(/shared contact info/i)).toBeNull();
    // Nothing after the dismiss awaits, and the sibling OutreachQueue's mount
    // fetch is still in flight: when it resolves between this line and cleanup,
    // its setState lands outside act() and setup.js fails the run. Observed once
    // in a full-suite pass while chasing #7448. Settling at the END is the idiom
    // setup.js prescribes for a test that has no later await to ride on.
    await act(async () => {});
  });
});

describe('Tribe "Linked on Beeper" block (#99)', () => {
  beforeEach(() => {
    getTribePeople.mockClear();
    getTribePeople.mockResolvedValue({ people: PEOPLE });
    getTribePerson.mockReset();
    getTribePerson.mockResolvedValue({ identities: [] });
    unlinkBeeperIdentity.mockReset();
    unlinkBeeperIdentity.mockResolvedValue({ success: true });
    window.localStorage.clear();
  });

  it('renders nothing when the selected person has no Beeper identities', async () => {
    renderAt('/tribe?tab=circle');
    fireEvent.click(await screen.findByText('Example Person'));
    await waitFor(() => expect(getTribePerson).toHaveBeenCalledWith('p1', { silent: true }));
    expect(screen.queryByText('Linked on Beeper')).toBeNull();
  });

  it('renders a chip per identity with its network + handle and a thread link', async () => {
    getTribePerson.mockResolvedValue({
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
    getTribePerson.mockResolvedValue({
      identities: [{
        id: 'identity-1', personId: 'p1', kind: 'handle', network: 'discord', handle: 'ada',
        source: 'user', linkedAt: '2026-06-01T00:00:00.000Z', conversations: [],
      }],
    });

    renderAt('/tribe?tab=circle');
    fireEvent.click(await screen.findByText('Example Person'));
    await screen.findByText('Linked on Beeper');

    fireEvent.click(screen.getByRole('button', { name: 'Unlink ada' }));

    await waitFor(() => expect(unlinkBeeperIdentity).toHaveBeenCalledWith('identity-1', { silent: true }));
    await waitFor(() => expect(screen.queryByText('Linked on Beeper')).toBeNull());
  });
});

describe('Tribe memory links panel — failed reads', () => {
  beforeEach(() => {
    getTribePeople.mockResolvedValue({ people: PEOPLE });
    window.localStorage.clear();
  });
  afterEach(() => {
    getTribeMemoryLinks.mockResolvedValue({ links: [] });
    getMemories.mockResolvedValue({ memories: [] });
  });

  it('shows an error with Retry instead of "No memories linked yet" when the link read fails', async () => {
    getTribeMemoryLinks.mockRejectedValueOnce(new Error('links down'));
    getMemories.mockRejectedValueOnce(new Error('memories down'));

    renderAt('/tribe?tab=circle');
    fireEvent.click(await screen.findByText('Example Person'));

    expect(await screen.findByText(/Could not load linked memories — links down/)).toBeTruthy();
    expect(screen.getByText(/Could not load recent memories — memories down/)).toBeTruthy();
    expect(screen.queryByText('No memories linked yet.')).toBeNull();

    getTribeMemoryLinks.mockResolvedValueOnce({ links: [] });
    getMemories.mockResolvedValueOnce({ memories: [] });
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);
    expect(await screen.findByText('No memories linked yet.')).toBeTruthy();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });
});

describe('Tribe person panels and outreach — failed reads', () => {
  beforeEach(() => {
    getTribePeople.mockResolvedValue({ people: PEOPLE });
    window.localStorage.clear();
  });
  afterEach(() => {
    getTribeTouchpoints.mockResolvedValue({ touchpoints: [] });
    getTribePerson.mockResolvedValue({ identities: [] });
    getTribeOutreach.mockResolvedValue({ threads: [] });
  });

  it('shows an error with Retry instead of "No touchpoints logged yet" when the touchpoint read fails', async () => {
    getTribeTouchpoints.mockRejectedValueOnce(new Error('touchpoints down'));

    renderAt('/tribe?tab=circle');
    fireEvent.click(await screen.findByText('Example Person'));

    expect(await screen.findByText(/Could not load touchpoints — touchpoints down/)).toBeTruthy();
    expect(screen.queryByText('No touchpoints logged yet.')).toBeNull();

    getTribeTouchpoints.mockResolvedValueOnce({ touchpoints: [{ id: 't1', happenedAt: '2026-01-02T00:00:00.000Z', source: 'user', summary: 'Coffee catch-up' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Coffee catch-up')).toBeTruthy();
    expect(screen.queryByText(/Could not load touchpoints/)).toBeNull();
  });

  it('shows an error with Retry instead of hiding the Beeper block when the identity read fails', async () => {
    getTribePerson.mockRejectedValueOnce(new Error('person down'));

    renderAt('/tribe?tab=circle');
    fireEvent.click(await screen.findByText('Example Person'));

    expect(await screen.findByText(/Could not load Beeper links — person down/)).toBeTruthy();
    expect(screen.queryByText('Linked on Beeper')).toBeNull();

    getTribePerson.mockResolvedValueOnce({
      identities: [{ id: 'identity-1', personId: 'p1', kind: 'handle', network: 'discord', handle: 'ada', source: 'user', conversations: [] }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Linked on Beeper')).toBeTruthy();
    expect(screen.queryByText(/Could not load Beeper links/)).toBeNull();
  });

  it('shows an error with Retry instead of hiding the reply queue when the outreach read fails', async () => {
    getTribeOutreach.mockRejectedValueOnce(new Error('outreach down'));

    renderAt('/tribe');

    expect(await screen.findByText(/Could not load threads waiting on a reply — outreach down/)).toBeTruthy();
    expect(screen.queryByText('Waiting on a reply')).toBeNull();

    getTribeOutreach.mockResolvedValueOnce({
      threads: [{
        conversationKey: 'conv-1', personId: 'p1', personName: 'Example Person', source: 'imessage',
        daysAgo: 3, snippet: 'Are we still on for Friday?',
      }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Waiting on a reply')).toBeTruthy();
    expect(screen.queryByText(/Could not load threads/)).toBeNull();
  });
});

describe('Tribe URL-backed selection, delete confirmation, and form labels', () => {
  beforeEach(() => {
    getTribePeople.mockClear();
    getTribePeople.mockResolvedValue({ people: PEOPLE });
    deleteTribePerson.mockClear();
    deleteTribePerson.mockResolvedValue({ success: true });
    window.localStorage.clear();
  });

  it('updates ?person=<id> when clicking a person card and clears it on New relationship', async () => {
    renderAt('/tribe?tab=circle');
    fireEvent.click(await screen.findByText('Example Person'));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/tribe?tab=circle&person=p1')
    );

    fireEvent.click(screen.getByRole('button', { name: 'New relationship' }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/tribe?tab=circle')
    );
    expect(screen.getByLabelText('Name')).toHaveValue('');
  });

  it('requires inline confirmation before deleting a person and clears ?person= on confirm', async () => {
    renderAt('/tribe?person=p1');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('tab=circle'));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Example Person'));

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleteTribePerson).not.toHaveBeenCalled();
    expect(screen.getByText('Delete?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel delete relationship' }));
    expect(deleteTribePerson).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete relationship' }));
    await waitFor(() => expect(deleteTribePerson).toHaveBeenCalledWith('p1', { silent: true }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/tribe?tab=circle')
    );
    expect(screen.queryByText('Example Person')).toBeNull();
    await act(async () => {});
  });

  it('pairs htmlFor with id for all 12 ContactForm fields', async () => {
    renderAt('/tribe?tab=circle');
    await screen.findByLabelText('Name');

    const labels = [
      'Name',
      'Relationship',
      'Ring',
      'Cadence',
      'Last Contact',
      'Energy',
      'Channel',
      'Tags',
      'Emails & handles',
      'Phone numbers',
      'Next Move',
      'Notes',
    ];
    for (const labelText of labels) {
      const control = screen.getByLabelText(labelText);
      expect(control.id).toBeTruthy();
      const labelEl = document.querySelector(`label[for="${control.id}"]`);
      expect(labelEl).not.toBeNull();
    }
  });
});
