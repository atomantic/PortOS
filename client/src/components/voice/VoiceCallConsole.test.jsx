import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('./SatPhoneHandset', () => ({ default: () => null }));
vi.mock('./AvatarRuntimeSettings', () => ({ default: () => <div>avatar settings</div> }));
vi.mock('./AvatarChannelsPanel', () => ({ default: () => null }));
vi.mock('./ChannelBrainPicker', () => ({ default: () => null }));
vi.mock('./VoiceImageChips', () => ({ default: () => null }));
vi.mock('./RealtimeCallPanel', () => ({ default: () => <div>realtime panel</div> }));
vi.mock('./useAvatarRuntime', () => ({ useAvatarRuntime: () => ({ data: null, error: null, updateData: vi.fn(), refetch: vi.fn() }) }));
vi.mock('./useAvatarLibrary', () => ({
  useAvatarLibrary: () => ({ data: null }),
  activeChannelOf: () => null,
  channelLlm: (_c, provider, model) => ({ provider, model }),
}));
vi.mock('../../hooks/useVoiceLlmResidency', () => ({ default: () => null }));

import VoiceCallConsole from './VoiceCallConsole';

describe('VoiceCallConsole station chips', () => {
  it('opens the realtime voice panel from its own chip', () => {
    render(<VoiceCallConsole history={[]} llmProvider="ollama" llmModel="auto" />);
    fireEvent.click(screen.getByRole('button', { name: /Realtime voice/ }));
    expect(screen.getByText('realtime panel')).toBeInTheDocument();
    expect(screen.queryByText('avatar settings')).toBeNull();
  });
});
