import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getCosWeeklyDigest: vi.fn(), getCosWeekProgress: vi.fn(), listCosWeeklyDigests: vi.fn(), generateCosDigest: vi.fn(),
}));
vi.mock('../../../services/api', () => api);

import DigestTab from './DigestTab';

describe('CoS DigestTab loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCosWeekProgress.mockResolvedValue(null);
    api.listCosWeeklyDigests.mockResolvedValue({ digests: [] });
  });

  it('shows a retryable failure after a rejected primary load, then keeps empty success distinct', async () => {
    api.getCosWeeklyDigest.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null);
    render(<DigestTab />);

    expect(await screen.findByText('Could not load weekly digest data.')).toBeInTheDocument();
    expect(screen.queryByText(/Complete some tasks and generate a digest/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No digest data available yet.')).toBeInTheDocument();
  });

  it('keeps the chosen week selected and offers retry when that week fails to load', async () => {
    api.getCosWeeklyDigest.mockResolvedValueOnce({
      weekId: '2026-W40', summary: { totalTasks: 41 }, weekOverWeek: {},
    });
    api.listCosWeeklyDigests.mockResolvedValue({ digests: [
      { weekId: '2026-W40', totalTasks: 1 }, { weekId: '2026-W39', totalTasks: 2 },
    ] });
    render(<DigestTab />);
    const week = await screen.findByRole('combobox', { name: 'Week' });
    api.getCosWeeklyDigest.mockRejectedValueOnce(new Error('offline'));
    fireEvent.change(week, { target: { value: '2026-W39' } });

    expect(await screen.findByText('Could not load weekly digest data.')).toBeInTheDocument();
    expect(week).toHaveValue('2026-W39');
    expect(screen.queryByText('41')).not.toBeInTheDocument();

    api.getCosWeeklyDigest.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No digest data available yet.')).toBeInTheDocument();
    expect(api.getCosWeeklyDigest).toHaveBeenLastCalledWith('2026-W39');
  });

  it('keeps the latest selected week when earlier requests resolve out of order', async () => {
    let resolveFirst;
    let resolveSecond;
    api.getCosWeeklyDigest.mockResolvedValueOnce({ weekId: '2026-W40', summary: {}, weekOverWeek: {} });
    api.listCosWeeklyDigests.mockResolvedValue({ digests: [
      { weekId: '2026-W40', totalTasks: 1 }, { weekId: '2026-W39', totalTasks: 2 },
    ] });
    render(<DigestTab />);
    const week = await screen.findByRole('combobox', { name: 'Week' });
    api.getCosWeeklyDigest
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));

    fireEvent.change(week, { target: { value: '2026-W39' } });
    fireEvent.change(week, { target: { value: '2026-W40' } });
    await act(async () => {
      resolveSecond({ weekId: '2026-W40', summary: { totalTasks: 40 }, weekOverWeek: {} });
    });
    expect(await screen.findByText('40')).toBeInTheDocument();
    await act(async () => {
      resolveFirst({ weekId: '2026-W39', summary: { totalTasks: 39 }, weekOverWeek: {} });
    });

    expect(await screen.findByText('40')).toBeInTheDocument();
    expect(screen.queryByText('39')).not.toBeInTheDocument();
    expect(week).toHaveValue('2026-W40');
  });

  it('returns to the refreshed current week after generation when selection has not changed', async () => {
    api.getCosWeeklyDigest
      .mockResolvedValueOnce({ weekId: '2026-W40', summary: { totalTasks: 40 }, weekOverWeek: {} })
      .mockResolvedValueOnce({ weekId: '2026-W39', summary: { totalTasks: 39 }, weekOverWeek: {} })
      .mockResolvedValueOnce({ weekId: '2026-W41', summary: { totalTasks: 41 }, weekOverWeek: {} });
    api.listCosWeeklyDigests
      .mockResolvedValueOnce({ digests: [
        { weekId: '2026-W40', totalTasks: 40 }, { weekId: '2026-W39', totalTasks: 39 },
      ] })
      .mockResolvedValueOnce({ digests: [
        { weekId: '2026-W41', totalTasks: 41 }, { weekId: '2026-W40', totalTasks: 40 },
      ] });
    api.generateCosDigest.mockResolvedValue({ weekId: '2026-W41', summary: { totalTasks: 41 }, weekOverWeek: {} });
    render(<DigestTab />);
    const week = await screen.findByRole('combobox', { name: 'Week' });
    fireEvent.change(week, { target: { value: '2026-W39' } });
    expect(await screen.findByText('39')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh Digest' }));

    expect(await screen.findByText('41')).toBeInTheDocument();
    expect(week).toHaveValue('2026-W41');
    expect(api.getCosWeeklyDigest).toHaveBeenLastCalledWith();
  });

  it('keeps a week selected by the user while generation is in flight', async () => {
    let finishGeneration;
    api.getCosWeeklyDigest
      .mockResolvedValueOnce({ weekId: '2026-W40', summary: {}, weekOverWeek: {} })
      .mockResolvedValueOnce({ weekId: '2026-W39', summary: { totalTasks: 39 }, weekOverWeek: {} })
      .mockResolvedValueOnce({ weekId: '2026-W39', summary: { totalTasks: 390 }, weekOverWeek: {} });
    api.listCosWeeklyDigests.mockResolvedValue({ digests: [
      { weekId: '2026-W40', totalTasks: 40 }, { weekId: '2026-W39', totalTasks: 39 },
    ] });
    api.generateCosDigest.mockImplementationOnce(() => new Promise(resolve => { finishGeneration = resolve; }));
    render(<DigestTab />);
    const week = await screen.findByRole('combobox', { name: 'Week' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Digest' }));
    fireEvent.change(week, { target: { value: '2026-W39' } });
    await waitFor(() => expect(week).toHaveValue('2026-W39'));
    await waitFor(() => expect(api.getCosWeeklyDigest).toHaveBeenLastCalledWith('2026-W39'));
    expect(screen.getByText('39')).toBeInTheDocument();

    await act(async () => {
      finishGeneration({ weekId: '2026-W41', summary: { totalTasks: 41 }, weekOverWeek: {} });
    });

    expect(api.getCosWeeklyDigest).toHaveBeenLastCalledWith('2026-W39');
    expect(week).toHaveValue('2026-W39');
    expect(screen.getByText('390')).toBeInTheDocument();
  });
});
