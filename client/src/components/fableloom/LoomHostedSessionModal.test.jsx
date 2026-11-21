import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoomHostedSessionModal from './LoomHostedSessionModal';
import {
  endHostedLoomSession,
  preflightHostedLoomSession,
  updateHostedLoomSession,
} from '../../services/apiFableLoom.js';

vi.mock('../../services/apiFableLoom.js', () => ({
  preflightHostedLoomSession: vi.fn(),
  createHostedLoomSession: vi.fn(),
  endHostedLoomSession: vi.fn(),
  updateHostedLoomSession: vi.fn(),
}));

describe('LoomHostedSessionModal', () => {
  const mockLoom = { id: 'loom-1', name: 'Story 1' };
  const mockEpisode = { id: 'ep-1', title: 'Episode 1' };

  beforeEach(() => {
    vi.clearAllMocks();
    preflightHostedLoomSession.mockResolvedValue({
      ready: true,
      checks: {
        https: { ok: true },
        host: { ok: true },
        tts: { ok: true, voice: 'default' },
        playback: { ok: true },
      },
      errors: [],
    });
  });

  it('renders preflight check and allows starting session when ready', async () => {
    render(
      <LoomHostedSessionModal
        loom={mockLoom}
        episode={mockEpisode}
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('Hosted Two-Device Play')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Ready for Hosted Play')).toBeInTheDocument();
    });

    const startBtn = screen.getByRole('button', { name: /Start Hosted Session/i });
    expect(startBtn).not.toBeDisabled();
  });

  it('displays QR code and audio target options when session is active', async () => {
    const activeSession = {
      id: 'sess-123',
      status: 'active',
      joinUrl: 'https://host.ts.net:5555/fableloom/join#session=sess-123&token=tok-abc',
    };

    render(
      <LoomHostedSessionModal
        loom={mockLoom}
        episode={mockEpisode}
        isOpen={true}
        activeSession={activeSession}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Character Voice Output')).toBeInTheDocument();
    });

    expect(screen.getByText('Computer Speakers')).toBeInTheDocument();
    expect(screen.getByText('Audience Phone')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /End Hosted Session/i })).toBeInTheDocument();
  });

  it('ends the session and switches audio target after reopening with a nested create response', async () => {
    const user = userEvent.setup();
    const created = {
      session: { id: 'sess-9', audioTarget: 'audience' },
      token: 'aud-tok',
      hostToken: 'host-tok',
      joinUrl: 'https://example.test/fableloom/join#session=sess-9&token=aud-tok',
    };
    const onSessionEnded = vi.fn();
    const onAudioTargetChange = vi.fn();
    updateHostedLoomSession.mockResolvedValue({});
    endHostedLoomSession.mockResolvedValue({});

    // Reopened modal: fresh state, activeSession holds the raw nested response.
    render(
      <LoomHostedSessionModal
        loom={mockLoom}
        episode={mockEpisode}
        isOpen={true}
        activeSession={created}
        onClose={vi.fn()}
        onSessionEnded={onSessionEnded}
        onAudioTargetChange={onAudioTargetChange}
      />
    );

    expect(screen.getByRole('button', { name: /Audience Phone/i }).className).toContain('border-port-accent');

    await user.click(screen.getByRole('button', { name: /Computer Speakers/i }));
    await waitFor(() => expect(updateHostedLoomSession).toHaveBeenCalledWith('sess-9', { audioTarget: 'host' }));
    expect(onAudioTargetChange).toHaveBeenCalledWith('host');

    await user.click(screen.getByRole('button', { name: /End Hosted Session/i }));
    await waitFor(() => expect(endHostedLoomSession).toHaveBeenCalledWith('sess-9'));
    expect(onSessionEnded).toHaveBeenCalled();
  });
});
