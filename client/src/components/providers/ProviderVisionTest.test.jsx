import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ProviderCard from './ProviderCard';
import { PROVIDER_CARD_STATE } from '../../utils/providers';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../services/apiCore.js', () => ({ request }));
vi.mock('../../services/socket.js', () => ({ default: { on: vi.fn() } }));
const renderCard = (overrides = {}) => render(<MemoryRouter><ProviderCard
  provider={{ id: 'vision-provider', name: 'Vision provider', type: 'api', enabled: true, models: ['vision-model'], defaultModel: 'vision-model', ...overrides }}
  cardState={{ state: PROVIDER_CARD_STATE.READY, missing: [] }} providersById={{}} runnerAllowedCommands={[]}
/></MemoryRouter>);

beforeEach(() => request.mockReset());
describe('provider card vision diagnostics', () => {
  it('makes no cold calls, checks health on click, and submits one screenshot to the selected provider/model', async () => {
    request.mockResolvedValueOnce({ available: true }).mockResolvedValueOnce({ success: true, response: 'A sample interface with a button.' });
    renderCard();
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Test vision' }));
    await screen.findByText(/Endpoint reachable/);
    expect(request).toHaveBeenNthCalledWith(1, '/providers/vision-provider/vision-health', { silent: true });
    fireEvent.change(screen.getByLabelText('Stored screenshot filename'), { target: { value: 'sample.png' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'chosen-model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run image test' }));
    await screen.findByText('Vision test passed');
    expect(request).toHaveBeenNthCalledWith(2, '/providers/vision-provider/test-vision', {
      method: 'POST', silent: true, body: JSON.stringify({ model: 'chosen-model', imagePath: 'sample.png', prompt: 'Describe what you see in this image.' }),
    });
    expect(screen.getByText('A sample interface with a button.')).toBeInTheDocument();
  });

  it('blocks duplicate calls while the suite runs and displays returned failures and transport errors', async () => {
    let finish;
    request.mockResolvedValueOnce({ available: true }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockRejectedValueOnce(new Error('Connection lost'));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Test vision' }));
    await screen.findByText(/Endpoint reachable/);
    fireEvent.click(screen.getByRole('button', { name: 'Run vision suite' }));
    expect(screen.getByRole('button', { name: 'Run vision suite' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Run vision suite' }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith('/providers/vision-provider/vision-suite', { method: 'POST', silent: true, body: JSON.stringify({ model: 'vision-model' }) });
    finish({ success: false, totalTests: 2, passedTests: 0, results: [{ testName: 'basic-description', error: 'Model does not support images' }] });
    await screen.findByText(/Vision test failed/);
    expect(screen.getByText('Model does not support images')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run vision suite' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Connection lost'));
  });

  it('shows unavailable health and refuses test calls, and offers no vision action for CLI providers', async () => {
    request.mockResolvedValueOnce({ available: false, error: 'API endpoint not reachable' });
    const { unmount } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Test vision' }));
    await screen.findByText('API endpoint not reachable');
    expect(screen.getByRole('button', { name: 'Run vision suite' })).toBeDisabled();
    expect(request).toHaveBeenCalledTimes(1);
    unmount();
    renderCard({ type: 'cli', command: 'example' });
    expect(screen.queryByRole('button', { name: 'Test vision' })).toBeNull();
  });
});
