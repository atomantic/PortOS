import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DraftsTab from './DraftsTab.jsx';
import { buildIndex } from '../../services/domIndex.js';

vi.mock('../../services/apiMessages.js', () => ({
  getMessageDrafts: vi.fn(),
  sendMessageDraft: vi.fn(),
  reconcileMessageDraft: vi.fn(),
  approveMessageDraft: vi.fn(),
  updateMessageDraft: vi.fn(),
}));

const socketMock = vi.hoisted(() => {
  const handlers = new Map();
  return {
    handlers,
    socket: {
      on: (event, fn) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event).add(fn);
      },
      off: (event, fn) => { handlers.get(event)?.delete(fn); },
    },
  };
});
vi.mock('../../services/socket', () => ({ default: socketMock.socket }));

import {
  getMessageDrafts,
  sendMessageDraft,
  reconcileMessageDraft,
  approveMessageDraft,
  updateMessageDraft,
} from '../../services/apiMessages.js';
beforeEach(() => vi.clearAllMocks());

describe('DraftsTab Teams recipients', () => {
  it.each([
    ['pending_review', [], 'Approve'],
    ['approved', ['Alice'], 'Send'],
    ['draft', ['alice@example.com', 'Bob'], 'Approve'],
  ])('guides users to edit the To field on a %s draft with recipients %j', async (status, to, action) => {
    const draft = { id: 'd1', accountId: 'acc1', status, sendVia: 'playwright', subject: 'Teams reply', body: 'Example reply', to };
    getMessageDrafts.mockResolvedValueOnce([draft]);
    const fixed = { ...draft, to: ['alice@example.com'], status: 'draft' };
    updateMessageDraft.mockResolvedValueOnce(fixed);
    approveMessageDraft.mockResolvedValueOnce({ ...fixed, status: 'approved' });
    render(<DraftsTab accounts={[{ id: 'acc1', name: 'Teams', type: 'teams', canSend: true }]} />);

    const blockedAction = await screen.findByRole('button', { name: action });
    expect(screen.getByText(/Choose Edit.*To field/)).toBeInTheDocument();
    expect(blockedAction).toBeDisabled();
    fireEvent.click(blockedAction);
    expect(approveMessageDraft).not.toHaveBeenCalled();
    expect(sendMessageDraft).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'To' }), { target: { value: 'alice@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(updateMessageDraft).toHaveBeenCalledWith('d1', expect.objectContaining({ to: ['alice@example.com'] }));
    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(approve).toBeEnabled();
    expect(screen.queryByText(/valid Teams recipient email/)).not.toBeInTheDocument();
    fireEvent.click(approve);
    expect(await screen.findByRole('button', { name: 'Send' })).toBeEnabled();
  });
});

// jsdom doesn't do layout, so domIndex's isVisible() geometry checks would
// drop every element — same stub domIndex.test.jsx uses.
const makeVisible = () => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return this.parentNode; },
  });
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0 };
  };
};

// #5907 — the "Send" button on an approved draft dispatches messageSender to
// the draft's real recipients with no undo, but its label alone ("Send")
// never matched the destructive-word heuristic. It carries
// `data-voice-guard="confirm"` instead. This proves the CLIENT half of the
// fix: the real component renders the annotation and the real domIndex
// carries it onto the indexed entry. The SERVER half — that an entry shaped
// this way makes ui_click return confirmation_required regardless of its
// label — is covered in server/services/voice/tools.test.js.
describe('DraftsTab — voice confirmation annotation on Send (#5907)', () => {
  it('renders data-voice-guard="confirm" on the Send button for an approved draft', async () => {
    getMessageDrafts.mockResolvedValue([
      { id: 'd1', status: 'approved', sendVia: 'gmail', accountId: 'acc1', subject: 'Hi', body: 'text' },
    ]);
    makeVisible();

    render(<DraftsTab accounts={[{ id: 'acc1', name: 'Acme' }]} />);

    const sendButton = await screen.findByRole('button', { name: 'Send' });
    expect(sendButton).toHaveAttribute('data-voice-guard', 'confirm');

    const idx = buildIndex();
    const entry = idx.elements.find((e) => e.label === 'Send');
    expect(entry).toBeTruthy();
    expect(entry.guard).toBe('confirm');
  });
});


describe('DraftsTab pending sends', () => {
  it('immediately disables only the sending draft and clears pending on failure', async () => {
    getMessageDrafts.mockResolvedValue([
      { id: 'd1', status: 'approved', sendVia: 'api', subject: 'First' },
      { id: 'd2', status: 'approved', sendVia: 'api', subject: 'Second' }
    ]);
    let rejectSend;
    sendMessageDraft.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSend = reject; }));
    render(<DraftsTab accounts={[]} />);
    const [first, second] = await screen.findAllByRole('button', { name: 'Send' });
    fireEvent.click(first);
    fireEvent.click(first);
    expect(first).toBeDisabled();
    expect(first).toHaveAttribute('aria-busy', 'true');
    expect(second).toBeEnabled();
    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    await act(async () => { rejectSend(new Error('Example send failure')); });
    await waitFor(() => expect(first).toBeEnabled());
    sendMessageDraft.mockResolvedValueOnce({ success: true });
    fireEvent.click(first);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Send' })).toHaveLength(1));
    expect(screen.getByText('sent')).toBeInTheDocument();
    // The initial load plus the one reload after the failed send; the successful retry applies its response locally.
    expect(getMessageDrafts).toHaveBeenCalledTimes(2);
  });
});

describe('DraftsTab interrupted delivery', () => {
  const unknown = {
    id: 'd1', status: 'delivery_unknown', sendVia: 'api',
    sendAttemptId: 'attempt-1', subject: 'Example interrupted message', body: 'Example body'
  };

  it('requires a mailbox check, records nondelivery once, and requires fresh approval', async () => {
    getMessageDrafts.mockResolvedValue([unknown]);
    let finish;
    reconcileMessageDraft.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<DraftsTab accounts={[]} />);
    const confirmNotSent = await screen.findByRole('button', { name: 'Confirm not sent' });
    expect(screen.getByText(/It may already have reached the recipient/)).toBeInTheDocument();
    expect(confirmNotSent).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(confirmNotSent);
    fireEvent.click(confirmNotSent);
    expect(confirmNotSent).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Confirm sent' })).toBeDisabled();
    expect(reconcileMessageDraft).toHaveBeenCalledTimes(1);
    expect(reconcileMessageDraft).toHaveBeenCalledWith('d1', {
      attemptId: 'attempt-1', outcome: 'not_sent'
    }, { silent: true });
    await act(async () => finish({ ...unknown, status: 'draft' }));
    expect(screen.queryByText('Delivery unknown')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    approveMessageDraft.mockResolvedValueOnce({ ...unknown, status: 'approved' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('button', { name: 'Send' })).toBeEnabled();
    expect(sendMessageDraft).not.toHaveBeenCalled();
    expect(getMessageDrafts).toHaveBeenCalledTimes(1);
  });

  it('keeps uncertainty visible on conflict and makes confirmed delivery terminal', async () => {
    getMessageDrafts.mockResolvedValue([unknown]);
    reconcileMessageDraft.mockRejectedValueOnce(new Error('Draft state conflict'));
    render(<DraftsTab accounts={[]} />);
    await screen.findByText('Delivery unknown');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm sent' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Draft state conflict');
    expect(screen.getByText('Delivery unknown')).toBeInTheDocument();
    reconcileMessageDraft.mockResolvedValueOnce({ ...unknown, status: 'sent' });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm sent' }));
    expect(await screen.findByText('sent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(sendMessageDraft).not.toHaveBeenCalled();
  });
});

describe('DraftsTab send capabilities', () => {
  it('offers approval and send for browser-delivered accounts the server reports as sendable', async () => {
    getMessageDrafts.mockResolvedValue([
      { id: 'outlook-draft', status: 'draft', accountId: 'outlook', sendVia: 'playwright', body: 'Outlook text' },
      { id: 'teams-draft', status: 'approved', accountId: 'teams', sendVia: 'playwright', body: 'Teams text' }
    ]);
    render(<DraftsTab accounts={[
      { id: 'outlook', name: 'Outlook', canSend: true },
      { id: 'teams', name: 'Teams', canSend: true }
    ]} />);
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    expect(screen.queryByText(/Sending from this account isn't supported yet/)).not.toBeInTheDocument();
  });

  it('reloads drafts after a failed send so a provider-unconfirmed draft shows its reconciliation state', async () => {
    getMessageDrafts.mockResolvedValueOnce([
      { id: 'd1', status: 'approved', accountId: 'outlook', sendVia: 'playwright', body: 'Outlook text' }
    ]);
    getMessageDrafts.mockResolvedValueOnce([
      { id: 'd1', status: 'delivery_unknown', accountId: 'outlook', sendVia: 'playwright', sendAttemptId: 'attempt-1', body: 'Outlook text' }
    ]);
    sendMessageDraft.mockRejectedValueOnce(new Error('Example provider did not confirm delivery'));
    render(<DraftsTab accounts={[{ id: 'outlook', name: 'Outlook', canSend: true }]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/the provider never\s+confirmed it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('offers copy instead of approval/send for Outlook and Teams while Gmail still sends', async () => {
    getMessageDrafts.mockResolvedValue([
      { id: 'outlook-draft', status: 'draft', accountId: 'outlook', sendVia: 'playwright', body: 'Outlook text' },
      { id: 'teams-draft', status: 'approved', accountId: 'teams', sendVia: 'playwright', body: 'Teams text' },
      { id: 'gmail-draft', status: 'approved', accountId: 'gmail', sendVia: 'api', body: 'Gmail text' }
    ]);
    render(<DraftsTab accounts={[
      { id: 'outlook', name: 'Outlook', canSend: false },
      { id: 'teams', name: 'Teams', canSend: false },
      { id: 'gmail', name: 'Gmail', canSend: true }
    ]} />);
    expect(await screen.findAllByText(/Sending from this account isn't supported yet/)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Copy message' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Send' })).toHaveLength(1);
    sendMessageDraft.mockResolvedValueOnce({ success: true });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sendMessageDraft).toHaveBeenCalledWith('gmail-draft'));
  });

  it('displays a loading spinner while drafts are loading and shows empty state when done', async () => {
    let resolveDrafts;
    const draftsPromise = new Promise((resolve) => {
      resolveDrafts = resolve;
    });
    getMessageDrafts.mockReturnValueOnce(draftsPromise);

    render(<DraftsTab accounts={[]} />);

    expect(screen.getByLabelText('Loading drafts…')).toBeInTheDocument();
    expect(screen.queryByText('No drafts')).not.toBeInTheDocument();

    await act(async () => {
      resolveDrafts([]);
    });

    await waitFor(() => expect(screen.getByText('No drafts')).toBeInTheDocument());
    expect(screen.queryByLabelText('Loading drafts…')).not.toBeInTheDocument();
  });
});

describe('DraftsTab editing and review', () => {
  it.each(['draft', 'pending_review', 'approved', 'failed'])('offers edit for %s', async (status) => {
    getMessageDrafts.mockResolvedValue([
      { id: 'd1', status, sendVia: 'api', subject: 'Editable', body: 'Body' },
    ]);
    render(<DraftsTab accounts={[]} />);
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it.each(['sending', 'delivery_unknown', 'sent'])('does not offer edit for %s', async (status) => {
    getMessageDrafts.mockResolvedValue([{
      id: 'd1', status, sendVia: 'api', subject: 'Locked', body: 'Body', sendAttemptId: 'attempt-1',
    }]);
    render(<DraftsTab accounts={[]} />);
    expect(await screen.findByText(status === 'delivery_unknown' ? 'Delivery unknown' : status)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('saves recipient, subject, and body and applies an approval reset from the response', async () => {
    getMessageDrafts.mockResolvedValue([{
      id: 'd1', status: 'approved', sendVia: 'api', to: ['old@example.com'], subject: 'Old subject', body: 'Old body',
    }]);
    updateMessageDraft.mockResolvedValueOnce({
      id: 'd1', status: 'draft', sendVia: 'api', to: ['new@example.com', 'cc@example.com'],
      subject: 'New subject', body: 'New body',
    });
    render(<DraftsTab accounts={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'new@example.com, cc@example.com' } });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'New subject' } });
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'New body' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(updateMessageDraft).toHaveBeenCalledWith('d1', {
      to: ['new@example.com', 'cc@example.com'],
      subject: 'New subject',
      body: 'New body',
    }));
    expect(await screen.findByText('draft')).toBeInTheDocument();
    expect(screen.getByText('New subject')).toBeInTheDocument();
    expect(screen.getByText('New body')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('expands a clamped sendable body and leaves copy-only drafts fully visible', async () => {
    const longBody = 'Line one\nLine two\nLine three\nLine four that was hidden';
    getMessageDrafts.mockResolvedValue([
      { id: 'sendable', status: 'draft', sendVia: 'api', subject: 'Long', body: longBody },
      { id: 'copy', status: 'draft', accountId: 'outlook', sendVia: 'playwright', subject: 'Copy', body: longBody },
    ]);
    render(<DraftsTab accounts={[{ id: 'outlook', name: 'Outlook', canSend: false }]} />);
    const hiddenLine = await screen.findAllByText(/Line four that was hidden/);
    expect(hiddenLine[0].className).toContain('line-clamp-3');
    expect(hiddenLine[1].className).not.toContain('line-clamp-3');
    expect(screen.getAllByRole('button', { name: 'Show full message' })).toHaveLength(1);
    const toggle = screen.getByRole('button', { name: 'Show full message' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    expect(hiddenLine[0].className).not.toContain('line-clamp-3');
  });

  it('approves a pending_review draft', async () => {
    const pending = {
      id: 'd1', status: 'pending_review', sendVia: 'api', subject: 'Needs review', body: 'Please approve',
    };
    getMessageDrafts.mockResolvedValue([pending]);
    approveMessageDraft.mockResolvedValueOnce({ ...pending, status: 'approved' });
    render(<DraftsTab accounts={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(approveMessageDraft).toHaveBeenCalledWith('d1');
    expect(await screen.findByRole('button', { name: 'Send' })).toBeEnabled();
    expect(screen.getByText('approved')).toBeInTheDocument();
  });
});

describe('DraftsTab — failed read', () => {
  it('shows an error with Retry instead of "No drafts", then the drafts after Retry', async () => {
    getMessageDrafts.mockRejectedValueOnce(new Error('drafts down'));
    render(<DraftsTab accounts={[]} />);

    expect(await screen.findByText(/Could not load drafts — drafts down/)).toBeTruthy();
    expect(screen.queryByText('No drafts')).toBeNull();

    getMessageDrafts.mockResolvedValueOnce([
      { id: 'd1', status: 'draft', sendVia: 'api', subject: 'Recovered draft' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Recovered draft')).toBeTruthy();
    expect(screen.queryByText(/Could not load drafts/)).toBeNull();
  });
});

describe('DraftsTab live refresh', () => {
  it.each(['messages:draft:created', 'messages:draft:sent', 'messages:changed'])(
    'refetches drafts on %s and removes listeners on unmount', async (event) => {
      getMessageDrafts.mockResolvedValueOnce([{ id: 'd1', status: 'draft', subject: 'First' }]);
      const { unmount } = render(<DraftsTab accounts={[]} />);
      await screen.findByText('First');
      getMessageDrafts.mockResolvedValueOnce([
        { id: 'd1', status: 'draft', subject: 'First' },
        { id: 'd2', status: 'draft', subject: 'Second' },
      ]);
      await act(async () => { socketMock.handlers.get(event).forEach((fn) => fn()); });
      await screen.findByText('Second');
      unmount();
      expect(socketMock.handlers.get(event).size).toBe(0);
    });

  it('keeps loaded drafts when a live refresh fails', async () => {
    getMessageDrafts.mockResolvedValueOnce([{ id: 'd1', status: 'draft', subject: 'First' }]);
    render(<DraftsTab accounts={[]} />);
    await screen.findByText('First');
    getMessageDrafts.mockRejectedValueOnce(new Error('boom'));
    await act(async () => { socketMock.handlers.get('messages:changed').forEach((fn) => fn()); });
    await waitFor(() => expect(getMessageDrafts).toHaveBeenCalledTimes(2));
    expect(screen.getByText('First')).toBeInTheDocument();
  });
});
