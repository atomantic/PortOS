import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DraftsTab from './DraftsTab.jsx';
import { buildIndex } from '../../services/domIndex.js';

vi.mock('../../services/api', () => ({
  getMessageDrafts: vi.fn(),
  sendMessageDraft: vi.fn(),
  reconcileMessageDraft: vi.fn(),
  approveMessageDraft: vi.fn(),
}));

import * as api from '../../services/api';
beforeEach(() => vi.clearAllMocks());

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
    api.getMessageDrafts.mockResolvedValue([
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
    api.getMessageDrafts.mockResolvedValue([
      { id: 'd1', status: 'approved', sendVia: 'api', subject: 'First' },
      { id: 'd2', status: 'approved', sendVia: 'api', subject: 'Second' }
    ]);
    let rejectSend;
    api.sendMessageDraft.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSend = reject; }));
    render(<DraftsTab accounts={[]} />);
    const [first, second] = await screen.findAllByRole('button', { name: 'Send' });
    fireEvent.click(first);
    fireEvent.click(first);
    expect(first).toBeDisabled();
    expect(first).toHaveAttribute('aria-busy', 'true');
    expect(second).toBeEnabled();
    expect(api.sendMessageDraft).toHaveBeenCalledTimes(1);
    await act(async () => { rejectSend(new Error('Example send failure')); });
    await waitFor(() => expect(first).toBeEnabled());
    api.sendMessageDraft.mockResolvedValueOnce({ success: true });
    fireEvent.click(first);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Send' })).toHaveLength(1));
    expect(screen.getByText('sent')).toBeInTheDocument();
    expect(api.getMessageDrafts).toHaveBeenCalledTimes(1);
  });
});

describe('DraftsTab interrupted delivery', () => {
  const unknown = {
    id: 'd1', status: 'delivery_unknown', sendVia: 'api',
    sendAttemptId: 'attempt-1', subject: 'Example interrupted message', body: 'Example body'
  };

  it('requires a mailbox check, records nondelivery once, and requires fresh approval', async () => {
    api.getMessageDrafts.mockResolvedValue([unknown]);
    let finish;
    api.reconcileMessageDraft.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
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
    expect(api.reconcileMessageDraft).toHaveBeenCalledTimes(1);
    expect(api.reconcileMessageDraft).toHaveBeenCalledWith('d1', {
      attemptId: 'attempt-1', outcome: 'not_sent'
    }, { silent: true });
    await act(async () => finish({ ...unknown, status: 'draft' }));
    expect(screen.queryByText('Delivery unknown')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    api.approveMessageDraft.mockResolvedValueOnce({ ...unknown, status: 'approved' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('button', { name: 'Send' })).toBeEnabled();
    expect(api.sendMessageDraft).not.toHaveBeenCalled();
    expect(api.getMessageDrafts).toHaveBeenCalledTimes(1);
  });

  it('keeps uncertainty visible on conflict and makes confirmed delivery terminal', async () => {
    api.getMessageDrafts.mockResolvedValue([unknown]);
    api.reconcileMessageDraft.mockRejectedValueOnce(new Error('Draft state conflict'));
    render(<DraftsTab accounts={[]} />);
    await screen.findByText('Delivery unknown');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm sent' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Draft state conflict');
    expect(screen.getByText('Delivery unknown')).toBeInTheDocument();
    api.reconcileMessageDraft.mockResolvedValueOnce({ ...unknown, status: 'sent' });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm sent' }));
    expect(await screen.findByText('sent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(api.sendMessageDraft).not.toHaveBeenCalled();
  });
});
