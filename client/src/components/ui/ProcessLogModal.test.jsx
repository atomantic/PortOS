import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  getProcessesList: vi.fn(),
  getProcessLogs: vi.fn(),
}));

import { getProcessesList, getProcessLogs } from '../../services/api';
import ProcessLogModal from './ProcessLogModal';

describe('ProcessLogModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProcessesList.mockResolvedValue([{ name: 'portos-server' }, { name: 'portos-cos' }]);
    getProcessLogs.mockResolvedValue({ processName: 'portos-server', lines: 200, logs: 'boot ok\nerror: boom' });
  });

  it('renders nothing when closed', () => {
    const { container } = render(<ProcessLogModal open={false} onClose={() => {}} processName="portos-server" />);
    expect(container).toBeEmptyDOMElement();
    expect(getProcessLogs).not.toHaveBeenCalled();
  });

  it('fetches and shows the selected process log when opened', async () => {
    render(<ProcessLogModal open onClose={() => {}} processName="portos-server" />);
    await waitFor(() => expect(getProcessLogs).toHaveBeenCalledWith('portos-server', 200));
    expect(await screen.findByText(/error: boom/)).toBeInTheDocument();
  });

  it('refetches with the new tail length when changed', async () => {
    render(<ProcessLogModal open onClose={() => {}} processName="portos-server" />);
    await waitFor(() => expect(getProcessLogs).toHaveBeenCalledWith('portos-server', 200));
    fireEvent.change(screen.getByLabelText('Tail'), { target: { value: '500' } });
    await waitFor(() => expect(getProcessLogs).toHaveBeenCalledWith('portos-server', 500));
  });

  it('does not keep showing the prior process logs while the next fetch is in flight', async () => {
    let resolveSecond;
    getProcessLogs
      .mockResolvedValueOnce({ logs: 'server logs here' })
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));
    render(<ProcessLogModal open onClose={() => {}} processName="portos-server" />);
    expect(await screen.findByText('server logs here')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Process'), { target: { value: 'portos-cos' } });
    await waitFor(() => expect(getProcessLogs).toHaveBeenLastCalledWith('portos-cos', 200));
    // The stale portos-server logs must be gone while portos-cos is still loading.
    expect(screen.queryByText('server logs here')).not.toBeInTheDocument();

    resolveSecond({ logs: 'cos logs here' });
    expect(await screen.findByText('cos logs here')).toBeInTheDocument();
  });

  it('surfaces a fetch error instead of log text', async () => {
    getProcessLogs.mockRejectedValueOnce(new Error('daemon down'));
    render(<ProcessLogModal open onClose={() => {}} processName="portos-server" />);
    expect(await screen.findByText('daemon down')).toBeInTheDocument();
  });

  it('keeps the hinted process selectable even when PM2 does not report it', async () => {
    getProcessesList.mockResolvedValueOnce([{ name: 'portos-cos' }]);
    render(<ProcessLogModal open onClose={() => {}} processName="portos-server" />);
    await waitFor(() => expect(getProcessLogs).toHaveBeenCalledWith('portos-server', 200));
    const select = screen.getByLabelText('Process');
    expect(within(select).getByRole('option', { name: 'portos-server' })).toBeInTheDocument();
  });
});
