import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  listTimelineProjects: vi.fn(),
  listVideoHistory: vi.fn(),
  createTimelineProject: vi.fn(),
  deleteTimelineProject: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import VideoTimeline from './VideoTimeline.jsx';
import { listTimelineProjects, listVideoHistory } from '../services/api';

describe('VideoTimeline page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listTimelineProjects.mockResolvedValue([]);
    listVideoHistory.mockResolvedValue([]);
  });

  it('renders ListLoadError with retry on failed timeline projects load', async () => {
    listTimelineProjects.mockRejectedValueOnce(new Error('Projects 500 error'));
    render(
      <MemoryRouter>
        <VideoTimeline />
      </MemoryRouter>
    );
    await act(async () => {});

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load timeline projects — Projects 500 error');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(/No timeline projects yet/)).not.toBeInTheDocument();

    listTimelineProjects.mockResolvedValueOnce([]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/No timeline projects yet/)).toBeInTheDocument();
  });

  it('renders ListLoadError on failed video history load', async () => {
    listVideoHistory.mockRejectedValueOnce(new Error('History 500 error'));
    render(
      <MemoryRouter>
        <VideoTimeline />
      </MemoryRouter>
    );
    await act(async () => {});

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load video history — History 500 error');
  });

  it('renders projects and duration when loaded', async () => {
    listTimelineProjects.mockResolvedValueOnce([
      { id: 'proj-1', name: 'Cyberpunk Chase', clips: [{ id: 'clip-1', durationSec: 10 }] },
    ]);
    render(
      <MemoryRouter>
        <VideoTimeline />
      </MemoryRouter>
    );
    await act(async () => {});

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Cyberpunk Chase')).toBeInTheDocument();
    expect(screen.queryByText(/No timeline projects yet/)).not.toBeInTheDocument();
  });
});
