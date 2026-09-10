import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
  act, cleanup, fireEvent, render, screen, waitFor, within,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

/**
 * The Beeper chat surface (#35), tested at the page boundary — the same seam a
 * user reaches it through, so the rail, the list, the thread, the URL contract
 * and the realtime wiring are exercised together rather than one prop at a time.
 *
 * EVERY fixture value below is invented: placeholder names, `example.com`
 * handles and 555-01xx numbers per root AGENTS.md Sensitive Data & Privacy. The
 * last test in this file is a guard that keeps it that way — no value from a
 * running instance may ever be pasted in here.
 */

const api = vi.hoisted(() => ({
  getBeeperStatus: vi.fn(),
  syncBeeperNow: vi.fn(),
  getBeeperNetworks: vi.fn(),
  getBeeperConversations: vi.fn(),
  getBeeperConversation: vi.fn(),
  getBeeperMessages: vi.fn(),
  setBeeperConversationArchived: vi.fn(),
  setBeeperConversationLowPriority: vi.fn(),
  // The LOCAL "seen in PortOS" watermark (#83) — never a Beeper write.
  markBeeperConversationSeen: vi.fn(),
  linkBeeperParticipant: vi.fn(),
  createTribePersonFromBeeper: vi.fn(),
  unlinkBeeperParticipant: vi.fn(),
  getTribePeople: vi.fn(),
  // Reached through the settings drawer. Declared here because
  // `BeeperSettingsPanel` imports them at module load, whether or not a test
  // opens the drawer — a named import missing from the mock throws.
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  checkBeeperConnection: vi.fn(),
  startBeeperOAuth: vi.fn(),
  saveBeeperToken: vi.fn(),
  disconnectBeeper: vi.fn(),
  // Attachment byte mirror (#37). `beeperAttachmentUrl` is called during
  // render, so it must return a string rather than a mock's `undefined`.
  beeperAttachmentUrl: vi.fn((messageId, idx) => `/api/beeper/attachments/${messageId}/${idx}`),
  fetchBeeperAttachment: vi.fn(),
  setBeeperAttachmentKeep: vi.fn(),
  getBeeperAttachmentSummary: vi.fn(),
  backfillBeeperAttachments: vi.fn(),
  purgeBeeperConversation: vi.fn(),
}));
// The composer's send lifecycle (#36) reaches the server through
// `apiBeeper.js` directly — a DIFFERENT module specifier than the `api.js`
// barrel every other call in this file goes through — so `useBeeperOutbox`
// needs its own mock rather than riding along on `api` above.
const apiBeeper = vi.hoisted(() => ({
  listOutboxEntries: vi.fn(),
  createOutboxEntry: vi.fn(),
  sendOutboxEntry: vi.fn(),
  discardOutboxEntry: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
const socketMock = vi.hoisted(() => {
  const handlers = new Map();
  const emitted = [];
  return {
    handlers,
    emitted,
    socket: {
      on: (event, fn) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event).add(fn);
      },
      off: (event, fn) => { handlers.get(event)?.delete(fn); },
      emit: (event, payload) => { emitted.push([event, payload]); },
    },
  };
});

vi.mock('../../services/api', () => api);
vi.mock('../../services/apiBeeper', () => apiBeeper);
vi.mock('../ui/Toast', () => ({ default: toast }));
vi.mock('../../services/socket', () => ({ default: socketMock.socket }));

const BeeperTab = (await import('./BeeperTab')).default;

const CONV_A = '11111111-1111-4111-8111-111111111111';
const CONV_B = '22222222-2222-4222-8222-222222222222';

// Nine networks, matching the outlier install #9 warns the design must not be
// tuned for. Ids only — the surface renders whatever the mirror reports.
const NINE_NETWORKS = [
  'whatsapp', 'telegram', 'discord', 'signal', 'instagram', 'slack', 'x', 'facebook', 'googlemessages',
].map((network, index) => ({ network, conversationCount: 1, unreadCount: index, unreadConversations: 1, accountIds: [`acct-example-${index}`], lastActivity: '2026-09-01T10:00:00.000Z' }));

const conversation = (overrides = {}) => ({
  id: CONV_A,
  accountId: 'acct-example-0',
  network: 'examplenet',
  sourceChatId: 'chat-example-1',
  title: 'Example Conversation',
  type: 'single',
  isGroup: false,
  isPinned: false,
  isArchived: false,
  isLowPriority: false,
  isMuted: false,
  lastActivity: '2026-09-01T10:00:00.000Z',
  unreadCount: 0,
  lastMessage: null,
  participants: [],
  hasMoreParticipants: false,
  ...overrides,
});

const renderTab = (initialPath = '/messages/beeper') => render(
  <MemoryRouter initialEntries={[initialPath]}>
    <Routes>
      <Route path="/messages/:tab" element={<BeeperTab />} />
      <Route path="/messages/:tab/:chatKey" element={<BeeperTab />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  socketMock.handlers.clear();
  socketMock.emitted.length = 0;
  api.getBeeperStatus.mockResolvedValue({ tokenConfigured: true, reachable: true, accounts: [], realtime: { state: 'connected' } });
  api.syncBeeperNow.mockResolvedValue({ skipped: false, accounts: 0, chats: 0, messages: 0 });
  api.getBeeperNetworks.mockResolvedValue({ networks: [] });
  api.getBeeperConversations.mockResolvedValue({ conversations: [], nextCursor: null });
  api.getBeeperConversation.mockResolvedValue(conversation());
  api.getBeeperMessages.mockResolvedValue({ messages: [], nextCursor: null });
  api.markBeeperConversationSeen.mockResolvedValue(conversation());
  api.getTribePeople.mockResolvedValue([]);
  apiBeeper.listOutboxEntries.mockResolvedValue({ entries: [] });
  apiBeeper.discardOutboxEntry.mockResolvedValue(undefined);
  api.getSettings.mockResolvedValue({ beeper: { enabled: false, intervalMinutes: 5, baseUrl: 'http://127.0.0.1:23373', attachmentBudgetGb: 5 } });
  api.getBeeperAttachmentSummary.mockResolvedValue({
    budgetBytes: 5 * 1024 * 1024 * 1024, usedBytes: 0, storedFiles: 0, pendingCount: 0, pendingBytes: 0,
    pendingUnknownCount: 0, overCapCount: 0, unavailableCount: 0, keptCount: 0, totalCount: 0, maxBytes: 32 * 1024 * 1024,
  });
});

afterEach(cleanup);

describe('deep linking', () => {
  it('opens the conversation directly on a cold load of its URL', async () => {
    api.getBeeperNetworks.mockResolvedValue({ networks: [NINE_NETWORKS[0]] });
    api.getBeeperConversations.mockResolvedValue({ conversations: [conversation()], nextCursor: null });
    api.getBeeperConversation.mockResolvedValue(conversation({ title: 'Example Deep Link' }));
    api.getBeeperMessages.mockResolvedValue({
      messages: [{ id: 'm1', conversationId: CONV_A, senderId: 'user-1', body: 'Placeholder message body', sentAt: '2026-09-01T10:00:00.000Z', attachments: [] }],
      nextCursor: null,
    });

    renderTab(`/messages/beeper/${CONV_A}`);

    expect(await screen.findByText('Placeholder message body')).toBeInTheDocument();
    expect(api.getBeeperConversation).toHaveBeenCalledWith(CONV_A, { silent: true });
    // The list is fetched for the same scope, so the surface is whole rather
    // than a bare thread with no way back.
    expect(api.getBeeperConversations).toHaveBeenCalled();
  });

  it('renders a not-found state for a stale conversation id instead of an empty thread', async () => {
    api.getBeeperConversation.mockRejectedValue(Object.assign(new Error('Conversation not found'), { status: 404 }));
    renderTab(`/messages/beeper/${CONV_B}`);
    expect(await screen.findByText('Conversation not found')).toBeInTheDocument();
  });

  // The regression the reviewer found: an `apiCore` failure with no `.status`
  // (503 unreachable, 500, offline) leaves the detail null and the error set,
  // and the thread's "Pick a conversation" early return used to sit AHEAD of
  // the error branch — so a URL that names a conversation rendered as if
  // nothing were selected. Every fetch behind it is `{ silent: true }`, so
  // there was no toast either: the failure was completely invisible.
  it('renders the thread error with a Retry when a deep link fails, never "Pick a conversation"', async () => {
    api.getBeeperConversation.mockRejectedValue(new Error('Beeper request failed: connection refused'));
    api.getBeeperMessages.mockRejectedValue(new Error('Beeper request failed: connection refused'));
    renderTab(`/messages/beeper/${CONV_B}`);

    expect(await screen.findByText('Could not open this conversation')).toBeInTheDocument();
    expect(screen.getByText('Beeper request failed: connection refused')).toBeInTheDocument();
    expect(screen.queryByText('Pick a conversation')).toBeNull();
    expect(screen.queryByText('Conversation not found')).toBeNull();

    // Retry re-reads the mirror rather than leaving the pane stuck.
    const calls = api.getBeeperConversation.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(api.getBeeperConversation.mock.calls.length).toBeGreaterThan(calls));
  });

  it('scopes the list from the URL, so a shared link reopens the same scope', async () => {
    renderTab('/messages/beeper?scope=net:whatsapp&unread=1');
    await waitFor(() => expect(api.getBeeperConversations).toHaveBeenCalledWith(
      { unreadOnly: true, network: 'whatsapp', archived: false },
      { silent: true },
    ));
  });
});

describe('rendering at every install size', () => {
  it('renders with zero conversations, and says an empty list is often correct when networks are mirrored and the list loaded fine', async () => {
    api.getBeeperNetworks.mockResolvedValue({ networks: [NINE_NETWORKS[0]] });
    renderTab();
    expect(await screen.findByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText(/often correct rather than broken/)).toBeInTheDocument();
    expect(screen.queryByTestId('network-badge')).toBeNull();
  });

  it('drops the per-row network badge inside a single-network scope', async () => {
    api.getBeeperNetworks.mockResolvedValue({ networks: [NINE_NETWORKS[0]] });
    api.getBeeperConversations.mockResolvedValue({
      conversations: [conversation({ network: 'whatsapp' })],
      nextCursor: null,
    });

    renderTab('/messages/beeper?scope=net:whatsapp');

    expect(await screen.findByText('Example Conversation')).toBeInTheDocument();
    // The rail already states the network, so the badge would be noise — the
    // one conditional rule #9 says a from-scratch design would have got wrong.
    expect(screen.queryByTestId('network-badge')).toBeNull();
  });

  it('badges every row in the unified inbox, at nine networks', async () => {
    api.getBeeperNetworks.mockResolvedValue({ networks: NINE_NETWORKS });
    api.getBeeperConversations.mockResolvedValue({
      conversations: NINE_NETWORKS.map((entry, index) => conversation({
        id: `4444444${index}-4444-4444-8444-444444444444`,
        network: entry.network,
        title: `Example Conversation ${index}`,
      })),
      nextCursor: null,
    });

    renderTab();

    expect(await screen.findByText('Example Conversation 0')).toBeInTheDocument();
    expect(screen.getAllByTestId('network-badge')).toHaveLength(9);
    // One rail entry per mirrored network, and no hardcoded roster anywhere.
    expect(screen.getByRole('button', { name: 'WhatsApp' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Google Messages' })).toBeInTheDocument();
  });

  it('renders a network the client has no logo for rather than dropping it', async () => {
    api.getBeeperNetworks.mockResolvedValue({ networks: [{ network: 'somenewbridge', unreadCount: 0, conversationCount: 1, accountIds: [] }] });
    renderTab();
    expect(await screen.findByRole('button', { name: 'somenewbridge' })).toBeInTheDocument();
  });
});

/**
 * Audit cluster 08 (A11Y-3): the empty conversation list always stated
 * "{networks.length} network(s) mirrored ... often correct rather than
 * broken", even when the networks fetch had failed (networks lands at []
 * either way) — rendering "0 networks mirrored" as settled fact directly
 * under the visible error banner it contradicted. The fix branches the
 * second paragraph on whether anything is actually known to be wrong or
 * filtered, rather than always reciting the same reassurance.
 */
describe('the honest empty state (A11Y-3)', () => {
  it('shows no networks-mirrored reassurance and offers the settings link when no networks are mirrored and Beeper is not connected', async () => {
    // #80: the empty state branches on `tokenConfigured`, not on
    // `networks.length` alone — the settings-link copy this test pins is the
    // NOT-CONNECTED branch, so it needs a not-connected status.
    api.getBeeperStatus.mockResolvedValue({ tokenConfigured: false, reachable: null, accounts: [], realtime: null });
    api.getBeeperNetworks.mockRejectedValue(new Error('network fetch failed'));
    renderTab();
    await screen.findByText('Nothing here');
    expect(screen.queryByText(/network.*mirrored/i)).toBeNull();
    expect(screen.getByRole('button', { name: /open beeper settings/i })).toBeInTheDocument();
  });

  it('names the unread filter instead of the reassurance when unreadOnly is on', async () => {
    api.getBeeperNetworks.mockResolvedValue({ networks: [NINE_NETWORKS[0]] });
    renderTab('/messages/beeper?unread=1');
    await screen.findByText('Nothing here');
    expect(screen.getByText(/filter is on/i)).toBeInTheDocument();
    expect(screen.queryByText(/often correct rather than broken/)).toBeNull();
  });

  it('suppresses the reassurance entirely when the conversation list itself failed to load', async () => {
    api.getBeeperNetworks.mockResolvedValue({ networks: [NINE_NETWORKS[0]] });
    api.getBeeperConversations.mockRejectedValue(new Error('Could not load conversations'));
    renderTab();
    await screen.findByText('Nothing here');
    expect(screen.queryByText(/network.*mirrored/i)).toBeNull();
    expect(screen.queryByText(/often correct rather than broken/)).toBeNull();
    expect(screen.queryByText(/nothing is mirrored yet/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /open beeper settings/i })).toBeNull();
  });

  // The other half of #80's branch: connected but nothing mirrored yet is a
  // DIFFERENT state from never-connected, and used to render the same
  // "connect a network" prompt to a user who already had.
  it('says a first sync is in progress, with no settings link, when Beeper is connected but nothing is mirrored yet', async () => {
    api.getBeeperStatus.mockResolvedValue({ tokenConfigured: true, reachable: true, accounts: [], realtime: null });
    api.getBeeperNetworks.mockResolvedValue({ networks: [] });
    renderTab();
    await screen.findByText('Nothing here');
    expect(screen.getByText(/first sync in progress/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open beeper settings/i })).toBeNull();
  });
});

/**
 * "Sync now" (#79): the list-header refresh action used to call only
 * `loadList()`/`loadNetworks()` — both pure SELECTs against the mirror — so
 * clicking it never actually triggered a sweep. It now runs one sweep first.
 */
describe('Sync now', () => {
  it('runs a sweep, then refetches the list and the networks', async () => {
    api.getBeeperNetworks.mockResolvedValue({ networks: [NINE_NETWORKS[0]] });
    renderTab();
    await screen.findByText('Nothing here');
    api.getBeeperConversations.mockClear();
    api.getBeeperNetworks.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));

    await waitFor(() => expect(api.syncBeeperNow).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.getBeeperConversations).toHaveBeenCalled());
    expect(api.getBeeperNetworks).toHaveBeenCalled();
    // The sweep must land BEFORE the refetch, or the refetch could race a
    // sweep that has not written anything yet.
    const [syncOrder] = api.syncBeeperNow.mock.invocationCallOrder;
    const [listOrder] = api.getBeeperConversations.mock.invocationCallOrder;
    expect(syncOrder).toBeLessThan(listOrder);
  });

  it('still refetches, without an error toast, when the sweep reports skipped: true', async () => {
    api.syncBeeperNow.mockResolvedValue({ skipped: true });
    renderTab();
    await screen.findByText('Nothing here');
    api.getBeeperConversations.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));

    await waitFor(() => expect(api.getBeeperConversations).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('toasts and still re-enables the button when the sweep request itself fails', async () => {
    api.syncBeeperNow.mockRejectedValue(new Error('Beeper sweep failed for all 3 accounts'));
    renderTab();
    await screen.findByText('Nothing here');

    const button = screen.getByRole('button', { name: /sync now/i });
    fireEvent.click(button);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Beeper sweep failed for all 3 accounts'));
    expect(button).toBeEnabled();
  });
});

/**
 * The list header's sweep-visibility strip (#80): "Syncing… N of M accounts"
 * while a sweep runs, "Last synced HH:MM" once idle. Both ride the same
 * `GET /api/beeper/status` fetch `realtime`/`breaker` already used, seeded at
 * mount — no separate polling loop.
 */
describe('the syncing / last-synced strip', () => {
  it('shows "Syncing… N of M accounts" while a sweep is running', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, reachable: true, accounts: [], realtime: null,
      sweep: {
        running: true, startedAt: '2026-09-05T10:00:00.000Z', finishedAt: null, reason: 'scheduler',
        accountsDone: 3, accountsTotal: 9, chats: 40, messages: 812,
      },
    });
    renderTab();
    expect(await screen.findByText('Syncing… 3 of 9 accounts')).toBeInTheDocument();
  });

  it('shows "Last synced HH:MM" once idle, formatted from finishedAt', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, reachable: true, accounts: [], realtime: null,
      sweep: {
        running: false, startedAt: '2026-09-05T10:00:00.000Z', finishedAt: '2026-09-05T10:04:00.000Z', reason: 'manual',
        accountsDone: 9, accountsTotal: 9, chats: 210, messages: 4032,
      },
    });
    renderTab();
    expect(await screen.findByText(/Last synced \d{1,2}:\d{2}/)).toBeInTheDocument();
  });

  it('shows neither line before any sweep has ever run', async () => {
    api.getBeeperStatus.mockResolvedValue({ tokenConfigured: true, reachable: true, accounts: [], realtime: null, sweep: null });
    renderTab();
    await screen.findByText('Nothing here');
    expect(screen.queryByText(/Syncing…/)).toBeNull();
    expect(screen.queryByText(/Last synced/)).toBeNull();
  });
});

/**
 * Audit cluster 08 (A11Y-6): the list-error banner carried no role, and
 * `getBeeperConversations` is fetched silent, so a screen-reader user got no
 * signal that the list had failed to load.
 */
describe('the conversation list error banner is announced', () => {
  it('exposes the list-fetch failure with role="alert"', async () => {
    api.getBeeperConversations.mockRejectedValue(new Error('Could not load conversations'));
    renderTab();

    expect(await screen.findByText('Could not load conversations')).toHaveAttribute('role', 'alert');
  });
});

describe('message direction', () => {
  it('puts own messages on the other side of the thread, from the mirrored isSender', async () => {
    api.getBeeperConversation.mockResolvedValue(conversation({
      title: 'Example Contact',
      participants: [{ sourceUserId: 'user-1', displayName: 'Sam Example', handle: '', tribePersonId: null, tribePersonName: null, observedVia: 'participant-list' }],
    }));
    api.getBeeperMessages.mockResolvedValue({
      messages: [
        { id: 'm2', conversationId: CONV_A, senderId: 'user-me', body: 'Placeholder outbound', sentAt: '2026-09-01T10:00:00.000Z', isSender: true, attachments: [] },
        { id: 'm1', conversationId: CONV_A, senderId: 'user-1', body: 'Placeholder inbound', sentAt: '2026-09-01T09:00:00.000Z', isSender: false, attachments: [] },
      ],
      nextCursor: null,
    });

    renderTab(`/messages/beeper/${CONV_A}`);

    await screen.findByText('Placeholder outbound');
    const bubbles = screen.getAllByTestId('beeper-message');
    // Rendered oldest-first, so the inbound one comes first.
    expect(bubbles.map((node) => node.dataset.direction)).toEqual(['in', 'out']);
    // An own message carries no sender name — the reference's shape, and the
    // reason direction has to be mirrored rather than guessed from senderId.
    expect(within(bubbles[1]).queryByText('user-me')).toBeNull();
    expect(within(bubbles[0]).getByText('Sam Example')).toBeInTheDocument();
  });

  it('renders a message with no direction as inbound rather than as unknown', async () => {
    api.getBeeperMessages.mockResolvedValue({
      messages: [{ id: 'm1', conversationId: CONV_A, senderId: 'user-1', body: 'Placeholder body', sentAt: '2026-09-01T09:00:00.000Z', attachments: [] }],
      nextCursor: null,
    });
    renderTab(`/messages/beeper/${CONV_A}`);
    await screen.findByText('Placeholder body');
    expect(screen.getByTestId('beeper-message').dataset.direction).toBe('in');
  });
});

describe('the pinned grid is Beeper’s own isPinned, mirrored', () => {
  it('lifts pinned conversations into the grid without any local pin state', async () => {
    api.getBeeperConversations.mockResolvedValue({
      conversations: [
        conversation({ id: CONV_A, title: 'Example Pinned', isPinned: true }),
        conversation({ id: CONV_B, title: 'Example Unpinned' }),
      ],
      nextCursor: null,
    });
    renderTab();

    await screen.findByText('Example Unpinned');
    // The grid renders the first word of a pinned title; the row list still
    // holds both. Nothing in the client can pin — there is no such control.
    expect(screen.getAllByText('Example').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Pin/ })).toBeNull();
  });
});

describe('deferred controls render inert rather than absent', () => {
  it('disables Requests, Later, add-scope and the overflow menu, each saying it is not available yet', async () => {
    renderTab();
    await screen.findByText('Nothing here');

    for (const label of ['Requests', 'Later', 'Add scope', 'More scope options']) {
      const control = screen.getByRole('button', { name: label });
      expect(control).toBeDisabled();
      expect(control).toHaveAttribute('title', `${label} — not available yet`);
    }
  });

  it('keeps the two wired scopes live', async () => {
    renderTab();
    await screen.findByText('Nothing here');
    expect(screen.getByRole('button', { name: 'Archive' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Low priority' })).toBeEnabled();
  });
});

/**
 * Audit cluster 08 (COPY-2): "not wired yet" is implementation vocabulary
 * leaking into shipped copy — the InertControl tooltip template and the
 * composer's attach button both used it. Upstream's own convention is
 * "Coming soon — …" (ImportTab.jsx); this file's fix lands on
 * "not available yet" / "aren't supported yet" instead. Scans the rendered
 * DOM rather than one control at a time, so a leftover site anywhere would
 * still fail this even if a future edit missed it.
 */
describe('no leftover "not wired" copy anywhere in the surface', () => {
  it('renders no title or text containing "not wired", across the rail and the composer', async () => {
    api.getBeeperConversation.mockResolvedValue(conversation({ title: 'Example Contact', network: 'whatsapp' }));
    renderTab(`/messages/beeper/${CONV_A}`);
    await screen.findByLabelText('Message Example Contact on WhatsApp');

    const titled = [...document.querySelectorAll('[title]')].map((el) => el.getAttribute('title') || '');
    expect(titled.some((title) => title.toLowerCase().includes('not wired'))).toBe(false);
    expect(document.body.textContent.toLowerCase()).not.toContain('not wired');
  });
});

/**
 * Audit cluster 08 (COPY-3): the scope heading rendered a ChevronDown inside
 * a non-interactive span, implying a scope-picker menu that does not exist —
 * against the file's own docstring ("an inert control that looks live is
 * worse than an absent one"). The fix drops the chevron outright.
 */
describe('the scope heading has no control that looks interactive but has no handler', () => {
  it('renders the scope label with no chevron or icon beside it', async () => {
    renderTab();
    await screen.findByText('Nothing here');
    const label = screen.getByText('Inbox');
    expect(label.parentElement.querySelector('svg')).toBeNull();
  });
});

describe('the composer', () => {
  it('names the network it would send on and keeps the draft buffer', async () => {
    api.getBeeperConversation.mockResolvedValue(conversation({ network: 'whatsapp', title: 'Example Contact' }));
    renderTab(`/messages/beeper/${CONV_A}`);

    const composer = await screen.findByLabelText('Message Example Contact on WhatsApp');
    expect(composer).toHaveAttribute('placeholder', 'Message Example Contact on WhatsApp');
  });

  it('disables Send while the draft is empty', async () => {
    api.getBeeperConversation.mockResolvedValue(conversation({ network: 'whatsapp', title: 'Example Contact' }));
    renderTab(`/messages/beeper/${CONV_A}`);

    const send = await screen.findByRole('button', { name: 'Send' });
    // aria-disabled (A11Y-5), not the native disabled attribute — the button
    // must stay focusable so focus survives a mid-send disable.
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(send).not.toHaveAttribute('disabled');
    expect(send.getAttribute('title')).toBe('Type a message to send');
  });
});

// The composer's send lifecycle (#53, wired on the durable outbox from #36).
// `useBeeperOutbox` has its own thorough unit coverage
// (`hooks/useBeeperOutbox.test.jsx`) — what matters HERE is that the composer
// wires the right props to it and renders what it reports, at the same page
// boundary the rest of this file tests through.
describe('the composer sends', () => {
  const OUTBOUND_TEXT = 'Placeholder outbound text';

  const openComposer = async (overrides = {}) => {
    api.getBeeperConversation.mockResolvedValue(conversation({ network: 'whatsapp', title: 'Example Contact', ...overrides }));
    renderTab(`/messages/beeper/${CONV_A}`);
    const composer = await screen.findByLabelText('Message Example Contact on WhatsApp');
    fireEvent.change(composer, { target: { value: OUTBOUND_TEXT } });
    return composer;
  };

  it('enqueues a send through the outbox with the right payload — one row, one send call', async () => {
    apiBeeper.createOutboxEntry.mockResolvedValue({ id: 'outbox-1', conversationId: CONV_A, body: OUTBOUND_TEXT, state: 'approved' });
    apiBeeper.sendOutboxEntry.mockResolvedValue({ id: 'outbox-1', conversationId: CONV_A, body: OUTBOUND_TEXT, state: 'awaiting-confirmation' });
    const composer = await openComposer();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(apiBeeper.createOutboxEntry).toHaveBeenCalledWith(CONV_A, OUTBOUND_TEXT, { silent: true }));
    expect(apiBeeper.createOutboxEntry).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(apiBeeper.sendOutboxEntry).toHaveBeenCalledWith('outbox-1', { confirmFirstContact: false }, { silent: true }));
    expect(apiBeeper.sendOutboxEntry).toHaveBeenCalledTimes(1);
    // `onSent` clears the draft buffer once the send is accepted.
    await waitFor(() => expect(composer).toHaveValue(''));
  });

  it('renders the pending row while the send is in flight', async () => {
    apiBeeper.createOutboxEntry.mockResolvedValue({ id: 'outbox-1', conversationId: CONV_A, body: OUTBOUND_TEXT, state: 'approved' });
    apiBeeper.sendOutboxEntry.mockReturnValue(new Promise(() => {})); // never settles within this test
    await openComposer();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const row = await screen.findByTestId('beeper-outbox-row');
    expect(row).toHaveAttribute('data-state', 'approved');
    expect(within(row).getByText(OUTBOUND_TEXT)).toBeInTheDocument();
    expect(within(row).getByText('Sending…')).toBeInTheDocument();
  });

  it('shows the real mirrored message once an entry is confirmed, with no duplicate pending row', async () => {
    apiBeeper.listOutboxEntries.mockResolvedValue({
      entries: [{ id: 'outbox-1', conversationId: CONV_A, body: OUTBOUND_TEXT, state: 'sent', messageId: 'msg-final-1' }],
    });
    api.getBeeperMessages.mockResolvedValue({
      messages: [{
        id: 'msg-final-1', conversationId: CONV_A, senderId: 'user-me', body: OUTBOUND_TEXT,
        sentAt: '2026-09-01T10:00:00.000Z', isSender: true, attachments: [],
      }],
      nextCursor: null,
    });
    api.getBeeperConversation.mockResolvedValue(conversation({ network: 'whatsapp', title: 'Example Contact' }));

    renderTab(`/messages/beeper/${CONV_A}`);

    await screen.findByText(OUTBOUND_TEXT);
    expect(screen.queryByTestId('beeper-outbox-row')).toBeNull();
    expect(screen.getAllByText(OUTBOUND_TEXT)).toHaveLength(1);
  });

  it('shows Retry on a failed send and leaves the composer text intact — never re-sent automatically', async () => {
    apiBeeper.createOutboxEntry.mockResolvedValue({ id: 'outbox-1', conversationId: CONV_A, body: OUTBOUND_TEXT, state: 'approved' });
    apiBeeper.sendOutboxEntry.mockRejectedValue(Object.assign(new Error('Beeper request failed: connection refused'), { code: 'NETWORK_ERROR' }));
    apiBeeper.listOutboxEntries.mockResolvedValue({
      entries: [{ id: 'outbox-1', conversationId: CONV_A, body: OUTBOUND_TEXT, state: 'failed', errorCode: 'NETWORK_ERROR' }],
    });
    const composer = await openComposer();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const row = await screen.findByTestId('beeper-outbox-row');
    await waitFor(() => expect(row).toHaveAttribute('data-state', 'failed'));
    expect(within(row).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(apiBeeper.sendOutboxEntry).toHaveBeenCalledTimes(1);
    expect(composer).toHaveValue(OUTBOUND_TEXT);
  });

  it('surfaces a first-contact refusal as an inline confirmation naming the network and recipient, then resends the SAME row', async () => {
    apiBeeper.createOutboxEntry.mockResolvedValue({ id: 'outbox-1', conversationId: CONV_A, body: OUTBOUND_TEXT, state: 'approved' });
    apiBeeper.sendOutboxEntry
      .mockRejectedValueOnce(Object.assign(
        new Error('This is the first message PortOS has ever sent to this conversation'),
        { code: 'FIRST_CONTACT_CONFIRMATION_REQUIRED' },
      ))
      .mockResolvedValueOnce({ id: 'outbox-1', conversationId: CONV_A, body: OUTBOUND_TEXT, state: 'awaiting-confirmation' });
    await openComposer();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // A question, not an error.
    expect(await screen.findByText(/first message PortOS has sent to Example Contact on WhatsApp/)).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }));

    expect(apiBeeper.createOutboxEntry).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(apiBeeper.sendOutboxEntry).toHaveBeenLastCalledWith(
      'outbox-1', { confirmFirstContact: true }, { silent: true },
    ));
    expect(apiBeeper.sendOutboxEntry).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByText(/send it\?/)).toBeNull());
  });

  // The reviewer's blocker on #53: repro was open a conversation PortOS has
  // never sent to, type, Send, then Cancel on the inline confirmation. The row
  // used to stay `approved` and unrendered-as-cancelled, so it fell into
  // OutboxRow's default branch and rendered a permanent "Sending…" bubble —
  // reappearing on every reload because GET /outbox returns approved rows, with
  // no dismiss control and no way back. Cancel must discard the row outright.
  it('discards the pending bubble on Cancel — no phantom "Sending…" row left behind', async () => {
    apiBeeper.createOutboxEntry.mockResolvedValue({ id: 'outbox-1', conversationId: CONV_A, body: OUTBOUND_TEXT, state: 'approved' });
    apiBeeper.sendOutboxEntry.mockRejectedValueOnce(Object.assign(
      new Error('This is the first message PortOS has ever sent to this conversation'),
      { code: 'FIRST_CONTACT_CONFIRMATION_REQUIRED' },
    ));
    const composer = await openComposer();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/first message PortOS has sent to Example Contact on WhatsApp/)).toBeInTheDocument();
    expect(await screen.findByTestId('beeper-outbox-row')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(apiBeeper.discardOutboxEntry).toHaveBeenCalledWith('outbox-1', { silent: true }));
    // The question closes, the phantom bubble is gone, and the composer text is
    // untouched — Cancel only withdraws the send, it does not clear the draft.
    await waitFor(() => expect(screen.queryByText(/send it\?/)).toBeNull());
    expect(screen.queryByTestId('beeper-outbox-row')).toBeNull();
    expect(composer).toHaveValue(OUTBOUND_TEXT);

    // A GET /outbox after the cancel (e.g. a reload) no longer returns the row.
    apiBeeper.listOutboxEntries.mockResolvedValue({ entries: [] });
    expect(apiBeeper.sendOutboxEntry).toHaveBeenCalledTimes(1);
  });

  it('submits once from ⌘/Ctrl+Enter and once from a click inside the same render — the hook latch', async () => {
    apiBeeper.createOutboxEntry.mockResolvedValue({ id: 'outbox-1', conversationId: CONV_A, body: OUTBOUND_TEXT, state: 'approved' });
    apiBeeper.sendOutboxEntry.mockResolvedValue({ id: 'outbox-1', conversationId: CONV_A, body: OUTBOUND_TEXT, state: 'awaiting-confirmation' });
    const composer = await openComposer();
    const send = screen.getByRole('button', { name: 'Send' });

    await act(async () => {
      fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
      fireEvent.click(send);
      await Promise.resolve();
    });

    await waitFor(() => expect(apiBeeper.createOutboxEntry).toHaveBeenCalledTimes(1));
    expect(apiBeeper.sendOutboxEntry).toHaveBeenCalledTimes(1);
  });

  it('disables Send while the runaway breaker is tripped, even with a non-empty draft, and points at Settings', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true,
      reachable: true,
      accounts: [],
      realtime: { state: 'connected' },
      outbox: { breaker: { tripped: true, reason: 'synthetic loop', trippedAt: '2026-09-01T09:00:00.000Z' } },
    });
    const composer = await openComposer();

    const send = screen.getByRole('button', { name: 'Send' });
    // aria-disabled (A11Y-5): the button stays focusable — clicking it is a
    // no-op because handleSendClick itself checks canSend, not because the
    // click never reaches the handler.
    await waitFor(() => expect(send).toHaveAttribute('aria-disabled', 'true'));
    expect(send.getAttribute('title')).toMatch(/runaway breaker/);
    expect(composer).toHaveValue(OUTBOUND_TEXT);

    fireEvent.click(send);
    expect(apiBeeper.createOutboxEntry).not.toHaveBeenCalled();
  });

  // The breaker is PROCESS state that can trip mid-session — a send loop, or
  // three refused sends in a row — and the composer's gate used to be a
  // mount-time snapshot: `seedStatus` ran once and never again, so the Send
  // button stayed live against a server that would refuse every send until a
  // human cleared it, and only a page reload showed the truth.
  it('disables Send for a breaker that trips after mount, with no page reload', async () => {
    const status = (breaker) => ({
      tokenConfigured: true, reachable: true, accounts: [], realtime: { state: 'connected' }, outbox: { breaker },
    });
    api.getBeeperStatus.mockResolvedValue(status({ tripped: false, reason: null, trippedAt: null }));
    await openComposer();

    const send = screen.getByRole('button', { name: 'Send' });
    await waitFor(() => expect(send).toHaveAttribute('aria-disabled', 'false'));

    api.getBeeperStatus.mockResolvedValue(status({ tripped: true, reason: 'synthetic loop', trippedAt: '2026-09-01T09:00:00.000Z' }));
    act(() => {
      for (const fn of socketMock.handlers.get('beeper:invalidate') || []) {
        fn({ kind: 'message.upserted', chatID: 'chat-example-1', ids: ['m1'], seq: 7 });
      }
    });

    await waitFor(() => expect(send).toHaveAttribute('aria-disabled', 'true'));
    expect(send.getAttribute('title')).toMatch(/runaway breaker/);
    expect(send.getAttribute('title')).toContain('synthetic loop');
  });
});

describe('realtime', () => {
  // TWO subscriptions on the same shared socket, not one: the page's own
  // `useBeeperRealtime` (drives the rail's liveness dot and invalidation
  // refetches) and the one `useBeeperOutbox` opens internally (#53, wired on
  // #36's design) so the composer's send confirmation reacts to
  // `message.upserted` without waiting on the page's debounced refetch. Both
  // emit `beeper:subscribe` at mount and on every reconnect. Server-side this
  // is a no-op redundancy, not a bug: `beeperSubscribers` is a `Set` keyed on
  // the physical socket, so a second subscribe from the same socket dedupes,
  // and both hook instances share BeeperChatSurface's mount lifecycle, so
  // there is no unmount race where one instance's `beeper:unsubscribe` could
  // kill the other's subscription out from under it.
  it('subscribes on both realtime hooks and RE-SUBSCRIBES on every socket connect, so a reconnect is not silently dead', async () => {
    renderTab();
    await screen.findByText('Nothing here');
    expect(socketMock.emitted.filter(([event]) => event === 'beeper:subscribe')).toHaveLength(2);

    act(() => { for (const fn of socketMock.handlers.get('connect') || []) fn(); });
    expect(socketMock.emitted.filter(([event]) => event === 'beeper:subscribe')).toHaveLength(4);
  });

  it('refetches the list and the open thread after an invalidation frame', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderTab(`/messages/beeper/${CONV_A}`);
      // Settle every mount fetch inside act() before measuring — otherwise the
      // refetch assertion races the initial load rather than the frame.
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => {});
      const listCalls = api.getBeeperConversations.mock.calls.length;
      const threadCalls = api.getBeeperMessages.mock.calls.length;

      act(() => {
        for (const fn of socketMock.handlers.get('beeper:invalidate') || []) {
          fn({ kind: 'message.upserted', chatID: 'chat-example-1', ids: ['m1'], seq: 4 });
        }
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });

      expect(api.getBeeperConversations.mock.calls.length).toBeGreaterThan(listCalls);
      expect(api.getBeeperMessages.mock.calls.length).toBeGreaterThan(threadCalls);
    } finally {
      vi.useRealTimers();
    }
  });

  // PERF-6/BEEP-5: the open thread used to refetch on ANY frame, discarding
  // paged-in history for traffic in some other chat entirely — `onInvalidate`
  // ignored the frame `useBeeperRealtime` already handed it. The list and
  // networks still refetch unconditionally (their previews/unread counts DO
  // change for any chat); only the thread refetch is now frame-scoped.
  it('does not refetch the open thread on an invalidation frame for another chat', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderTab(`/messages/beeper/${CONV_A}`);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => {});
      const listCalls = api.getBeeperConversations.mock.calls.length;
      const threadCalls = api.getBeeperMessages.mock.calls.length;

      act(() => {
        for (const fn of socketMock.handlers.get('beeper:invalidate') || []) {
          // CONV_A's fixture sourceChatId is 'chat-example-1' — this names a
          // different chat entirely.
          fn({ kind: 'message.upserted', chatID: 'chat-some-other-chat', ids: ['m9'], seq: 5 });
        }
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

      expect(api.getBeeperConversations.mock.calls.length).toBeGreaterThan(listCalls);
      expect(api.getBeeperMessages.mock.calls.length).toBe(threadCalls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refetches the open thread on a frame naming its chat, or with no chatID at all', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderTab(`/messages/beeper/${CONV_A}`);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => {});

      let threadCalls = api.getBeeperMessages.mock.calls.length;
      act(() => {
        for (const fn of socketMock.handlers.get('beeper:invalidate') || []) {
          fn({ kind: 'message.upserted', chatID: 'chat-example-1', ids: ['m1'], seq: 6 });
        }
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(api.getBeeperMessages.mock.calls.length).toBeGreaterThan(threadCalls);

      // A frame this vague (no chatID at all) could be about anything, so the
      // safe read is "maybe this thread" rather than "not this thread".
      threadCalls = api.getBeeperMessages.mock.calls.length;
      act(() => {
        for (const fn of socketMock.handlers.get('beeper:invalidate') || []) {
          fn({ kind: 'chat.upserted', chatID: null, ids: [], seq: 7 });
        }
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(api.getBeeperMessages.mock.calls.length).toBeGreaterThan(threadCalls);
    } finally {
      vi.useRealTimers();
    }
  });

  // PERF-6/BEEP-5, the additive half: a frame in scope must not replace the
  // thread wholesale — that discards whatever "Load earlier messages" already
  // paged in and resets the cursor. The fix fetches just the first page and
  // merges it into the HEAD by id.
  it('merges an in-scope invalidation refetch into the head, keeping paged-in history and the cursor', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const newest = {
        id: 'm1', conversationId: CONV_A, senderId: 'user-1', body: 'Placeholder newest message',
        sentAt: '2026-09-01T10:00:00.000Z', attachments: [],
      };
      const older = {
        id: 'm-older', conversationId: CONV_A, senderId: 'user-1', body: 'Placeholder older message',
        sentAt: '2026-09-01T08:00:00.000Z', attachments: [],
      };
      api.getBeeperMessages.mockResolvedValueOnce({ messages: [newest], nextCursor: 'cursor-1' });
      renderTab(`/messages/beeper/${CONV_A}`);
      await screen.findByText('Placeholder newest message');

      api.getBeeperMessages.mockResolvedValueOnce({ messages: [older], nextCursor: null });
      fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
      await screen.findByText('Placeholder older message');

      // The refresh brings back an UPDATED copy of the same newest message —
      // same id, new body — and nothing else new.
      api.getBeeperMessages.mockResolvedValueOnce({
        messages: [{ ...newest, body: 'Placeholder newest message, edited' }],
        nextCursor: 'should-be-ignored-by-a-head-only-merge',
      });
      act(() => {
        for (const fn of socketMock.handlers.get('beeper:invalidate') || []) {
          fn({ kind: 'message.upserted', chatID: 'chat-example-1', ids: ['m1'], seq: 9 });
        }
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

      expect(await screen.findByText('Placeholder newest message, edited')).toBeInTheDocument();
      // Updated in place, not duplicated.
      expect(screen.queryByText('Placeholder newest message')).toBeNull();
      // The paged-in older message survives the merge.
      expect(screen.getByText('Placeholder older message')).toBeInTheDocument();
      // The cursor from the additive refresh is ignored — it was already
      // nulled by the earlier "Load earlier messages" and stays that way.
      expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // PERF-10: the debounce had no maximum wait, so a sustained frame stream —
  // each one arriving inside the previous frame's 350ms coalescing window —
  // reset it forever and the view never refreshed at all.
  it('still refetches within the bounded max wait despite a sustained stream of invalidation frames', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderTab(`/messages/beeper/${CONV_A}`);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => {});
      const listCalls = api.getBeeperConversations.mock.calls.length;

      // A frame every 200ms, well inside the 350ms debounce, for 2.4s total —
      // past the 2s ceiling.
      for (let i = 0; i < 12; i += 1) {
        act(() => {
          for (const fn of socketMock.handlers.get('beeper:invalidate') || []) {
            fn({ kind: 'message.upserted', chatID: 'chat-example-1', ids: [`m${i}`], seq: i + 1 });
          }
        });
        // eslint-disable-next-line no-await-in-loop
        await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      }

      expect(api.getBeeperConversations.mock.calls.length).toBeGreaterThan(listCalls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the liveness dot from the transport state and never as offline before it reports', async () => {
    api.getBeeperStatus.mockResolvedValue({ tokenConfigured: true, reachable: true, accounts: [], realtime: null });
    renderTab();
    await screen.findByText('Nothing here');
    expect(screen.queryByTestId('connection-status-dot')).toBeNull();

    act(() => {
      for (const fn of socketMock.handlers.get('beeper:realtime') || []) fn({ state: 'connected' });
    });
    expect(await screen.findByTestId('connection-status-dot')).toHaveAttribute('data-status', 'connected');
  });
});

describe('thread pagination', () => {
  it('sends the cursor on the second call and renders both pages', async () => {
    api.getBeeperMessages.mockResolvedValueOnce({
      messages: [{ id: 'm1', conversationId: CONV_A, senderId: 'user-1', body: 'Placeholder page one', sentAt: '2026-09-01T10:00:00.000Z', attachments: [] }],
      nextCursor: 'cursor-1',
    });
    renderTab(`/messages/beeper/${CONV_A}`);
    await screen.findByText('Placeholder page one');

    api.getBeeperMessages.mockResolvedValueOnce({
      messages: [{ id: 'm0', conversationId: CONV_A, senderId: 'user-1', body: 'Placeholder page two', sentAt: '2026-09-01T09:00:00.000Z', attachments: [] }],
      nextCursor: null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));

    await screen.findByText('Placeholder page two');
    expect(api.getBeeperMessages).toHaveBeenLastCalledWith(CONV_A, { cursor: 'cursor-1' }, { silent: true });
    expect(screen.getByText('Placeholder page one')).toBeInTheDocument();
    // The cursor came back null, so there is nothing further to page in.
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
  });

  // Finding T3: the thread-pagination generation guard used to return early
  // on a stale response WITHOUT clearing `loadingMore`, so "Load earlier
  // messages" rendered permanently disabled from that point on — even for a
  // conversation switched to AFTER the stale request was issued.
  it('leaves Load-more enabled on the new conversation when an old load-more resolves after a conversation switch', async () => {
    api.getBeeperConversations.mockResolvedValue({
      conversations: [
        conversation({ id: CONV_A, title: 'Example A', sourceChatId: 'chat-example-1' }),
        conversation({ id: CONV_B, title: 'Example B', sourceChatId: 'chat-example-2' }),
      ],
      nextCursor: null,
    });
    api.getBeeperConversation.mockImplementation((id) => Promise.resolve(
      id === CONV_B
        ? conversation({ id: CONV_B, title: 'Example B', sourceChatId: 'chat-example-2' })
        : conversation({ id: CONV_A, title: 'Example A', sourceChatId: 'chat-example-1' }),
    ));

    let releaseOldPage;
    const oldPage = new Promise((resolve) => { releaseOldPage = resolve; });
    api.getBeeperMessages.mockImplementation((id, opts) => {
      if (id === CONV_A && !opts?.cursor) {
        return Promise.resolve({
          messages: [{ id: 'm1', conversationId: CONV_A, senderId: 'user-1', body: 'Placeholder A newest', sentAt: '2026-09-01T10:00:00.000Z', attachments: [] }],
          nextCursor: 'cursor-a',
        });
      }
      if (id === CONV_A && opts?.cursor === 'cursor-a') return oldPage;
      if (id === CONV_B) {
        return Promise.resolve({
          messages: [{ id: 'm2', conversationId: CONV_B, senderId: 'user-1', body: 'Placeholder B newest', sentAt: '2026-09-01T09:00:00.000Z', attachments: [] }],
          nextCursor: 'cursor-b',
        });
      }
      return Promise.resolve({ messages: [], nextCursor: null });
    });

    renderTab(`/messages/beeper/${CONV_A}`);
    await screen.findByText('Placeholder A newest');

    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await waitFor(() => expect(api.getBeeperMessages).toHaveBeenLastCalledWith(CONV_A, { cursor: 'cursor-a' }, { silent: true }));

    // Switch conversations while A's load-more is still in flight.
    fireEvent.click(screen.getByText('Example B'));
    await screen.findByText('Placeholder B newest');
    const loadMoreForB = await screen.findByRole('button', { name: 'Load earlier messages' });

    releaseOldPage({
      messages: [{ id: 'm-old', conversationId: CONV_A, senderId: 'user-1', body: 'Placeholder A older', sentAt: '2026-09-01T08:00:00.000Z', attachments: [] }],
      nextCursor: null,
    });
    // The finally clause must clear `loadingMore` even though the generation
    // guard drops the stale response itself.
    await waitFor(() => expect(loadMoreForB).toBeEnabled());
    expect(screen.queryByText('Placeholder A older')).toBeNull();
  });
});

describe('list pagination (Load more)', () => {
  // Finding T5: `loadMoreConversations` had no in-flight latch — mirroring
  // `submittingRef` in `useBeeperOutbox.js` — so two clicks landing inside one
  // render both read "not loading yet" and both fired the same cursor page.
  it('issues exactly one extra page request when Load more is clicked twice inside one act()', async () => {
    api.getBeeperConversations
      .mockResolvedValueOnce({ conversations: [conversation({ id: CONV_A, title: 'Example A' })], nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ conversations: [conversation({ id: CONV_B, title: 'Example B' })], nextCursor: null });

    renderTab();
    await screen.findByText('Example A');
    const loadMore = screen.getByRole('button', { name: 'Load more' });

    await act(async () => {
      fireEvent.click(loadMore);
      fireEvent.click(loadMore);
      await Promise.resolve();
    });

    await screen.findByText('Example B');
    // One mount-time load plus exactly one page fetch — not two.
    expect(api.getBeeperConversations).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText('Example B')).toHaveLength(1);
  });
});

describe('the two wired rail controls', () => {
  it('archives through the API and reflects the value the server returned', async () => {
    api.getBeeperConversation.mockResolvedValue(conversation({ title: 'Example Contact' }));
    api.setBeeperConversationArchived.mockResolvedValue(conversation({ title: 'Example Contact', isArchived: true }));
    renderTab(`/messages/beeper/${CONV_A}`);

    const button = await screen.findByRole('button', { name: 'Archive', hidden: false });
    // Two controls carry the Archive name (the rail scope and the thread
    // action); the thread action is the one inside the header row.
    const threadArchive = screen.getAllByRole('button', { name: 'Archive' }).at(-1);
    expect(button).toBeTruthy();
    act(() => { threadArchive.click(); });

    await waitFor(() => expect(api.setBeeperConversationArchived).toHaveBeenCalledWith(CONV_A, true, { silent: true }));
    expect(await screen.findByRole('button', { name: 'Unarchive' })).toBeInTheDocument();
  });

  it('reports a failed write once and does not retry it', async () => {
    api.getBeeperConversation.mockResolvedValue(conversation({ title: 'Example Contact' }));
    api.setBeeperConversationLowPriority.mockRejectedValue(
      Object.assign(new Error('Beeper request failed: connection refused'), { status: 503, context: { retryable: false } }),
    );
    renderTab(`/messages/beeper/${CONV_A}`);

    const button = await screen.findByRole('button', { name: 'Low priority', hidden: false });
    const threadControl = screen.getAllByRole('button', { name: 'Low priority' }).at(-1);
    expect(button).toBeTruthy();
    act(() => { threadControl.click(); });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Beeper request failed: connection refused'));
    expect(api.setBeeperConversationLowPriority).toHaveBeenCalledTimes(1);
  });
});

// The LOCAL "seen in PortOS" watermark (#83) — the fix for opening an unread
// thread leaving its badge untouched. This NEVER reaches Beeper: no PATCH,
// no read receipt — see `markBeeperConversationSeen` (`apiBeeper.js`) and its
// server-side `markConversationSeen`.
describe('the local "seen in PortOS" watermark (#83)', () => {
  it('clears the row\'s own badge on open and calls the local mark-seen endpoint, never a Beeper write', async () => {
    api.getBeeperConversations.mockResolvedValue({
      conversations: [conversation({ title: 'Example Unread', unreadCount: 3 })],
      nextCursor: null,
    });
    api.getBeeperConversation.mockResolvedValue(conversation({ title: 'Example Unread', unreadCount: 3 }));

    renderTab();

    const row = (await screen.findByText('Example Unread')).closest('button');
    expect(within(row).getByText('3')).toBeInTheDocument();

    fireEvent.click(row);

    await waitFor(() => expect(api.markBeeperConversationSeen).toHaveBeenCalledWith(CONV_A, { silent: true }));
    // Optimistic: the row's own badge is gone as soon as the thread has
    // loaded, without waiting on the mark-seen POST's own round trip.
    await waitFor(() => expect(within(row).queryByText('3')).toBeNull());
    // Never a write to Beeper — this is a local read-model change only.
    expect(api.setBeeperConversationArchived).not.toHaveBeenCalled();
    expect(api.setBeeperConversationLowPriority).not.toHaveBeenCalled();
  });

  it('re-marks seen when a new message lands in the thread that is already open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderTab(`/messages/beeper/${CONV_A}`);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => {});
      await waitFor(() => expect(api.markBeeperConversationSeen).toHaveBeenCalledWith(CONV_A, { silent: true }));
      api.markBeeperConversationSeen.mockClear();

      api.getBeeperMessages.mockResolvedValueOnce({
        messages: [{
          id: 'm-new', conversationId: CONV_A, senderId: 'user-1', body: 'Placeholder new message',
          sentAt: '2026-09-01T11:00:00.000Z', attachments: [],
        }],
        nextCursor: null,
      });
      act(() => {
        for (const fn of socketMock.handlers.get('beeper:invalidate') || []) {
          fn({ kind: 'message.upserted', chatID: 'chat-example-1', ids: ['m-new'], seq: 10 });
        }
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

      await waitFor(() => expect(api.markBeeperConversationSeen).toHaveBeenCalledWith(CONV_A, { silent: true }));
    } finally {
      vi.useRealTimers();
    }
  });

  // PR 86's sweep emits an invalidation frame with `chatID: null` once per
  // account, which this surface's debounce treats as "could be about
  // anything" and refetches the open thread regardless — so a refetch that
  // comes back with nothing genuinely new (an UPDATED copy of an
  // already-rendered message, e.g. an edit or the eventual `message.upserted`
  // confirmation of a message already on screen) must not re-POST mark-seen.
  // Without this a multi-account sweep would fire one no-op mark-seen call
  // per account for a thread with nothing new in it.
  it('does not re-mark seen when an invalidation refetch returns only already-known messages', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const known = {
        id: 'm1', conversationId: CONV_A, senderId: 'user-1', body: 'Placeholder known message',
        sentAt: '2026-09-01T10:00:00.000Z', attachments: [],
      };
      api.getBeeperMessages.mockResolvedValue({ messages: [known], nextCursor: null });

      renderTab(`/messages/beeper/${CONV_A}`);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => {});
      await waitFor(() => expect(api.markBeeperConversationSeen).toHaveBeenCalledWith(CONV_A, { silent: true }));
      api.markBeeperConversationSeen.mockClear();

      // Same id back, just an updated body — not new activity.
      api.getBeeperMessages.mockResolvedValueOnce({
        messages: [{ ...known, body: 'Placeholder known message, edited' }],
        nextCursor: null,
      });
      act(() => {
        for (const fn of socketMock.handlers.get('beeper:invalidate') || []) {
          fn({ kind: 'chat.upserted', chatID: null, ids: [], seq: 11 });
        }
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

      expect(api.markBeeperConversationSeen).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a failed mark-seen call break opening the thread', async () => {
    api.markBeeperConversationSeen.mockRejectedValue(new Error('offline'));
    api.getBeeperConversation.mockResolvedValue(conversation({ title: 'Example Contact' }));
    renderTab(`/messages/beeper/${CONV_A}`);
    expect(await screen.findByText('Example Contact')).toBeInTheDocument();
  });
});

describe('the inline Tribe link action', () => {
  it('links a participant to an existing Tribe person', async () => {
    api.getTribePeople.mockResolvedValue([{ id: '55555555-5555-4555-8555-555555555555', name: 'Alex Example' }]);
    api.getBeeperConversation.mockResolvedValue(conversation({
      title: 'Example Contact',
      participants: [{ sourceUserId: 'user-1', displayName: 'Sam Example', handle: '+15550100', tribePersonId: null, tribePersonName: null, observedVia: 'participant-list' }],
    }));
    api.linkBeeperParticipant.mockResolvedValue({ participant: {}, displacedPersonId: null });

    renderTab(`/messages/beeper/${CONV_A}`);

    const peopleToggle = await screen.findByRole('button', { name: 'People' });
    act(() => { peopleToggle.click(); });
    // The search-first picker (#98 part B) replaced the `<select>` + Link
    // button: opening the results and clicking a match IS the link action.
    const picker = await screen.findByLabelText('Link Sam Example to a Tribe person');
    act(() => { picker.focus(); });
    const result = await screen.findByRole('option', { name: 'Alex Example' });
    act(() => { fireEvent.mouseDown(result); });

    await waitFor(() => expect(api.linkBeeperParticipant).toHaveBeenCalledWith(
      { conversationId: CONV_A, sourceUserId: 'user-1', personId: '55555555-5555-4555-8555-555555555555' },
      { silent: true },
    ));
  });

  // Fork issue #97 part A: "Create new…" opens the confirm-and-rename form
  // instead of posting immediately — this pins the wiring from the form's
  // Create button all the way down to `createTribePersonFromBeeper`.
  it('creates a Tribe person with the edited name, ring and relationship from the confirm-and-rename form', async () => {
    api.getTribePeople.mockResolvedValue([]);
    api.getBeeperConversation.mockResolvedValue(conversation({
      title: 'Example Contact',
      participants: [{ sourceUserId: 'user-1', displayName: 'Sam Example', handle: '', tribePersonId: null, tribePersonName: null, observedVia: 'participant-list' }],
    }));
    api.createTribePersonFromBeeper.mockResolvedValue({
      person: { id: 'new-person-1', name: 'Corrected Name' },
      participant: {},
      created: true,
      displacedPersonId: null,
    });

    renderTab(`/messages/beeper/${CONV_A}`);

    const peopleToggle = await screen.findByRole('button', { name: 'People' });
    act(() => { peopleToggle.click(); });
    const picker = await screen.findByLabelText('Link Sam Example to a Tribe person');
    act(() => { picker.focus(); });
    const createNew = await screen.findByRole('option', { name: /Create new/ });
    act(() => { fireEvent.mouseDown(createNew); });

    const nameInput = await screen.findByLabelText('Name');
    act(() => { fireEvent.change(nameInput, { target: { value: 'Corrected Name' } }); });
    act(() => { fireEvent.change(screen.getByLabelText('Ring'), { target: { value: 'core' } }); });
    act(() => { fireEvent.change(screen.getByLabelText('Relationship'), { target: { value: 'Neighbor' } }); });
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });

    await waitFor(() => expect(api.createTribePersonFromBeeper).toHaveBeenCalledWith(
      { conversationId: CONV_A, sourceUserId: 'user-1', name: 'Corrected Name', ring: 'core', relationship: 'Neighbor' },
      { silent: true },
    ));
  });
});

// Fork issue #97 part B: Change/Unlink on an already-linked participant.
describe('the inline Tribe unlink/change actions', () => {
  it('unlinks a linked participant', async () => {
    api.getTribePeople.mockResolvedValue([{ id: '55555555-5555-4555-8555-555555555555', name: 'Alex Example' }]);
    api.getBeeperConversation.mockResolvedValue(conversation({
      title: 'Example Contact',
      participants: [{
        sourceUserId: 'user-1', displayName: 'Sam Example', handle: '+15550100',
        tribePersonId: '55555555-5555-4555-8555-555555555555', tribePersonName: 'Alex Example', observedVia: 'participant-list',
      }],
    }));
    api.unlinkBeeperParticipant.mockResolvedValue({
      participant: {}, unlinkedPersonId: '55555555-5555-4555-8555-555555555555', removedClaims: 2,
    });

    renderTab(`/messages/beeper/${CONV_A}`);

    const peopleToggle = await screen.findByRole('button', { name: 'People' });
    act(() => { peopleToggle.click(); });
    const unlinkButton = await screen.findByRole('button', { name: 'Unlink' });
    act(() => { unlinkButton.click(); });

    await waitFor(() => expect(api.unlinkBeeperParticipant).toHaveBeenCalledWith(
      { conversationId: CONV_A, sourceUserId: 'user-1' },
      { silent: true },
    ));
  });

  it('re-links via a single POST /tribe/beeper/link call when Change picks a different person', async () => {
    api.getTribePeople.mockResolvedValue([
      { id: '55555555-5555-4555-8555-555555555555', name: 'Alex Example' },
      { id: '66666666-6666-4666-8666-666666666666', name: 'Blair Sample' },
    ]);
    api.getBeeperConversation.mockResolvedValue(conversation({
      title: 'Example Contact',
      participants: [{
        sourceUserId: 'user-1', displayName: 'Sam Example', handle: '+15550100',
        tribePersonId: '55555555-5555-4555-8555-555555555555', tribePersonName: 'Alex Example', observedVia: 'participant-list',
      }],
    }));
    api.linkBeeperParticipant.mockResolvedValue({ participant: {}, displacedPersonId: null });

    renderTab(`/messages/beeper/${CONV_A}`);

    const peopleToggle = await screen.findByRole('button', { name: 'People' });
    act(() => { peopleToggle.click(); });
    const changeButton = await screen.findByRole('button', { name: 'Change' });
    act(() => { changeButton.click(); });
    const picker = await screen.findByLabelText('Link Sam Example to a Tribe person');
    act(() => { picker.focus(); });
    const result = await screen.findByRole('option', { name: 'Blair Sample' });
    act(() => { fireEvent.mouseDown(result); });

    await waitFor(() => expect(api.linkBeeperParticipant).toHaveBeenCalledWith(
      { conversationId: CONV_A, sourceUserId: 'user-1', personId: '66666666-6666-4666-8666-666666666666' },
      { silent: true },
    ));
    expect(api.unlinkBeeperParticipant).not.toHaveBeenCalled();
  });
});

// Beeper's consent screen redirects the BROWSER back to this page, never to
// the settings drawer, so the page shell — not the panel inside the drawer —
// is what has to read the outcome off the URL (#31).
describe('the OAuth outcome carried back on the URL', () => {
  it('reports a successful connect', async () => {
    renderTab('/messages/beeper?beeperConnected=1');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Beeper connected'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('reports a mapped failure sentence for access_denied, with the code only as a parenthetical, and opens the settings drawer', async () => {
    renderTab('/messages/beeper?beeperOauthError=access_denied');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Beeper connect was not approved (access_denied)'));
    expect(await screen.findByRole('heading', { name: 'Beeper Settings' })).toBeInTheDocument();
  });

  it('falls back to a generic sentence plus the code for an unrecognized OAuth error', async () => {
    renderTab('/messages/beeper?beeperOauthError=temporarily_unavailable');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Beeper connect failed (temporarily_unavailable)'));
  });
});

// The lazy attachment mirror (#37) at the page boundary: what the thread
// renders, and what the purge confirmation demands before it deletes bytes.
describe('attachment mirror', () => {
  const imageAttachment = (overrides = {}) => ({
    messageId: 'm1',
    idx: 0,
    mxcId: 'mxc://example.invalid/abc',
    mimeType: 'image/png',
    fileName: 'example.png',
    byteLength: 2048,
    width: null,
    height: null,
    stored: false,
    keep: false,
    unavailable: false,
    overCap: false,
    maxBytes: 32 * 1024 * 1024,
    ...overrides,
  });

  const withAttachment = (attachment) => {
    api.getBeeperConversations.mockResolvedValue({ conversations: [conversation()], nextCursor: null });
    api.getBeeperMessages.mockResolvedValue({
      messages: [{
        id: 'm1', conversationId: CONV_A, senderId: 'user-1', body: 'Placeholder body',
        sentAt: '2026-09-01T10:00:00.000Z', attachments: [attachment],
      }],
      nextCursor: null,
    });
  };

  it('renders an image lazily against the mirror route — the request IS the fetch-on-view', async () => {
    withAttachment(imageAttachment());
    renderTab(`/messages/beeper/${CONV_A}`);

    const image = await screen.findByAltText('example.png');
    expect(image).toHaveAttribute('src', '/api/beeper/attachments/m1/0');
    expect(image).toHaveAttribute('loading', 'lazy');
  });

  it('renders an over-cap attachment as a placeholder naming the size, with "Fetch anyway"', async () => {
    withAttachment(imageAttachment({ byteLength: 40 * 1024 * 1024, overCap: true }));
    api.fetchBeeperAttachment.mockResolvedValue(imageAttachment({ byteLength: 40 * 1024 * 1024, overCap: true, stored: true }));
    renderTab(`/messages/beeper/${CONV_A}`);

    expect(await screen.findByText(/Larger than the 32 MB mirror limit/)).toBeInTheDocument();
    // Nothing was downloaded on render — the placeholder is not an <img>.
    expect(screen.queryByAltText('example.png')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Fetch anyway/i }));
    await waitFor(() => expect(api.fetchBeeperAttachment).toHaveBeenCalledWith('m1', 0, { silent: true }));
    expect(await screen.findByAltText('example.png')).toBeInTheDocument();
  });

  it('renders an unavailable attachment as a reference and never re-requests it', async () => {
    withAttachment(imageAttachment({ unavailable: true, unavailableReason: 'Failed to download asset' }));
    renderTab(`/messages/beeper/${CONV_A}`);

    expect(await screen.findByText(/Beeper can no longer supply this file/)).toBeInTheDocument();
    expect(screen.queryByAltText('example.png')).not.toBeInTheDocument();
    expect(api.fetchBeeperAttachment).not.toHaveBeenCalled();
  });

  it('renders a video as a generic tile rather than an inline player', async () => {
    withAttachment(imageAttachment({ mimeType: 'video/mp4', fileName: 'example.mp4' }));
    renderTab(`/messages/beeper/${CONV_A}`);

    const link = await screen.findByRole('link', { name: 'example.mp4' });
    expect(link).toHaveAttribute('href', '/api/beeper/attachments/m1/0');
    expect(document.querySelector('video')).toBeNull();
  });

  it('locks one attachment against eviction through the keep toggle', async () => {
    withAttachment(imageAttachment());
    api.setBeeperAttachmentKeep.mockResolvedValue(imageAttachment({ keep: true }));
    renderTab(`/messages/beeper/${CONV_A}`);

    fireEvent.click(await screen.findByRole('button', { name: /Keep this attachment/i }));
    await waitFor(() => expect(api.setBeeperAttachmentKeep).toHaveBeenCalledWith('m1', 0, true, { silent: true }));
    expect(await screen.findByRole('button', { name: /Stop keeping this attachment/i })).toBeInTheDocument();
  });
});

describe('purging one conversation mirror', () => {
  const openThread = async () => {
    api.getBeeperConversations.mockResolvedValue({ conversations: [conversation()], nextCursor: null });
    api.getBeeperConversation.mockResolvedValue(conversation({ attachmentBytes: 4 * 1024 * 1024, attachmentFiles: 3 }));
    renderTab(`/messages/beeper/${CONV_A}`);
    fireEvent.click(await screen.findByRole('button', { name: /^Purge$/ }));
  };

  it('names the conversation and the byte count, and demands the typed word first', async () => {
    await openThread();
    expect(await screen.findByText('Purge this mirror', {}, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.getByText(/4 MB of mirrored attachment bytes/)).toBeInTheDocument();
    expect(screen.getByText(/across 3 file\(s\)/)).toBeInTheDocument();

    const confirm = screen.getByRole('button', { name: /Purge mirror/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type purge to confirm/i), { target: { value: 'nope' } });
    expect(confirm).toBeDisabled();
    expect(api.purgeBeeperConversation).not.toHaveBeenCalled();
  });

  it('purges on the typed confirmation and returns to the list', async () => {
    api.purgeBeeperConversation.mockResolvedValue({
      purged: true, conversationId: CONV_A, messagesRemoved: 12, filesRemoved: 3, bytesFreed: 4194304,
    });
    await openThread();
    fireEvent.change(await screen.findByLabelText(/Type purge to confirm/i), { target: { value: 'purge' } });
    fireEvent.click(screen.getByRole('button', { name: /Purge mirror/i }));

    await waitFor(() => expect(api.purgeBeeperConversation).toHaveBeenCalledWith(CONV_A, { silent: true }));
    expect(await screen.findByText('Pick a conversation')).toBeInTheDocument();
  });

  // CLIENT SEC-2: an unsent draft is written straight to localStorage as the
  // composer changes (`portos-beeper-drafts`), independent of the server-side
  // mirror. A purge only deletes the mirror's messages, so nothing else ever
  // clears that draft entry once its conversation is gone — it would sit in
  // localStorage forever otherwise.
  it('deletes the conversation draft from localStorage on a successful purge', async () => {
    api.getBeeperConversations.mockResolvedValue({ conversations: [conversation()], nextCursor: null });
    api.getBeeperConversation.mockResolvedValue(conversation());
    api.purgeBeeperConversation.mockResolvedValue({
      purged: true, conversationId: CONV_A, messagesRemoved: 12, filesRemoved: 3, bytesFreed: 4194304,
    });
    renderTab(`/messages/beeper/${CONV_A}`);

    const composer = await screen.findByLabelText(/^Message Example Conversation/);
    fireEvent.change(composer, { target: { value: 'Placeholder unsent draft' } });
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('portos-beeper-drafts') || '{}');
      expect(stored[CONV_A]).toBe('Placeholder unsent draft');
    });

    fireEvent.click(screen.getByRole('button', { name: /^Purge$/ }));
    fireEvent.change(await screen.findByLabelText(/Type purge to confirm/i), { target: { value: 'purge' } });
    fireEvent.click(screen.getByRole('button', { name: /Purge mirror/i }));

    await waitFor(() => expect(api.purgeBeeperConversation).toHaveBeenCalledWith(CONV_A, { silent: true }));
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('portos-beeper-drafts') || '{}');
      expect(stored[CONV_A]).toBeUndefined();
    });
  });
});

// Final live pass: some networks deliver HTML message bodies (Discord, Matrix)
// and the mirror stores what the source sent, so the rail row rendered the tags
// as literal text under the conversation title.
describe('the rail preview', () => {
  it('shows an HTML last message as text, with no tags', async () => {
    api.getBeeperConversations.mockResolvedValue({
      conversations: [conversation({
        lastMessage: {
          id: 'm1', body: '<p>hello <strong>there</strong></p>', isSender: false, isUnsent: false,
        },
      })],
      nextCursor: null,
    });

    renderTab();

    expect(await screen.findByText('hello there')).toBeInTheDocument();
    expect(screen.queryByText(/<strong>/)).not.toBeInTheDocument();
  });

  it('leaves a plain last message alone but decodes its entities', async () => {
    api.getBeeperConversations.mockResolvedValue({
      conversations: [conversation({
        lastMessage: { id: 'm1', body: 'salt &amp; pepper', isSender: false, isUnsent: false },
      })],
      nextCursor: null,
    });

    renderTab();

    expect(await screen.findByText('salt & pepper')).toBeInTheDocument();
  });

  // #81: a chat with no mirrored message yet used to read as "No messages
  // mirrored yet" whether it was genuinely history-less or simply not caught
  // up — indistinguishable from a stale placeholder, and sorted at the top by
  // recency regardless. `lastActivity` is Beeper's own chat-level watermark,
  // mirrored independently of message content, so a recent one with no
  // `lastMessage` is the one signal that the row is still syncing.
  it('shows "Syncing…" for a conversation with recent activity and no mirrored message yet', async () => {
    api.getBeeperConversations.mockResolvedValue({
      conversations: [conversation({
        lastMessage: null,
        lastActivity: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      })],
      nextCursor: null,
    });

    renderTab();

    expect(await screen.findByText('Syncing…')).toBeInTheDocument();
    expect(screen.queryByText('No messages mirrored yet')).not.toBeInTheDocument();
  });

  it('keeps the honest "No messages mirrored yet" copy when there is no mirrored message and no recent activity', async () => {
    api.getBeeperConversations.mockResolvedValue({
      conversations: [conversation({
        lastMessage: null,
        lastActivity: '2020-01-01T00:00:00.000Z',
      })],
      nextCursor: null,
    });

    renderTab();

    expect(await screen.findByText('No messages mirrored yet')).toBeInTheDocument();
    expect(screen.queryByText('Syncing…')).not.toBeInTheDocument();
  });

  it('keeps the honest empty copy when there is neither a mirrored message nor any activity at all', async () => {
    api.getBeeperConversations.mockResolvedValue({
      conversations: [conversation({ lastMessage: null, lastActivity: null })],
      nextCursor: null,
    });

    renderTab();

    expect(await screen.findByText('No messages mirrored yet')).toBeInTheDocument();
  });
});

// A guard, not a formality: this file is the one place a real conversation,
// handle or contact name could slip into a PUBLIC repo while developing against
// a live install (root AGENTS.md, Sensitive Data & Privacy).
//
// It scans this file's own SOURCE rather than a hand-listed set of fixtures.
// Most fixtures here are written inline inside a single test — participants,
// messages, Tribe people, network rosters — so a guard that enumerates the two
// shared ones stops guarding the moment somebody pastes a third.
describe('fixture hygiene', () => {
  it('carries no value that could have come from a running instance', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL(import.meta.url), 'utf8');
    // Everything above this block. The patterns below necessarily spell out
    // the shapes they forbid, so scanning them would fail on the guard itself.
    const corpus = source.slice(0, source.indexOf("describe('fixture hygiene'"));
    // No e164-looking number outside the reserved 555-01xx block, no email
    // outside example.com, no bare hostname, no absolute home path.
    expect(corpus).not.toMatch(/\+(?!1555010)\d{7,}/);
    expect(corpus).not.toMatch(/@(?!example\.com)[\w.-]+\.[a-z]{2,}/i);
    expect(corpus).not.toMatch(/\.ts\.net|\.local\b/);
    expect(corpus).not.toMatch(/\/(?:home|Users)\/[a-z]/i);
    // Every human-readable label is explicitly a placeholder.
    expect(conversation().title).toMatch(/Example/);
  });
});
