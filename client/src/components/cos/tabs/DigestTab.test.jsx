import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getCosWeeklyDigest: vi.fn(), getCosWeekProgress: vi.fn(), listCosWeeklyDigests: vi.fn(), generateCosDigest: vi.fn(),
}));
vi.mock('../../../services/apiAgents.js', () => ({
  getCosWeeklyDigest: api.getCosWeeklyDigest,
  getCosWeekProgress: api.getCosWeekProgress,
  listCosWeeklyDigests: api.listCosWeeklyDigests,
  generateCosDigest: api.generateCosDigest,
}));

import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import DigestTab from './DigestTab';

const LocationProbe = () => {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="search">{location.search}</output>
      <button onClick={() => navigate(-1)}>history-back</button>
    </>
  );
};
const renderTab = (entry = '/cos/digest') => render(
  <MemoryRouter initialEntries={[entry]}><DigestTab /><LocationProbe /></MemoryRouter>
);

describe('CoS DigestTab loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCosWeekProgress.mockResolvedValue(null);
    api.listCosWeeklyDigests.mockResolvedValue({ digests: [] });
  });

  it('shows a retryable failure after a rejected primary load, then keeps empty success distinct', async () => {
    api.getCosWeeklyDigest.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null);
    renderTab();

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
    renderTab();
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
    renderTab();
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
    renderTab();
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
    renderTab();
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

describe('CoS DigestTab ?week= deep link', () => {
  const digests = [{ weekId: '2026-W40', totalTasks: 1 }, { weekId: '2026-W39', totalTasks: 2 }];
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCosWeekProgress.mockResolvedValue(null);
    api.listCosWeeklyDigests.mockResolvedValue({ digests });
    api.getCosWeeklyDigest.mockImplementation(async (weekId = '2026-W40') => (
      { weekId, summary: { totalTasks: weekId === '2026-W39' ? 39 : 40 }, weekOverWeek: {} }
    ));
  });

  it('restores the week from the URL on load', async () => {
    renderTab('/cos/digest?week=2026-W39');
    expect(await screen.findByText('39')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Week' })).toHaveValue('2026-W39');
    expect(api.getCosWeeklyDigest).toHaveBeenCalledWith('2026-W39');
  });

  it('pushes the selected week to the URL and Back returns to the latest week', async () => {
    renderTab();
    const week = await screen.findByRole('combobox', { name: 'Week' });
    expect(await screen.findByText('40')).toBeInTheDocument();
    fireEvent.change(week, { target: { value: '2026-W39' } });
    expect(await screen.findByText('39')).toBeInTheDocument();
    expect(screen.getByTestId('search')).toHaveTextContent('?week=2026-W39');

    fireEvent.click(screen.getByRole('button', { name: 'history-back' }));
    expect(await screen.findByText('40')).toBeInTheDocument();
    expect(screen.getByTestId('search')).toHaveTextContent('');
    expect(screen.getByRole('combobox', { name: 'Week' })).toHaveValue('2026-W40');
  });

  it('clears ?week= when the digest is regenerated', async () => {
    api.generateCosDigest.mockResolvedValue({ weekId: '2026-W40', summary: { totalTasks: 40 }, weekOverWeek: {} });
    renderTab('/cos/digest?week=2026-W39');
    await screen.findByText('39');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Digest' }));
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent(/^$/));
    expect(await screen.findByText('40')).toBeInTheDocument();
  });
});

it('reports digest disclosure state and names the task-type table', async () => {
  api.getCosWeekProgress.mockResolvedValue(null);
  api.listCosWeeklyDigests.mockResolvedValue({ digests: [] });
  api.getCosWeeklyDigest.mockResolvedValue({
    weekId: '2026-W40',
    summary: {},
    weekOverWeek: {},
    insights: [{ title: 'Example insight' }],
    accomplishments: [{ description: 'Example result', taskType: 'example-task', duration: 60000 }],
    byTaskType: [{ type: 'example-task', completed: 1, successRate: 100, totalDurationMs: 60000 }],
    issues: [{ error: 'Example error', count: 1 }],
  });
  renderTab();
  await screen.findByRole('button', { name: /^Insights/ });

  for (const [name, initiallyExpanded] of [
    [/^Insights/, true],
    [/^Top Accomplishments/, true],
    [/^By Task Type/, false],
    [/^Error Patterns/, true],
  ]) {
    const button = screen.getByRole('button', { name });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-expanded', String(initiallyExpanded));
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', String(!initiallyExpanded));
  }

  const table = within(screen.getByRole('table', { name: 'By Task Type' }));
  const columns = table.getAllByRole('columnheader');
  expect(columns).toHaveLength(4);
  columns.forEach(column => expect(column).toHaveAttribute('scope', 'col'));
  expect(table.getByRole('rowheader', { name: 'example-task' })).toHaveAttribute('scope', 'row');
});
