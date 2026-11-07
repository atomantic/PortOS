import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import WhatsappImportPanel from './WhatsappImportPanel';

const api = vi.hoisted(() => ({ importWhatsappHistory: vi.fn() }));
vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const summary = { messages: 1, uniqueSenders: 1, from: '2024-03-04T18:30:00.000Z', to: '2024-03-04T18:30:00.000Z', topSenders: [] };
const preview = (extra) => ({ dryRun: true, mapped: 1, summary, ...extra });

const openAndPreview = async () => {
  render(<WhatsappImportPanel />);
  fireEvent.click(screen.getByRole('button', { name: /Import WhatsApp chat/ }));
  const input = document.querySelector('input[type="file"]');
  fireEvent.change(input, { target: { files: [new File(['x'], 'chat.txt', { type: 'text/plain' })] } });
  const previewBtn = await screen.findByRole('button', { name: 'Preview' });
  await act(async () => { fireEvent.click(previewBtn); });
};

beforeEach(() => vi.clearAllMocks());

it('offers no order choice for an unambiguous preview', async () => {
  api.importWhatsappHistory.mockResolvedValue(preview({ dateOrderAmbiguous: false }));
  await openAndPreview();
  await screen.findByRole('button', { name: /Import 1 message/ });
  expect(screen.queryByRole('radio')).toBeNull();
});

it('blocks import until an order is picked, then sends it only on commit', async () => {
  api.importWhatsappHistory.mockResolvedValueOnce(preview({
    dateOrderAmbiguous: true,
    dateOrderSamples: { mdy: { from: '2024-03-04T18:30:00.000Z', to: '2024-03-04T18:30:00.000Z' }, dmy: { from: '2024-04-03T18:30:00.000Z', to: '2024-04-03T18:30:00.000Z' } },
  }));
  await openAndPreview();
  await screen.findAllByRole('radio');
  expect(screen.queryByRole('button', { name: /Import 1 message/ })).toBeNull();
  expect(api.importWhatsappHistory.mock.calls[0][1].dateOrder).toBeUndefined();

  fireEvent.click(screen.getByLabelText(/Day first/));
  api.importWhatsappHistory.mockResolvedValueOnce({ recorded: 1, skipped: 0 });
  const importBtn = await screen.findByRole('button', { name: /Import 1 message/ });
  await act(async () => { fireEvent.click(importBtn); });
  await waitFor(() => expect(api.importWhatsappHistory).toHaveBeenCalledTimes(2));
  expect(api.importWhatsappHistory.mock.calls[1][1]).toMatchObject({ preview: false, dateOrder: 'dmy' });
});
