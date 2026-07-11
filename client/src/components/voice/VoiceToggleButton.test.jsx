import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getVoiceConfig: vi.fn(),
  onVoiceEvent: vi.fn(() => () => {}),
  readVoiceHidden: vi.fn(() => true),
  writeVoiceHidden: vi.fn(),
}));

vi.mock('../../services/apiVoice', () => ({ getVoiceConfig: mocks.getVoiceConfig }));
vi.mock('../../services/voiceClient', () => ({ onVoiceEvent: mocks.onVoiceEvent }));
vi.mock('../../services/voiceVisibility', () => ({
  VISIBILITY_EVENT: 'portos:voice-visibility',
  ENGAGE_EVENT: 'portos:voice-engage',
  DISENGAGE_EVENT: 'portos:voice-disengage',
  readVoiceHidden: mocks.readVoiceHidden,
  writeVoiceHidden: mocks.writeVoiceHidden,
  isVoiceHiddenStorageEvent: () => false,
}));

import VoiceToggleButton from './VoiceToggleButton';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getVoiceConfig.mockResolvedValue({ enabled: true });
  mocks.readVoiceHidden.mockReturnValue(true);
});

describe('VoiceToggleButton — persistent mobile touch target', () => {
  it('stays at least 44px until the desktop layout while keeping the icon compact', async () => {
    render(<VoiceToggleButton />);

    const button = await screen.findByRole('button', { name: 'Engage voice agent controls' });
    expect(button.className).toContain('min-w-[44px]');
    expect(button.className).toContain('min-h-[44px]');
    expect(button.className).toContain('lg:min-w-0');
    expect(button.className).toContain('lg:min-h-0');
    expect(button.className).not.toContain('sm:min-w-0');
    expect(button.className).not.toContain('sm:min-h-0');

    const icon = button.querySelector('svg');
    expect(icon).toHaveAttribute('width', '18');
    expect(icon).toHaveAttribute('height', '18');
  });
});
