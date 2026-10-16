import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const api = vi.hoisted(() => ({ getGsdProjects: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: Object.assign(vi.fn(), toast) }));
vi.mock('./GsdProjectCard', () => ({ default: ({ project }) => <div>{project.appId}</div> }));

const GsdTab = (await import('./GsdTab')).default;

describe('GsdTab load failure (#10279)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('says the load failed rather than claiming no projects, and retries', async () => {
    api.getGsdProjects.mockRejectedValueOnce(new Error('offline'));
    api.getGsdProjects.mockResolvedValueOnce({ projects: [] });
    render(<GsdTab />);

    expect(await screen.findByText('Could not load Get Stuff Done projects.')).toBeInTheDocument();
    expect(screen.queryByText('No Get Stuff Done projects found')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No Get Stuff Done projects found')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Get Stuff Done projects' })).toBeInTheDocument();
  });

  it('does not report a successful refresh when the reload fails', async () => {
    api.getGsdProjects.mockResolvedValueOnce({ projects: [] }).mockRejectedValueOnce(new Error('offline'));
    render(<GsdTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('Could not load Get Stuff Done projects.')).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalledWith('GSD data refreshed');
  });
});
