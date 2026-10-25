import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const getCharacterLoras = vi.fn();

vi.mock('../../services/api', () => ({
  getCharacterLoras: (...args) => getCharacterLoras(...args),
}));

const mockNavigate = vi.fn();
vi.mock('react-router', () => ({
  useNavigate: () => mockNavigate,
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
}));

import CharacterLoraChip from './CharacterLoraChip';

describe('CharacterLoraChip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCharacterLoras.mockResolvedValue([]);
  });

  it('shows a Retry — not "Train LoRA" — when the LoRA read fails, and stays retired after retry', async () => {
    getCharacterLoras.mockRejectedValueOnce(new Error('Server unavailable'));

    render(
      <CharacterLoraChip
        entryId="char-1"
        universeId="u1"
        showDatasetButton
      />
    );

    await act(async () => {});

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load character LoRAs — Server unavailable');
    expect(screen.queryByRole('button', { name: /Train LoRA/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /LoRA/i })).toBeNull();

    getCharacterLoras.mockResolvedValueOnce([]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: /Train LoRA/i })).toBeNull();
  });

  it('preserves the inference adapter link without a training entry point', async () => {
    getCharacterLoras.mockResolvedValueOnce([
      { filename: 'alice.safetensors', triggerWords: ['alice_lora'] },
    ]);

    render(
      <CharacterLoraChip
        entryId="char-1"
        universeId="u1"
        showDatasetButton
      />
    );

    await act(async () => {});

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('LoRA · alice_lora')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Dataset/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Train LoRA/i })).toBeNull();
  });
});
