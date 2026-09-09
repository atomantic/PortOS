import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup, fireEvent, render, screen, within,
} from '@testing-library/react';
import BeeperThread from './BeeperThread';

/**
 * PR #60 blocker 1: `OutboxRow` had no branch for the `approved` state — only
 * `failed` and `awaiting-confirmation`/`sent` — so a row left `approved` by a
 * refused send (most often `OUTBOX_BREAKER_OPEN`, #36) rendered as a
 * permanent spinner-plus-"Sending…" bubble with no Retry and no dismiss.
 * PR #60 blocker 2: with the breaker tripped, a `failed` row's Retry stayed
 * enabled and did nothing at all — that path composes a new entry through the
 * same send the breaker blocks.
 *
 * These tests exercise `OutboxRow` through the real component rather than in
 * isolation, since the "stalled vs. actively sending" distinction is read
 * off sibling props (`sending`, `confirmation`) it does not own itself.
 */

const CONVERSATION = {
  id: 'convo-1',
  title: 'Example Contact',
  network: 'whatsapp',
  participants: [],
};

const BASE_PROPS = {
  conversation: CONVERSATION,
  messages: [],
  loading: false,
  error: null,
  hasMore: false,
  loadingMore: false,
  onLoadMore: vi.fn(),
  draft: '',
  onDraftChange: vi.fn(),
  outboxEntries: [],
  sending: false,
  confirmation: null,
  onSend: vi.fn(),
  confirmAndSend: vi.fn(),
  cancelConfirmation: vi.fn(),
  retryOutboxEntry: vi.fn(),
  dismissOutboxEntry: vi.fn(),
  breaker: null,
  people: [],
  linkingId: null,
  onLinkParticipant: vi.fn(),
  onCreateAndLinkParticipant: vi.fn(),
  onUnlinkParticipant: vi.fn(),
  onOpenTribePerson: vi.fn(),
  onBack: vi.fn(),
  onRetry: null,
  onArchive: vi.fn(),
  onLowPriority: vi.fn(),
  onPurge: null,
  purging: false,
  onAttachmentUpdated: vi.fn(),
  writePending: false,
};

const OUTBOX_ENTRY = { id: 'outbox-1', state: 'approved', body: 'hello there' };
const FAILED_ENTRY = {
  id: 'outbox-2', state: 'failed', body: 'hello there', errorMessage: 'Network error',
};
const TRIPPED_BREAKER = { tripped: true, reason: 'too many sends' };

// The server's own copy for a send interrupted by a restart, repeated here on
// purpose: client and server cannot share a module, so this literal and
// `SEND_INTERRUPTED_MESSAGE` in `server/services/beeperOutbox.js` are pinned by
// a test on each side rather than by an import.
const SEND_INTERRUPTED_COPY = 'Delivery unconfirmed: PortOS restarted mid-send. Check the chat before retrying.';
const UNRESOLVED_REASON = 'Beeper reported no matching message within 30s — it may still have been delivered, so it was not re-sent.';

// A send that settled long ago. `GET /outbox` returns up to 50 entries in every
// state, so its mirrored message is routinely older than the newest page.
const SENT_ENTRY = {
  id: 'outbox-3', state: 'sent', body: 'settled long ago', messageId: 'msg-aged-out',
};
const UNRESOLVED_ENTRY = {
  id: 'outbox-4',
  state: 'awaiting-confirmation',
  body: 'hello there',
  errorCode: 'CONFIRMATION_UNRESOLVED',
  errorMessage: UNRESOLVED_REASON,
};
const INTERRUPTED_ENTRY = {
  id: 'outbox-5',
  state: 'failed',
  body: 'hello there',
  errorCode: 'SEND_INTERRUPTED',
  errorMessage: SEND_INTERRUPTED_COPY,
};

const renderThread = (overrides = {}) => render(<BeeperThread {...BASE_PROPS} {...overrides} />);

afterEach(cleanup);

describe('BeeperThread — outbox row states', () => {
  it('offers Retry and Dismiss on a stalled approved row instead of a permanent spinner', () => {
    renderThread({ outboxEntries: [OUTBOX_ENTRY], sending: false });

    const row = screen.getByTestId('beeper-outbox-row');
    expect(row).toHaveAttribute('data-state', 'approved');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.queryByText('Sending…')).not.toBeInTheDocument();
  });

  it('still shows the sending spinner, not Retry/Dismiss, while an approved row is actually in flight', () => {
    renderThread({ outboxEntries: [OUTBOX_ENTRY], sending: true });

    expect(screen.getByText('Sending…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('still shows the sending spinner while the same row is the subject of a pending first-contact confirmation', () => {
    renderThread({
      outboxEntries: [OUTBOX_ENTRY],
      sending: false,
      confirmation: { entry: OUTBOX_ENTRY, message: 'first contact' },
    });

    expect(screen.getByText('Sending…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  // Retrying a stalled row must re-dispatch the SAME row (via the hook's
  // `retry`), never compose a new one through `onSend` — that would
  // manufacture a fresh phantom on every click while the breaker stays
  // tripped, the failure mode the reviewer flagged.
  it('retries a stalled row in place, never composing a new one via onSend', () => {
    const retryOutboxEntry = vi.fn();
    const onSend = vi.fn();
    renderThread({
      outboxEntries: [OUTBOX_ENTRY], sending: false, retryOutboxEntry, onSend,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(retryOutboxEntry).toHaveBeenCalledWith(OUTBOX_ENTRY);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('dismisses a stalled row on request', () => {
    const dismissOutboxEntry = vi.fn();
    renderThread({ outboxEntries: [OUTBOX_ENTRY], sending: false, dismissOutboxEntry });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(dismissOutboxEntry).toHaveBeenCalledWith(OUTBOX_ENTRY);
  });

  // The failed row's text is NOT the composer's draft, so this send must not
  // clear the composer on success — a message typed while the failed row sat
  // above it would be discarded, and dropped from storage with it.
  it('composes a new entry via onSend when retrying a failed row, without clearing the draft', () => {
    const onSend = vi.fn();
    const retryOutboxEntry = vi.fn();
    renderThread({ outboxEntries: [FAILED_ENTRY], onSend, retryOutboxEntry });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onSend).toHaveBeenCalledWith('hello there', { clearsDraft: false });
    expect(retryOutboxEntry).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  // A failed row's Retry composes a new entry through the same send path the
  // breaker blocks, so with the breaker tripped it can only fail. It used to
  // stay enabled and silently do nothing (PR #60 blocker 2).
  it("disables a failed row's Retry while the breaker is tripped, with the Send button's reason", () => {
    const onSend = vi.fn();
    renderThread({ outboxEntries: [FAILED_ENTRY], breaker: TRIPPED_BREAKER, onSend });

    const retry = screen.getByRole('button', { name: 'Retry' });
    const sendTitle = screen.getByRole('button', { name: 'Send' }).getAttribute('title');
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute('title', sendTitle);
    expect(sendTitle).toContain('too many sends');

    fireEvent.click(retry);
    expect(onSend).not.toHaveBeenCalled();
  });

  // The stalled row is the opposite case: nothing has reached Beeper for it,
  // the server decides whether to refuse it again, and its 429 toasts. So
  // that Retry stays live even with the breaker tripped.
  it("leaves a stalled row's Retry enabled while the breaker is tripped", () => {
    const retryOutboxEntry = vi.fn();
    renderThread({ outboxEntries: [OUTBOX_ENTRY], breaker: TRIPPED_BREAKER, retryOutboxEntry });

    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toBeEnabled();

    fireEvent.click(retry);
    expect(retryOutboxEntry).toHaveBeenCalledWith(OUTBOX_ENTRY);
  });
});

/**
 * Every outbox state that cannot change on its own has to READ as finished. The
 * three below could each hold a spinner forever: a settled `sent` row whose
 * message had aged out of the loaded page, a send the server could not confirm,
 * and a send a restart interrupted. None of them will ever advance, so none of
 * them may spin — and none may lose that property on a remount, which is the
 * shape a reload takes.
 */
describe('BeeperThread — terminal outbox states never spin', () => {
  it('renders no bubble for a settled sent entry whose mirrored message is not in the loaded page', () => {
    const { container } = renderThread({ outboxEntries: [SENT_ENTRY], messages: [] });

    expect(screen.queryByTestId('beeper-outbox-row')).toBeNull();
    expect(screen.queryByText('settled long ago')).toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  // The mirrored-id check survives as the tiebreak for the one case it is still
  // the right answer for: a row still in flight that the sweep already mirrored.
  it('drops an awaiting-confirmation row the sweep has already mirrored', () => {
    const mirrored = {
      id: 'msg-mirrored', body: 'hello there', sentAt: '2026-09-01T10:00:00.000Z', isSender: true, senderId: 'user-me',
    };
    renderThread({
      outboxEntries: [{ ...UNRESOLVED_ENTRY, errorCode: null, errorMessage: null, messageId: 'msg-mirrored' }],
      messages: [mirrored],
    });

    expect(screen.queryByTestId('beeper-outbox-row')).toBeNull();
    expect(screen.getByTestId('beeper-message')).toBeInTheDocument();
  });

  it('renders an unconfirmed send as terminal, carrying the reason the server recorded', () => {
    const { container } = renderThread({ outboxEntries: [UNRESOLVED_ENTRY] });

    const row = screen.getByTestId('beeper-outbox-row');
    expect(row).toHaveAttribute('data-outcome', 'unconfirmed');
    expect(within(row).getByText(`Sent, unconfirmed — ${UNRESOLVED_REASON}`)).toBeInTheDocument();
    expect(screen.queryByText('Confirming…')).toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
    // No Retry: the message may well have been delivered, and a resend is the
    // one mistake that cannot be taken back.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('renders an interrupted send with the exact copy and the usual failed-row Retry', () => {
    const onSend = vi.fn();
    const { container } = renderThread({ outboxEntries: [INTERRUPTED_ENTRY], onSend });

    const row = screen.getByTestId('beeper-outbox-row');
    expect(row).toHaveAttribute('data-outcome', 'failed');
    expect(within(row).getByText(SEND_INTERRUPTED_COPY)).toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).toBeNull();

    fireEvent.click(within(row).getByRole('button', { name: 'Retry' }));
    // Retry composes a NEW entry from that row's text, exactly like any other
    // failed row — never a resend of a POST whose outcome is unknown.
    expect(onSend).toHaveBeenCalledWith('hello there', { clearsDraft: false });
  });

  it('keeps both terminal states across a remount, the shape a reload takes', () => {
    const first = renderThread({ outboxEntries: [UNRESOLVED_ENTRY, INTERRUPTED_ENTRY] });
    expect(screen.getAllByTestId('beeper-outbox-row')).toHaveLength(2);
    first.unmount();

    const { container } = renderThread({ outboxEntries: [UNRESOLVED_ENTRY, INTERRUPTED_ENTRY] });

    // Rendered oldest-last: `entries` arrives newest-first and is reversed.
    expect(screen.getAllByTestId('beeper-outbox-row').map((row) => row.dataset.outcome))
      .toEqual(['failed', 'unconfirmed']);
    expect(within(screen.getAllByTestId('beeper-outbox-row')[0]).getByText(SEND_INTERRUPTED_COPY)).toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });
});

/**
 * Final live pass: some networks (Discord, Matrix — 26% of messages on a real
 * install) deliver HTML bodies, and the mirror stores what the source sent, so
 * the bubble rendered the tags literally. The allowlisted subset is parsed and
 * rendered as elements; nothing reaches `dangerouslySetInnerHTML`.
 */
describe('BeeperThread — message bodies', () => {
  const message = (body) => ({
    id: 'msg-1', body, sentAt: '2026-09-01T10:00:00.000Z', isSender: false, senderId: 'user-1',
  });

  it('renders an HTML body as elements rather than showing the tags', () => {
    renderThread({ messages: [message('<p>hello <strong>there</strong></p><p>second line</p>')] });

    const bubble = screen.getByTestId('beeper-message');
    expect(bubble).toHaveTextContent('hello there');
    expect(bubble).toHaveTextContent('second line');
    expect(bubble.textContent).not.toContain('<p>');
    expect(bubble.textContent).not.toContain('<strong>');
    expect(bubble.querySelector('strong')).toBeInTheDocument();
  });

  it('renders a blockquote and a link, and refuses a non-http scheme', () => {
    renderThread({
      messages: [message('<blockquote>quoted</blockquote><p><a href="https://example.com">ok</a> <a href="javascript:alert(1)">no</a></p>')],
    });

    const bubble = screen.getByTestId('beeper-message');
    expect(bubble.querySelector('blockquote')).toHaveTextContent('quoted');
    const links = bubble.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'https://example.com');
    expect(bubble).toHaveTextContent('no');
  });

  it('keeps a plain body on the text-node path with its entities decoded (#59)', () => {
    renderThread({ messages: [message('salt &amp; pepper — 5 < 6')] });

    expect(screen.getByTestId('beeper-message')).toHaveTextContent('salt & pepper — 5 < 6');
  });
});

/**
 * Audit cluster 05 (Tribe linkage): the server used to leak `tribePersonId`/
 * `tribePersonName` for a participant whose Tribe person had been
 * soft-deleted, so this row's `if (participant.tribePersonId)` branch read it
 * as still linked and rendered "Linked · <deleted person>" with no way back —
 * the re-link `<select>`/buttons never appeared. The server fix (parity test
 * in `server/services/beeperConversations.test.js`) now sends such a
 * participant with `tribePersonId: null` and no `tribePersonName`, exactly
 * like a participant that was never linked at all. This pins the client's
 * side of that contract: given that shape, the People drawer must render the
 * re-link control, never a dead "Linked" label.
 */
describe('BeeperThread — participant Tribe link display', () => {
  const PEOPLE = [{ id: 'person-1', name: 'Alex Example' }];

  const openPeopleDrawer = () => fireEvent.click(screen.getByRole('button', { name: 'People' }));

  it('renders the re-link control, not a dead "Linked" label, for a participant whose Tribe person was soft-deleted', () => {
    renderThread({
      conversation: {
        ...CONVERSATION,
        participants: [{
          sourceUserId: 'user-1',
          displayName: 'Sam Example',
          handle: '+15550100',
          tribePersonId: null,
          tribePersonName: null,
          observedVia: 'participant-list',
        }],
      },
      people: PEOPLE,
    });

    openPeopleDrawer();

    expect(screen.queryByText(/^Linked/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Link Sam Example to a Tribe person')).toBeInTheDocument();
    // The picker replaces the old `<select>` + Link button — no such button
    // remains, and there is no separate "Link" step: picking a result IS it.
    expect(screen.queryByRole('button', { name: 'Link' })).not.toBeInTheDocument();
    expect(document.querySelector('select')).toBeNull();
  });

  it('still shows the Linked label (and no re-link control) for a participant with an active link', () => {
    renderThread({
      conversation: {
        ...CONVERSATION,
        participants: [{
          sourceUserId: 'user-1',
          displayName: 'Sam Example',
          handle: '+15550100',
          tribePersonId: 'person-1',
          tribePersonName: 'Alex Example',
          observedVia: 'participant-list',
        }],
      },
      people: PEOPLE,
    });

    openPeopleDrawer();

    expect(screen.getByText('Linked · Alex Example')).toBeInTheDocument();
    expect(screen.queryByLabelText('Link Sam Example to a Tribe person')).not.toBeInTheDocument();
  });

  // #98 part C: the "Linked · <name>" row is a link straight to the Tribe
  // page (`?person=<id>`), the same deep link the title chip uses.
  it('jumps to the linked person\'s Tribe page when "Linked · <name>" is clicked', () => {
    const onOpenTribePerson = vi.fn();
    renderThread({
      conversation: {
        ...CONVERSATION,
        participants: [{
          sourceUserId: 'user-1',
          displayName: 'Sam Example',
          handle: '+15550100',
          tribePersonId: 'person-1',
          tribePersonName: 'Alex Example',
          observedVia: 'participant-list',
        }],
      },
      people: PEOPLE,
      onOpenTribePerson,
    });

    openPeopleDrawer();
    fireEvent.click(screen.getByText('Linked · Alex Example'));

    expect(onOpenTribePerson).toHaveBeenCalledWith('person-1');
  });
});

/**
 * Findings PERF-8/A11Y-2: the scroll-to-bottom effect keyed on `ordered.length`
 * directly, which "Load earlier messages" changes on every click (it only
 * prepends OLDER messages) — so every page-in yanked the reader back to the
 * newest message. The fix tracks the newest message actually on screen in a
 * ref and scrolls only when THAT changes (or the conversation does).
 */
/**
 * Audit cluster 08 (A11Y-5): the first-contact confirmation used to reveal
 * with no `autoFocus` and no accessible name, and the Send button dropped
 * itself to `disabled` mid-send — moving focus to `<body>` — so neither a
 * keyboard nor a screen-reader user was ever told the row had appeared.
 * `InlineConfirmRow` already supports `autoFocus` (see
 * `ui/UnsavedChangesConfirm.jsx`, the sibling caller); the fix wires it here
 * and swaps the Send button's `disabled` for `aria-disabled` so a mid-send
 * state change never steals focus away from it.
 */
describe('BeeperThread — first-contact confirmation is accessible', () => {
  it('moves focus into the revealed row and names the conversation as its accessible name', () => {
    renderThread({
      outboxEntries: [OUTBOX_ENTRY],
      confirmation: { entry: OUTBOX_ENTRY, message: 'first contact' },
    });

    const row = screen.getByLabelText(/Confirm sending the first message/);
    expect(row).toHaveFocus();
    expect(row).toHaveAccessibleName(expect.stringContaining('Example Contact'));
  });

  it('keeps focus on Send when it becomes aria-disabled mid-send, never the native disabled attribute', () => {
    const { rerender } = renderThread({ draft: 'hello', sending: false });
    const send = screen.getByRole('button', { name: 'Send' });
    send.focus();
    expect(send).toHaveFocus();

    rerender(<BeeperThread {...BASE_PROPS} draft="hello" sending />);

    const sendAfter = screen.getByRole('button', { name: 'Send' });
    expect(sendAfter).toHaveAttribute('aria-disabled', 'true');
    expect(sendAfter).not.toHaveAttribute('disabled');
    expect(sendAfter).toHaveFocus();
  });
});

/**
 * Audit cluster 08 (A11Y-6): the inline error paragraphs carried no role, and
 * every fetch behind them passes `{ silent: true }`, so a screen-reader user
 * got no signal at all when the thread failed to open or a fetch behind an
 * already-open thread errored.
 */
describe('BeeperThread — inline errors are announced', () => {
  it('exposes the could-not-open error as an alert', () => {
    renderThread({ conversation: null, error: 'Could not reach the mirror' });
    expect(screen.getByText('Could not reach the mirror')).toHaveAttribute('role', 'alert');
  });

  it('exposes the in-thread error banner as an alert', () => {
    renderThread({ error: 'Could not load newer messages' });
    expect(screen.getByText('Could not load newer messages')).toHaveAttribute('role', 'alert');
  });
});

describe('BeeperThread — scroll anchoring', () => {
  const olderMessage = (id, sentAt) => ({
    id, body: `Placeholder body ${id}`, sentAt, isSender: false, senderId: 'user-1', attachments: [],
  });

  it('leaves the scroll position on the fetched history when older messages page in', () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const newest = olderMessage('m2', '2026-09-01T10:00:00.000Z');
    const { rerender } = renderThread({ messages: [newest], hasMore: true });
    const callsAfterMount = scrollSpy.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    // Exactly what `loadMoreMessages` does on the real component: an OLDER
    // page appended to the TAIL of `messages` — the newest entry (and its id)
    // is untouched.
    const olderPage = olderMessage('m1', '2026-09-01T09:00:00.000Z');
    rerender(<BeeperThread {...BASE_PROPS} messages={[newest, olderPage]} hasMore={false} />);

    expect(scrollSpy.mock.calls.length).toBe(callsAfterMount);
    scrollSpy.mockRestore();
  });

  it('still scrolls to the bottom when a genuinely new newest message arrives', () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const first = olderMessage('m1', '2026-09-01T09:00:00.000Z');
    const { rerender } = renderThread({ messages: [first] });
    const callsAfterMount = scrollSpy.mock.calls.length;

    // A brand new message is NEWEST-first, so it lands at index 0.
    const brandNew = olderMessage('m2', '2026-09-01T10:00:00.000Z');
    rerender(<BeeperThread {...BASE_PROPS} messages={[brandNew, first]} />);

    expect(scrollSpy.mock.calls.length).toBeGreaterThan(callsAfterMount);
    scrollSpy.mockRestore();
  });

  it('scrolls on a conversation switch even when the newest message id is unchanged', () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const shared = olderMessage('m1', '2026-09-01T09:00:00.000Z');
    const { rerender } = renderThread({ messages: [shared] });
    const callsAfterMount = scrollSpy.mock.calls.length;

    rerender(<BeeperThread {...BASE_PROPS} conversation={{ ...CONVERSATION, id: 'convo-2' }} messages={[shared]} />);

    expect(scrollSpy.mock.calls.length).toBeGreaterThan(callsAfterMount);
    scrollSpy.mockRestore();
  });
});

/**
 * #98 part A: the Tribe link beside the thread title. A 1:1 chat (the fork
 * `isGroup` field, mirrored from Beeper's own `chat.type`) shows the
 * counterpart's link state; a group chat shows a participant-count chip
 * instead, regardless of how many rows happen to be linked.
 */
describe('BeeperThread — title Tribe chip', () => {
  const linkedParticipant = {
    sourceUserId: 'user-1', displayName: 'Sam Example', handle: '+15550100', tribePersonId: 'person-1', tribePersonName: 'Alex Example',
  };
  const unlinkedParticipant = {
    sourceUserId: 'user-1', displayName: 'Sam Example', handle: '+15550100', tribePersonId: null, tribePersonName: null,
  };

  it('shows "<name> · Tribe" for a linked 1:1 counterpart, and navigates on click', () => {
    const onOpenTribePerson = vi.fn();
    renderThread({
      conversation: { ...CONVERSATION, isGroup: false, participants: [linkedParticipant] },
      onOpenTribePerson,
    });

    const chip = screen.getByRole('button', { name: 'Alex Example · Tribe' });
    fireEvent.click(chip);
    expect(onOpenTribePerson).toHaveBeenCalledWith('person-1');
  });

  it('shows "Link to Tribe" for an unlinked 1:1 counterpart, opening the participants panel on click', () => {
    renderThread({
      conversation: { ...CONVERSATION, isGroup: false, participants: [unlinkedParticipant] },
    });

    expect(screen.queryByText(/Participants/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Link to Tribe/ }));
    expect(screen.getByText(/^Participants/)).toBeInTheDocument();
  });

  it('shows a participant-count chip for a group chat, never a per-person link state', () => {
    renderThread({
      conversation: {
        ...CONVERSATION,
        isGroup: true,
        participants: [linkedParticipant, unlinkedParticipant],
      },
    });

    expect(screen.getByRole('button', { name: '2 people' })).toBeInTheDocument();
    expect(screen.queryByText(/Tribe$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Link to Tribe/)).not.toBeInTheDocument();
  });

  it('marks a group-count chip partial ("+") when Beeper truncated the roster', () => {
    renderThread({
      conversation: {
        ...CONVERSATION, isGroup: true, participants: [linkedParticipant], hasMoreParticipants: true,
      },
    });

    expect(screen.getByRole('button', { name: '1+ person' })).toBeInTheDocument();
  });

  it('opens the participants panel from the group chip, the same panel the People button opens', () => {
    renderThread({
      conversation: { ...CONVERSATION, isGroup: true, participants: [linkedParticipant] },
    });

    fireEvent.click(screen.getByRole('button', { name: '1 person' }));
    expect(screen.getByText(/^Participants/)).toBeInTheDocument();
  });
});

/**
 * #98 part B: the search-first person picker replacing the old `<select>` in
 * the unlinked-participant row. These exercise it through `BeeperThread`
 * (rather than `BeeperPersonPicker` in isolation) for the wiring — that
 * selecting a result calls `onLinkParticipant` and that "Create new…" calls
 * `onCreateAndLinkParticipant` exactly like the old "New" button did. The
 * picker's own filtering/keyboard behavior is covered in
 * `BeeperPersonPicker.test.jsx`.
 */
describe('BeeperThread — participant picker wiring', () => {
  const PARTICIPANT = { sourceUserId: 'user-1', displayName: 'Sam Example', handle: '+15550100', tribePersonId: null };
  const PEOPLE = [{ id: 'person-1', name: 'Alex Example' }, { id: 'person-2', name: 'Blair Sample' }];

  const openDrawerAndFocusPicker = () => {
    fireEvent.click(screen.getByRole('button', { name: 'People' }));
    const input = screen.getByLabelText('Link Sam Example to a Tribe person');
    fireEvent.focus(input);
    return input;
  };

  it('links directly on selecting a result — no separate Link button', () => {
    const onLinkParticipant = vi.fn();
    renderThread({
      conversation: { ...CONVERSATION, participants: [PARTICIPANT] },
      people: PEOPLE,
      onLinkParticipant,
    });

    openDrawerAndFocusPicker();
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Alex Example' }));

    expect(onLinkParticipant).toHaveBeenCalledWith(PARTICIPANT, 'person-1');
  });

  it('puts "Create new…" last, after every match, and opens the confirm-and-rename form instead of creating immediately (#97 part A)', () => {
    const onCreateAndLinkParticipant = vi.fn();
    renderThread({
      conversation: { ...CONVERSATION, participants: [PARTICIPANT] },
      people: PEOPLE,
      onCreateAndLinkParticipant,
    });

    openDrawerAndFocusPicker();
    const options = screen.getAllByRole('option');
    expect(options[options.length - 1]).toHaveTextContent('Create new…');

    fireEvent.mouseDown(options[options.length - 1]);

    // No immediate post — the form takes the picker's place instead,
    // prefilled from the participant's own display name.
    expect(onCreateAndLinkParticipant).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Name')).toHaveValue('Sam Example');
  });

  it('is keyboard-navigable: ArrowDown cycles results, Enter selects the highlighted one', () => {
    const onLinkParticipant = vi.fn();
    renderThread({
      conversation: { ...CONVERSATION, participants: [PARTICIPANT] },
      people: PEOPLE,
      onLinkParticipant,
    });

    const input = openDrawerAndFocusPicker();
    // Starts on the first match (index 0); one ArrowDown moves to the second.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onLinkParticipant).toHaveBeenCalledWith(PARTICIPANT, 'person-2');
  });

  it('closes the results on Escape without linking anyone', () => {
    const onLinkParticipant = vi.fn();
    renderThread({
      conversation: { ...CONVERSATION, participants: [PARTICIPANT] },
      people: PEOPLE,
      onLinkParticipant,
    });

    const input = openDrawerAndFocusPicker();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onLinkParticipant).not.toHaveBeenCalled();
  });

  it('no full-roster <select> remains anywhere in the drawer', () => {
    renderThread({
      conversation: { ...CONVERSATION, participants: [PARTICIPANT] },
      people: PEOPLE,
    });

    fireEvent.click(screen.getByRole('button', { name: 'People' }));
    expect(document.querySelector('select')).toBeNull();
  });

  // #105: the roster `<ul>` (`max-h-40 … overflow-y-auto`) clips an
  // absolutely positioned child, so the results list used to extend that
  // scroll container instead of floating over it — nearly invisible on a
  // 1:1 chat. `BeeperPersonPicker` now portals it to `document.body`, which
  // this pins from the roster's side: the listbox must never be a DOM
  // descendant of the roster, portaled or not.
  it('renders the results listbox outside the participants roster, not clipped by its scroll container', () => {
    renderThread({
      conversation: { ...CONVERSATION, participants: [PARTICIPANT] },
      people: PEOPLE,
    });

    openDrawerAndFocusPicker();

    const roster = screen.getByTestId('beeper-participants-roster');
    const listbox = screen.getByRole('listbox');
    expect(roster.contains(listbox)).toBe(false);
    expect(document.body.contains(listbox)).toBe(true);
  });
});

/**
 * Fork issue #97 part A: the confirm-and-rename form "Create new…" opens
 * instead of posting immediately. The form's own field/keyboard contract is
 * pinned in isolation in `BeeperCreatePersonForm.test.jsx`; these cover the
 * wiring from the row into it and back.
 */
describe('BeeperThread — create-person form wiring', () => {
  const PARTICIPANT = { sourceUserId: 'user-1', displayName: 'Sam Example', handle: '+15550100', tribePersonId: null };
  const PEOPLE = [{ id: 'person-1', name: 'Alex Example' }];

  const openForm = () => {
    fireEvent.click(screen.getByRole('button', { name: 'People' }));
    const input = screen.getByLabelText('Link Sam Example to a Tribe person');
    fireEvent.focus(input);
    const options = screen.getAllByRole('option');
    fireEvent.mouseDown(options[options.length - 1]);
  };

  it('calls onCreateAndLinkParticipant with the edited name, ring and relationship only on Create', () => {
    const onCreateAndLinkParticipant = vi.fn();
    renderThread({
      conversation: { ...CONVERSATION, participants: [PARTICIPANT] },
      people: PEOPLE,
      onCreateAndLinkParticipant,
    });

    openForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Corrected Name' } });
    fireEvent.change(screen.getByLabelText('Ring'), { target: { value: 'core' } });
    fireEvent.change(screen.getByLabelText('Relationship'), { target: { value: 'Neighbor' } });
    expect(onCreateAndLinkParticipant).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(onCreateAndLinkParticipant).toHaveBeenCalledWith(
      PARTICIPANT,
      { name: 'Corrected Name', ring: 'core', relationship: 'Neighbor' },
    );
  });

  it('returns to the picker on Cancel, without creating anyone', () => {
    const onCreateAndLinkParticipant = vi.fn();
    renderThread({
      conversation: { ...CONVERSATION, participants: [PARTICIPANT] },
      people: PEOPLE,
      onCreateAndLinkParticipant,
    });

    openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCreateAndLinkParticipant).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Link Sam Example to a Tribe person')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('submits on Enter and cancels on Escape', () => {
    const onCreateAndLinkParticipant = vi.fn();
    renderThread({
      conversation: { ...CONVERSATION, participants: [PARTICIPANT] },
      people: PEOPLE,
      onCreateAndLinkParticipant,
    });

    openForm();
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' });
    const picker = screen.getByLabelText('Link Sam Example to a Tribe person');
    expect(picker).toBeInTheDocument();

    // The drawer stays open across Escape — reopen the form without
    // re-toggling the People button, which would otherwise close it.
    fireEvent.focus(picker);
    const options = screen.getAllByRole('option');
    fireEvent.mouseDown(options[options.length - 1]);
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Enter' });
    expect(onCreateAndLinkParticipant).toHaveBeenCalledWith(
      PARTICIPANT,
      { name: 'Sam Example', ring: 'tribe', relationship: '' },
    );
  });
});

/**
 * Fork issue #97 part B: Change and Unlink on an already-linked participant
 * row — the "Linked · <name>" label used to be the whole story, with no way
 * back from a mistaken or outdated link.
 */
describe('BeeperThread — change and unlink a linked participant', () => {
  const LINKED_PARTICIPANT = {
    sourceUserId: 'user-1', displayName: 'Sam Example', handle: '+15550100',
    tribePersonId: 'person-1', tribePersonName: 'Alex Example',
  };
  const PEOPLE = [{ id: 'person-1', name: 'Alex Example' }, { id: 'person-2', name: 'Blair Sample' }];

  const openPeopleDrawer = () => fireEvent.click(screen.getByRole('button', { name: 'People' }));

  it('offers Change and Unlink beside the Linked label', () => {
    renderThread({
      conversation: { ...CONVERSATION, participants: [LINKED_PARTICIPANT] },
      people: PEOPLE,
    });

    openPeopleDrawer();

    expect(screen.getByText('Linked · Alex Example')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlink' })).toBeInTheDocument();
  });

  it('opens the picker, pre-focused, on Change — selecting a person re-links via onLinkParticipant', () => {
    const onLinkParticipant = vi.fn();
    renderThread({
      conversation: { ...CONVERSATION, participants: [LINKED_PARTICIPANT] },
      people: PEOPLE,
      onLinkParticipant,
    });

    openPeopleDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));

    const picker = screen.getByLabelText('Link Sam Example to a Tribe person');
    expect(picker).toHaveFocus();

    fireEvent.mouseDown(screen.getByRole('option', { name: 'Blair Sample' }));
    expect(onLinkParticipant).toHaveBeenCalledWith(LINKED_PARTICIPANT, 'person-2');
  });

  it('returns to the Linked label on Cancel from the Change picker', () => {
    renderThread({
      conversation: { ...CONVERSATION, participants: [LINKED_PARTICIPANT] },
      people: PEOPLE,
    });

    openPeopleDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByText('Linked · Alex Example')).toBeInTheDocument();
  });

  it('opens the create-person form from "Create new…" inside the Change picker too', () => {
    renderThread({
      conversation: { ...CONVERSATION, participants: [LINKED_PARTICIPANT] },
      people: PEOPLE,
    });

    openPeopleDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    const options = screen.getAllByRole('option');
    fireEvent.mouseDown(options[options.length - 1]);

    expect(screen.getByLabelText('Name')).toHaveValue('Sam Example');
  });

  it('calls onUnlinkParticipant with the participant on Unlink', () => {
    const onUnlinkParticipant = vi.fn();
    renderThread({
      conversation: { ...CONVERSATION, participants: [LINKED_PARTICIPANT] },
      people: PEOPLE,
      onUnlinkParticipant,
    });

    openPeopleDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));

    expect(onUnlinkParticipant).toHaveBeenCalledWith(LINKED_PARTICIPANT);
  });

  it('resets an open Change picker back to view when the participant\'s own linked state changes', () => {
    const { rerender } = renderThread({
      conversation: { ...CONVERSATION, participants: [LINKED_PARTICIPANT] },
      people: PEOPLE,
    });

    openPeopleDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByLabelText('Link Sam Example to a Tribe person')).toBeInTheDocument();

    rerender(<BeeperThread
      {...BASE_PROPS}
      conversation={{
        ...CONVERSATION,
        participants: [{ ...LINKED_PARTICIPANT, tribePersonId: 'person-2', tribePersonName: 'Blair Sample' }],
      }}
      people={PEOPLE}
    />);

    expect(screen.getByText('Linked · Blair Sample')).toBeInTheDocument();
    expect(screen.queryByLabelText('Link Sam Example to a Tribe person')).not.toBeInTheDocument();
  });
});
