import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

  it('releases a mic opened after push-to-talk was released', async () => {
    window.location.hash = '#session=sess-123&token=tok-abc';
    let resolveMic;
    const track = { stop: vi.fn() };
    const getUserMedia = vi.fn(() => new Promise((resolve) => { resolveMic = resolve; }));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    const recorder = vi.fn();
    vi.stubGlobal('MediaRecorder', recorder);

    render(<FableLoomHostedJoin />);
    const button = screen.getByRole('button', { name: /hold talk/i });
    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);
    await act(async () => { resolveMic({ getTracks: () => [track] }); });

    expect(track.stop).toHaveBeenCalledOnce();
    expect(recorder).not.toHaveBeenCalled();
    expect(mockSocket.emit).not.toHaveBeenCalledWith('hosted:mic:start');
    vi.unstubAllGlobals();
  });

  it('stops the recorder and tracks on unmount', async () => {
    window.location.hash = '#session=sess-123&token=tok-abc';
    const track = { stop: vi.fn() };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }) },
    });
    const recorder = { state: 'recording', start: vi.fn(), stop: vi.fn(), mimeType: 'audio/webm' };
    vi.stubGlobal('MediaRecorder', class { constructor() { return recorder; } });

    const { unmount } = render(<FableLoomHostedJoin />);
    fireEvent.pointerDown(screen.getByRole('button', { name: /hold talk/i }));
    await waitFor(() => expect(recorder.start).toHaveBeenCalledOnce());
    unmount();

    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('keeps audio chunks separate across two press and release cycles', async () => {
    window.location.hash = '#session=sess-123&token=tok-abc';
    const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
    let streamIndex = 0;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(() => {
        const track = tracks[streamIndex++];
        return Promise.resolve({ getTracks: () => [track] });
      }) },
    });
    const recorders = [];
    vi.stubGlobal('MediaRecorder', class {
      constructor() {
        this.state = 'inactive';
        this.mimeType = 'audio/webm';
        recorders.push(this);
      }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.onstop?.(); }
    });

    render(<FableLoomHostedJoin />);
    const button = screen.getByRole('button', { name: /hold talk/i });
    fireEvent.pointerDown(button);
    await waitFor(() => expect(recorders).toHaveLength(1));
    recorders[0].ondataavailable({ data: new Blob(['first']) });
    fireEvent.pointerUp(button);
    await waitFor(() => expect(mockSocket.emit).toHaveBeenCalledWith('hosted:mic:stop', expect.any(Uint8Array)));

    fireEvent.pointerDown(button);
    await waitFor(() => expect(recorders).toHaveLength(2));
    recorders[1].ondataavailable({ data: new Blob(['second']) });
    fireEvent.pointerUp(button);
    await waitFor(() => expect(mockSocket.emit.mock.calls.filter(([event]) => event === 'hosted:mic:stop')).toHaveLength(2));

    const payloads = mockSocket.emit.mock.calls.filter(([event]) => event === 'hosted:mic:stop').map(([, bytes]) => new TextDecoder().decode(bytes));
    expect(payloads).toEqual(['first', 'second']);
    expect(tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
    vi.unstubAllGlobals();
  });
});
