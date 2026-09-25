import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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

  it('shows no remote-content notice for a body with only inline data: images and plain formatting', async () => {
    renderMessage({
      ...baseMessage,
      bodyHtml: '<p>Hi <b>Bob</b></p><img src="data:image/png;base64,AAAA" alt="">',
    });

    await waitFor(() => expect(iframeCsp()).toContain("default-src 'none'"));
    expect(screen.queryByText('Remote images blocked')).not.toBeInTheDocument();
  });
});
