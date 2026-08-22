import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/api', () => ({
  listLooms: vi.fn(),
  createLoom: vi.fn(),
}));

const navigate = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => navigate };
});

import * as api from '../../services/api';
import SeriesLoomsPanel, { deriveLoomName } from './SeriesLoomsPanel';

const series = { id: 'ser-1', name: 'Example Series', universeId: 'uni-1', logline: 'A quiet town keeps a loud secret.' };

const summary = {
  id: 'loom-1',
  name: 'Example Series — branching narrative',
  logline: 'A quiet town keeps a loud secret.',
  seriesId: 'ser-1',
  updatedAt: '2026-08-20T00:00:00Z',
  episodeCount: 1,
  sceneCount: 4,
  endingCount: 2,
};

const renderPanel = (props = {}) =>
  render(<MemoryRouter><SeriesLoomsPanel series={series} {...props} /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  api.listLooms.mockResolvedValue([summary]);
});

describe('SeriesLoomsPanel', () => {
  it('lists the series-scoped looms with their counts and a link to the editor', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText('Example Series — branching narrative')).toBeInTheDocument());
    expect(api.listLooms).toHaveBeenCalledWith({ seriesId: 'ser-1', silent: true });
    expect(screen.getByText('1 episode')).toBeInTheDocument();
    expect(screen.getByText('4 scenes')).toBeInTheDocument();
    expect(screen.getByText('2 endings')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Example Series — branching narrative/ }))
      .toHaveAttribute('href', '/fableloom/loom-1');
  });

  it('shows an empty state when nothing links to the series', async () => {
    api.listLooms.mockResolvedValue([]);
    renderPanel();
    await waitFor(() => expect(screen.getByText(/None yet/)).toBeInTheDocument());
  });

  it('degrades to the empty state when the list fetch fails', async () => {
    api.listLooms.mockRejectedValue(new Error('offline'));
    renderPanel();
    await waitFor(() => expect(screen.getByText(/None yet/)).toBeInTheDocument());
  });

  it('creates a loom pre-linked to the series and its universe, then opens the editor', async () => {
    api.createLoom.mockResolvedValue({ id: 'loom-9' });
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByText('Example Series — branching narrative')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /New branching narrative/ }));
    await waitFor(() => expect(api.createLoom).toHaveBeenCalledWith({
      name: 'Example Series — branching narrative',
      logline: 'A quiet town keeps a loud secret.',
      universeId: 'uni-1',
      seriesId: 'ser-1',
    }, { silent: true }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/fableloom/loom-9'));
  });

  it('passes null (not an empty string) for a series with no universe', async () => {
    api.listLooms.mockResolvedValue([]);
    api.createLoom.mockResolvedValue({ id: 'loom-9' });
    const user = userEvent.setup();
    renderPanel({ series: { id: 'ser-2', name: 'Bare Series' } });
    await waitFor(() => expect(screen.getByText(/None yet/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /New branching narrative/ }));
    await waitFor(() => expect(api.createLoom).toHaveBeenCalledWith(
      expect.objectContaining({ universeId: null, seriesId: 'ser-2' }),
      { silent: true },
    ));
  });

  it('renders nothing without a series id', () => {
    const { container } = render(<MemoryRouter><SeriesLoomsPanel series={null} /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
    expect(api.listLooms).not.toHaveBeenCalled();
  });
});

describe('deriveLoomName', () => {
  it('suffixes the series name and clamps to the server name cap', () => {
    expect(deriveLoomName('Example Series')).toBe('Example Series — branching narrative');
    expect(deriveLoomName('  ')).toBe('Untitled series — branching narrative');
    expect(deriveLoomName('x'.repeat(400))).toHaveLength(200);
  });
});
