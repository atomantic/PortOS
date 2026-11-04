import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  createMessageDraft: vi.fn(),
  executeMessageAction: vi.fn(),
  generateMessageDraft: vi.fn(),
  getMessageThread: vi.fn().mockResolvedValue({ messages: [] }),
  getSettings: vi.fn().mockResolvedValue({}),
  refreshMessage: vi.fn(),
  updateMessageDraft: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));

vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: toast }));

const MessageDetail = (await import('./MessageDetail')).default;

const baseMessage = {
  id: 'msg-1',
  accountId: 'acct-1',
  subject: 'Hello',
  from: { name: 'Alice', email: 'alice@example.com' },
  to: [{ email: 'bob@example.com' }],
  date: '2026-09-25T12:00:00.000Z',
  bodyFull: true,
};

function renderMessage(message) {
  return render(
    <MessageDetail
      message={message}
      accounts={[{ id: 'acct-1', name: 'Personal' }]}
      onBack={() => {}}
    />,
  );
}

// Reads the CSP directive string the iframe's own document head carries —
// the mechanism that actually blocks the fetch, independent of whether the
// sanitizer regex also caught the source markup.
function iframeCsp() {
  const iframe = document.querySelector('iframe[title="Email content"]');
  const meta = iframe.contentDocument.querySelector('meta[http-equiv="Content-Security-Policy"]');
  return meta?.getAttribute('content') || '';
}

describe('MessageDetail SafeHtmlBody remote content blocking', () => {
  beforeEach(() => {
    // Happy DOM 21 disables iframe loading, including the blank document.
    // Supply only an inert writable document; keep remote frame loading disabled.
    const documents = new WeakMap();
    vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get').mockImplementation(function () {
      if (!documents.has(this)) documents.set(this, document.implementation.createHTMLDocument(''));
      return documents.get(this);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('blocks remote images by default via a restrictive CSP and shows the opt-in notice', async () => {
    renderMessage({
      ...baseMessage,
      bodyHtml: '<p>Hi</p><img src="https://example.com/pixel.gif" alt="">',
    });

    await waitFor(() => expect(iframeCsp()).toContain("default-src 'none'"));
    expect(iframeCsp()).not.toMatch(/img-src[^;]*https:/);
    expect(iframeCsp()).toMatch(/img-src\s+data:\s+cid:/);
    expect(await screen.findByText('Remote images blocked')).toBeInTheDocument();
  });

  it('blocks a remote background-image and @import in inline/style content', async () => {
    renderMessage({
      ...baseMessage,
      bodyHtml: '<style>@import url(https://evil.example/track.css);</style>'
        + '<div style="background:url(https://evil.example/pixel.gif)">hi</div>',
    });

    await waitFor(() => expect(iframeCsp()).toContain("default-src 'none'"));
    expect(screen.getByText('Remote images blocked')).toBeInTheDocument();
  });

  it('widens img-src to https: only for this message after "Load remote images" is clicked', async () => {
    renderMessage({
      ...baseMessage,
      bodyHtml: '<img src="https://example.com/pixel.gif" alt="">',
    });

    await waitFor(() => expect(iframeCsp()).toContain("default-src 'none'"));
    fireEvent.click(await screen.findByRole('button', { name: 'Load remote images' }));

    await waitFor(() => expect(iframeCsp()).toMatch(/img-src[^;]*https:/));
    expect(screen.queryByText('Remote images blocked')).not.toBeInTheDocument();
  });

  it('does not carry a "load remote images" opt-in over to different content in a reused instance', async () => {
    const { rerender } = renderMessage({
      ...baseMessage,
      bodyHtml: '<img src="https://example.com/pixel.gif" alt="">',
    });
    await waitFor(() => expect(iframeCsp()).toContain("default-src 'none'"));
    fireEvent.click(await screen.findByRole('button', { name: 'Load remote images' }));
    await waitFor(() => expect(iframeCsp()).toMatch(/img-src[^;]*https:/));

    // Same component tree, different message content — as if a list item's
    // key were reused (refreshed body, or a different message rendered in
    // the same position) rather than remounted.
    rerender(
      <MessageDetail
        message={{ ...baseMessage, bodyHtml: '<img src="https://tracker.example/pixel.gif" alt="">' }}
        accounts={[{ id: 'acct-1', name: 'Personal' }]}
        onBack={() => {}}
      />,
    );

    await waitFor(() => expect(iframeCsp()).not.toMatch(/img-src[^;]*https:/));
    expect(await screen.findByText('Remote images blocked')).toBeInTheDocument();
  });

  it('shows no remote-content notice for a body with only inline data: images and plain formatting', async () => {
    renderMessage({
      ...baseMessage,
      bodyHtml: '<p>Hi <b>Bob</b></p><img src="data:image/png;base64,AAAA" alt="">',
    });

    await waitFor(() => expect(iframeCsp()).toContain("default-src 'none'"));
    expect(screen.queryByText('Remote images blocked')).not.toBeInTheDocument();
  });
});

describe('MessageDetail thread load', () => {
  const threaded = { ...baseMessage, threadId: 'thr-1', bodyText: 'Hello body' };

  it('shows a load error with Retry, still shows the message, and loads the thread on retry', async () => {
    api.getMessageThread.mockRejectedValueOnce(new Error('Thread unavailable'));
    renderMessage(threaded);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the conversation — Thread unavailable');
    expect(screen.getByText('Hello body')).toBeTruthy();
    expect(screen.queryByText(/messages$/)).toBeNull();

    api.getMessageThread.mockResolvedValueOnce({ messages: [
      { id: 'm1', from: { name: 'Alice' }, bodyText: 'First', bodyFull: true },
      { id: 'm2', from: { name: 'Bob' }, bodyText: 'Second', bodyFull: true },
    ] });
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Second')).toBeTruthy();
    expect(screen.getByText('2 messages')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});


describe('MessageDetail refresh ordering', () => {
  const threaded = { ...baseMessage, threadId: 'thr-1', bodyText: 'Original message' };
  const fresh = [
    { ...threaded, bodyText: 'Fresh first' },
    { ...threaded, id: 'msg-2', bodyText: 'Fresh second' },
  ];
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getMessageThread.mockResolvedValue({ messages: [] });
    api.refreshMessage.mockResolvedValue(fresh);
  });

  it('supersedes an outstanding thread read after refresh and ignores its late snapshot', async () => {
    const initial = deferred();
    const reconciliation = deferred();
    api.getMessageThread.mockReturnValueOnce(initial.promise).mockReturnValueOnce(reconciliation.promise);
    renderMessage(threaded);
    await waitFor(() => expect(api.getMessageThread).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.getMessageThread).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Fresh second')).toBeInTheDocument();
    await act(async () => reconciliation.resolve({ messages: fresh }));
    expect(screen.getByText('Fresh second')).toBeInTheDocument();
    await act(async () => initial.resolve({ messages: [{ ...threaded, bodyText: 'Stale body' }] }));
    expect(screen.getByText('Fresh second')).toBeInTheDocument();
    expect(screen.queryByText('Stale body')).not.toBeInTheDocument();
  });

  it('keeps confirmed thread content visible with retry after reconciliation failure', async () => {
    const initial = deferred();
    api.getMessageThread.mockReturnValueOnce(initial.promise)
      .mockRejectedValueOnce(new Error('Reconciliation unavailable'))
      .mockResolvedValueOnce({ messages: fresh });
    renderMessage(threaded);
    await waitFor(() => expect(api.getMessageThread).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reconciliation unavailable');
    expect(screen.getByText('Fresh first')).toBeInTheDocument();
    expect(screen.getByText('Fresh second')).toBeInTheDocument();
    expect(screen.getByText('2 messages')).toBeInTheDocument();
    await act(async () => initial.resolve({ messages: [] }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Fresh second')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    { accountId: 'acct-2', threadId: 'thr-1' },
    { accountId: 'acct-1', threadId: 'thr-2' },
  ])('drops refresh completion after switching to $accountId/$threadId', async (identity) => {
    const refresh = deferred();
    api.refreshMessage.mockReturnValueOnce(refresh.promise);
    const { rerender } = renderMessage(threaded);
    expect(await screen.findByText('Original message')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    const next = { ...threaded, ...identity, bodyText: 'Selected thread' };
    rerender(<MessageDetail message={next} accounts={[{ id: next.accountId }]} onBack={() => {}} />);
    expect(await screen.findByText('Selected thread')).toBeInTheDocument();
    await act(async () => refresh.resolve(fresh));
    expect(screen.getByText('Selected thread')).toBeInTheDocument();
    expect(screen.queryByText('Fresh first')).not.toBeInTheDocument();
    expect(screen.queryByText('Fresh second')).not.toBeInTheDocument();
    expect(api.getMessageThread).toHaveBeenCalledTimes(2);
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('updates a ready thread immediately without another list read', async () => {
    api.getMessageThread.mockResolvedValueOnce({ messages: [threaded] });
    renderMessage(threaded);
    expect(await screen.findByText('Original message')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Fresh second')).toBeInTheDocument();
    expect(api.getMessageThread).toHaveBeenCalledTimes(1);
  });
});
