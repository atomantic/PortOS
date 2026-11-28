import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const mocks = vi.hoisted(() => ({
  getVoiceRealtimeStatus: vi.fn(),
  updateVoiceConfig: vi.fn(),
  startRealtimeCall: vi.fn(),
}));

vi.mock('../../services/apiVoice', () => ({
  getVoiceRealtimeStatus: mocks.getVoiceRealtimeStatus,
  updateVoiceConfig: mocks.updateVoiceConfig,
}));
vi.mock('../../services/voiceRealtime', () => ({
  startRealtimeCall: mocks.startRealtimeCall,
}));
vi.mock('./useAvatarRuntime', () => ({
  useAvatarRuntime: () => ({ data: { supported: false }, error: null, updateData: vi.fn(), refetch: vi.fn() }),
}));
vi.mock('./useAvatarLibrary', () => ({
  useAvatarLibrary: () => ({ data: { channels: [], active: 0 } }),
  activeChannelOf: () => null,
  channelLlm: (_ch, provider, model) => ({ provider, model }),
}));
vi.mock('../../hooks/useVoiceLlmResidency', () => ({
  default: () => null,
}));
vi.mock('./SatPhoneHandset', () => ({
  default: () => <div data-testid="satphone-handset" />,
}));
vi.mock('./AvatarRuntimeSettings', () => ({
  default: () => <div data-testid="avatar-runtime-settings" />,
}));
vi.mock('./ChannelBrainPicker', () => ({
  default: () => <div data-testid="channel-brain-picker" />,
}));
vi.mock('./AvatarChannelsPanel', () => ({
  default: () => <div data-testid="avatar-channels-panel" />,
}));

import VoiceCallConsole from './VoiceCallConsole';

describe('VoiceCallConsole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('opens the Realtime voice station tab and mounts RealtimeCallPanel', async () => {
    mocks.getVoiceRealtimeStatus.mockResolvedValue({
      enabled: true,
      installed: true,
      size: '4B',
      home: '/models/sophon',
      parts: { python: true, engine: true, weights: true },
    });
    render(
      <MemoryRouter>
        <VoiceCallConsole
          stage="idle"
          history={[]}
          scrollRef={{ current: null }}
          interimTranscript=""
          capturing={false}
          handsFree={false}
          canChangeMicMode
          hotkey="Space"
          draft=""
          onDraft={vi.fn()}
          onSend={vi.fn()}
          onMic={vi.fn()}
          onMode={vi.fn()}
          onInterrupt={vi.fn()}
          onEnd={vi.fn()}
          onClear={vi.fn()}
          voiceLabel="Piper"
          llmProvider="ollama"
          llmModel="auto"
          onLlmSaved={vi.fn()}
          agentDefaults={{}}
          images={[]}
        />
      </MemoryRouter>,
    );

    const tab = screen.getByRole('button', { name: /Realtime voice/ });
    expect(tab).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(tab);
    expect(tab).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('button', { name: 'Start realtime call' })).toBeInTheDocument();
    expect(screen.queryByTestId('avatar-runtime-settings')).toBeNull();
  });
});
