import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FableLoomHostedJoin from './FableLoomHostedJoin';

// Mock socket.io-client
const mockSocket = {
  on: vi.fn(),
  emit: vi.fn(),
  disconnect: vi.fn(),
};

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => mockSocket),
}));

describe('FableLoomHostedJoin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });

  it('renders error when hash credentials are missing', () => {
    window.location.hash = '';
    render(<FableLoomHostedJoin />);
    expect(screen.getByText('Hosted Play Error')).toBeInTheDocument();
    expect(screen.getByText(/Invalid or missing join credentials/i)).toBeInTheDocument();

    const shell = screen.getByRole('main');
    expect(shell).toContainElement(screen.getByRole('heading', { name: 'Hosted Play Error' }));
    expect(shell).toHaveClass('h-dvh-screen');
    expect(shell).not.toHaveClass('min-h-screen');
  });

  it('connects to /fableloom-hosted when hash credentials are provided', async () => {
    window.location.hash = '#session=sess-123&token=tok-abc';
    const { io } = await import('socket.io-client');

    render(<FableLoomHostedJoin />);

    expect(io).toHaveBeenCalledWith('/fableloom-hosted', expect.objectContaining({
      auth: { sessionId: 'sess-123', token: 'tok-abc', role: 'audience' },
    }));

    expect(screen.getByText('FableLoom Play')).toBeInTheDocument();
    expect(screen.getByText('Audience Microphone UI')).toBeInTheDocument();
  });

  it('keeps the transcript as the only inner scroll region of the dynamic shell', () => {
    window.location.hash = '#session=sess-123&token=tok-abc';
    render(<FableLoomHostedJoin />);

    const shell = screen.getByRole('main');
    expect(shell).toHaveClass('h-dvh-screen', 'overflow-y-auto');
    expect(shell).not.toHaveClass('overflow-hidden');
    expect(shell).not.toHaveClass('min-h-screen');

    const scrollRegions = shell.querySelectorAll('.overflow-y-auto');
    expect(scrollRegions).toHaveLength(1);
    expect(scrollRegions[0]).toHaveClass('flex-1', 'min-h-[8rem]');
    const header = shell.querySelector('header');
    expect(header).toHaveClass('shrink-0');
    expect(header.nextElementSibling).toHaveClass('shrink-0');
    expect(screen.getByPlaceholderText('Or type a message…').closest('form').parentElement).toHaveClass('shrink-0');
  });

  it('sends text input fallback when submitted', async () => {
    window.location.hash = '#session=sess-123&token=tok-abc';
    render(<FableLoomHostedJoin />);

    const input = screen.getByPlaceholderText('Or type a message…');
    fireEvent.change(input, { target: { value: 'Look around the room' } });

    const sendButton = screen.getByRole('button', { name: 'Send message' });
    expect(sendButton).toBeInTheDocument();
    expect(sendButton).toHaveClass(
      'min-w-[44px]',
      'min-h-[44px]',
      'flex',
      'items-center',
      'justify-center',
    );
    fireEvent.submit(input.closest('form'));

    expect(mockSocket.emit).toHaveBeenCalledWith('hosted:turn:text', { text: 'Look around the room' });
  });
});
