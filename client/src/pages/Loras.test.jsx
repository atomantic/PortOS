/**
 * Delete-confirmation tests for the installed-LoRA cards (#3519). A LoRA is a
 * multi-gigabyte file with no undo, so the trash icon must only arm an inline
 * confirm pair — one stray tap can never reach deleteLoraFull.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import Loras from './Loras';
import { listLorasFull, deleteLoraFull, installLoraFromHuggingfaceStream } from '../services/api';

vi.mock('../services/api', () => ({
  listLorasFull: vi.fn(),
  installLoraFromCivitai: vi.fn(),
  installLoraFromHuggingfaceStream: vi.fn(),
  deleteLoraFull: vi.fn(),
  getCivitaiAuth: vi.fn(async () => ({ hasKey: false, source: 'none' })),
  setCivitaiAuth: vi.fn(),
  clearCivitaiAuth: vi.fn(),
  getCivitaiSuggestions: vi.fn(async () => ({ runners: {}, video: [], fetchedAt: null })),
  searchCivitaiLoras: vi.fn(),
}));

vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const LORA = {
  filename: 'example-lora.safetensors',
  name: 'Example LoRA',
  runnerFamily: 'mflux',
  sizeBytes: 1234567,
  recommendedScale: 0.9,
  triggerWords: [],
};
const OTHER_LORA = { ...LORA, filename: 'second-lora.safetensors', name: 'Second LoRA' };

const renderPage = () => render(<MemoryRouter><Loras /></MemoryRouter>);

describe('Loras installed-card delete confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listLorasFull.mockResolvedValue([LORA]);
    deleteLoraFull.mockResolvedValue({});
  });

  it('arms an inline confirm instead of deleting on the first trash click', async () => {
    renderPage();
    const trash = await screen.findByLabelText('Delete Example LoRA');

    fireEvent.click(trash);

    expect(deleteLoraFull).not.toHaveBeenCalled();
    expect(screen.getByText('Delete file?')).toBeInTheDocument();
    expect(screen.queryByLabelText('Delete Example LoRA')).not.toBeInTheDocument();
  });

  it('deletes and drops the card from local state once confirmed', async () => {
    renderPage();
    fireEvent.click(await screen.findByLabelText('Delete Example LoRA'));

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteLoraFull).toHaveBeenCalledWith('example-lora.safetensors', { silent: true }));
    await waitFor(() => expect(screen.queryByText('Example LoRA')).not.toBeInTheDocument());
    // Reactive local-state update, not a refetch.
    expect(listLorasFull).toHaveBeenCalledTimes(1);
  });

  it('leaves the model file intact when the confirm is cancelled', async () => {
    renderPage();
    fireEvent.click(await screen.findByLabelText('Delete Example LoRA'));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(deleteLoraFull).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete file?')).not.toBeInTheDocument();
    expect(await screen.findByLabelText('Delete Example LoRA')).toBeInTheDocument();
  });

  it('arms only one card at a time', async () => {
    listLorasFull.mockResolvedValue([LORA, OTHER_LORA]);
    renderPage();

    fireEvent.click(await screen.findByLabelText('Delete Example LoRA'));
    fireEvent.click(screen.getByLabelText('Delete Second LoRA'));

    expect(screen.getAllByText('Delete file?')).toHaveLength(1);
    expect(screen.getByLabelText('Delete Example LoRA')).toBeInTheDocument();
    expect(deleteLoraFull).not.toHaveBeenCalled();
  });

  it('falls back to the filename when a sidecar-less LoRA has no name', async () => {
    listLorasFull.mockResolvedValue([{ ...LORA, name: undefined }]);
    renderPage();

    const trash = await screen.findByLabelText('Delete example-lora.safetensors');
    fireEvent.click(trash);

    expect(screen.getByLabelText('Confirm delete example-lora.safetensors')).toBeInTheDocument();
  });

  it('keeps the card when the delete fails, re-showing the trash affordance', async () => {
    deleteLoraFull.mockRejectedValue(new Error('Delete failed'));
    renderPage();
    fireEvent.click(await screen.findByLabelText('Delete Example LoRA'));

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteLoraFull).toHaveBeenCalled());
    expect(await screen.findByLabelText('Delete Example LoRA')).toBeInTheDocument();
    expect(screen.getByText('Example LoRA')).toBeInTheDocument();
  });
});

describe('Loras HuggingFace family picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listLorasFull.mockResolvedValue([]);
    installLoraFromHuggingfaceStream.mockRejectedValue(
      Object.assign(new Error('could not classify'), { code: 'HF_UNKNOWN_FAMILY' }),
    );
  });

  it('offers image and video families when autodetection fails, not just LTX-Video', async () => {
    renderPage();
    const input = await screen.findByLabelText('HuggingFace LoRA URL');
    fireEvent.change(input, { target: { value: 'https://huggingface.co/Alissonerdx/CharacterSheet' } });
    fireEvent.submit(input.closest('form'));
    expect(await screen.findByRole('button', { name: 'Install as Flux 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install as Flux 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install as LTX-Video' })).toBeInTheDocument();
    expect(screen.queryByText(/Install it as an LTX-Video LoRA/)).not.toBeInTheDocument();
  });
});
