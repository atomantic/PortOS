import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { createVoiceDesignCandidate } from '../../../services/apiVoice';
import VoiceProfileSection from './VoiceProfileSection';

vi.mock('../../../services/apiVoice', () => ({
  createVoiceDesignCandidate: vi.fn().mockResolvedValue({}),
  listVoiceEngines: vi.fn().mockResolvedValue({ engines: [] }),
  listVoiceProfiles: vi.fn().mockResolvedValue({ profiles: [] }),
}));

it('keeps the last seed while cleared and sends zero when entered', async () => {
  render(
    <MemoryRouter>
      <VoiceProfileSection universeId="universe-1" entry={{ id: 'character-1' }} />
    </MemoryRouter>,
  );

  await act(async () => {});
  fireEvent.click(screen.getByRole('tab', { name: 'Design' }));
  const seed = screen.getByRole('spinbutton', { name: 'Seed' });
  const submit = screen.getByRole('button', { name: 'Design Candidate Voice' });

  fireEvent.change(seed, { target: { value: '' } });
  expect(seed).toHaveValue(null);
  await act(async () => { fireEvent.click(submit); });
  expect(createVoiceDesignCandidate).toHaveBeenNthCalledWith(1, expect.objectContaining({ seed: 42 }), { silent: true });

  fireEvent.change(seed, { target: { value: '0' } });
  expect(seed).toHaveValue(0);
  await act(async () => { fireEvent.click(submit); });
  expect(createVoiceDesignCandidate).toHaveBeenNthCalledWith(2, expect.objectContaining({ seed: 0 }), { silent: true });
});
