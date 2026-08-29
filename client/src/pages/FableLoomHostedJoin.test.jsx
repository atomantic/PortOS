import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

  it('sends text input fallback when submitted', async () => {
    window.location.hash = '#session=sess-123&token=tok-abc';
    render(<FableLoomHostedJoin />);

    const input = screen.getByPlaceholderText('Or type a message…');
    fireEvent.change(input, { target: { value: 'Look around the room' } });

    const submitBtn = screen.getByRole('button', { name: '' }); // Send button
    fireEvent.submit(input.closest('form'));

    expect(mockSocket.emit).toHaveBeenCalledWith('hosted:turn:text', { text: 'Look around the room' });
  });
});
