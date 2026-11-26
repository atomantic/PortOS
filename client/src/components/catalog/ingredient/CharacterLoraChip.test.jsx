import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const getCharacterLoras = vi.fn();

vi.mock('../../../services/apiImageVideo.js', () => ({
  getCharacterLoras: (...args) => getCharacterLoras(...args),
}));

import CharacterLoraChip from './CharacterLoraChip';

describe('CharacterLoraChip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCharacterLoras.mockResolvedValue([]);
  });

  it('shows a Retry — not "Train LoRA" — when the LoRA read fails, and stays retired after retry', async () => {
    getCharacterLoras.mockRejectedValueOnce(new Error('Server unavailable'));

    render(<MemoryRouter><CharacterLoraChip ingredientId="example-character" /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load character LoRAs — Server unavailable');
    expect(screen.queryByRole('button', { name: /Train LoRA/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /LoRA/i })).toBeNull();

    getCharacterLoras.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByRole('button', { name: /Train LoRA/i })).toBeNull();
  });

  it('preserves the inference adapter link without a training entry point', async () => {
    getCharacterLoras.mockResolvedValueOnce([
      { filename: 'alice.safetensors', triggerWords: ['alice_lora'] },
    ]);

    render(<MemoryRouter><CharacterLoraChip ingredientId="example-character" /></MemoryRouter>);

    expect(await screen.findByRole('link', { name: 'LoRA · alice_lora' })).toHaveAttribute('href', '/models/loras');
    expect(getCharacterLoras).toHaveBeenCalledWith({ entryId: undefined, ingredientId: 'example-character' }, { silent: true });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: /Dataset/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Train LoRA/i })).toBeNull();
  });
});
