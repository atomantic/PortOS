import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import LoomHostedSessionModal from './LoomHostedSessionModal';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({
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
    api.preflightHostedLoomSession.mockResolvedValue({
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
});
