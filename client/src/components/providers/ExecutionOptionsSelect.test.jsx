import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import ExecutionOptionsSelect from './ExecutionOptionsSelect.jsx';
import { request } from '../../services/apiCore.js';
vi.mock('../../services/apiCore.js', () => ({ request: vi.fn() }));

const sharedProvider = { id: 'shared', executionOptionKeys: ['serviceTier'] };
const options = (...values) => ({ options: [{ key: 'serviceTier', label: 'Speed', values }] });

beforeEach(() => request.mockReset());

describe('execution speed selection', () => {
  it('does not guess capability support from the command name on an unadvertised route', () => {
    render(<ExecutionOptionsSelect provider={{ id: 'codex', command: 'codex', type: 'cli' }} onChange={() => {}} />);
    expect(request).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Speed')).not.toBeInTheDocument();
  });

  it('keeps Standard separate from inheritance without help text', async () => {
    request.mockResolvedValue({ options: [{ key: 'serviceTier', label: 'Speed', values: ['standard', 'fast'], help: 'Fast may consume more subscription usage or credits.' }] });
    const onChange = vi.fn();
    render(<ExecutionOptionsSelect provider={{ id: 'example' }} model="example-model" value={{ serviceTier: 'fast' }} onChange={onChange} />);
    await screen.findByRole('option', { name: 'Standard' });
    const select = screen.getByLabelText('Speed');
    expect(screen.queryByText(/consume more/)).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'standard' } });
    expect(onChange).toHaveBeenLastCalledWith({ serviceTier: 'standard' });
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('keeps advertised controls available to retry a failed capability request without a saved pin', async () => {
    request.mockRejectedValueOnce(new Error('Capability request failed'));
    const onChange = vi.fn();
    render(<ExecutionOptionsSelect provider={{ id: 'example', executionOptionKeys: ['serviceTier'] }} value={{}} onChange={onChange} />);
    expect(await screen.findByText('Execution capabilities could not be verified.')).toBeInTheDocument();
    expect(screen.getByLabelText('Speed').value).toBe('');

    request.mockResolvedValue({ options: [{ key: 'serviceTier', label: 'Speed', values: ['standard', 'fast'] }] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh capabilities' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Fast' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: 'fast' } });
    expect(onChange).toHaveBeenCalledWith({ serviceTier: 'fast' });
  });

  it('keeps an unsupported saved selection visible and clearable', async () => {
    request.mockResolvedValue({ options: [], reason: 'This route cannot select speed.' });
    const onChange = vi.fn();
    render(<ExecutionOptionsSelect provider={{ id: 'other' }} model="example-model" value={{ serviceTier: 'fast' }} onChange={onChange} />);
    expect(await screen.findByText('This route cannot select speed.')).toBeInTheDocument();
    const select = screen.getByLabelText('Speed');
    expect(select.value).toBe('fast');
    expect(screen.getByRole('option', { name: 'fast (unsupported)' })).toBeDisabled();
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({});
  });

  it('shares one pending read across 30 selectors and broadcasts refresh without accepting an older response', async () => {
    const initial = Promise.withResolvers();
    request.mockReturnValueOnce(initial.promise).mockResolvedValueOnce(options('fast'));
    render(Array.from({ length: 30 }, (_, index) => (
      <ExecutionOptionsSelect key={index} provider={sharedProvider} model="shared-model" />
    )));
    expect(request).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh capabilities' })[0]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith('/providers/shared/execution-options?model=shared-model&refresh=true', { silent: true });
    expect(await screen.findAllByRole('option', { name: 'Fast' })).toHaveLength(30);

    await act(async () => { initial.resolve(options('standard')); });
    expect(screen.queryByRole('option', { name: 'Standard' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('option', { name: 'Fast' })).toHaveLength(30);
  });

  it('shares only matching provider, model and route keys', async () => {
    request.mockResolvedValue(options('standard'));
    render(<>
      <ExecutionOptionsSelect provider={sharedProvider} model="first" />
      <ExecutionOptionsSelect provider={sharedProvider} model="second" />
      <ExecutionOptionsSelect provider={{ ...sharedProvider, command: 'other-command' }} model="first" />
      <ExecutionOptionsSelect provider={{ ...sharedProvider, id: 'different-provider' }} model="first" />
    </>);
    expect(await screen.findAllByRole('option', { name: 'Standard' })).toHaveLength(4);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      '/providers/shared/execution-options?model=first',
      '/providers/shared/execution-options?model=second',
      '/providers/shared/execution-options?model=first',
      '/providers/different-provider/execution-options?model=first',
    ]);
  });

  it('retries a failed read on remount and reuses success for ten seconds', async () => {
    const dateNow = vi.spyOn(Date, 'now');
    const start = Date.now();
    dateNow.mockReturnValue(start);
    try {
      request.mockRejectedValueOnce(new Error('Network failure')).mockResolvedValue(options('standard'));
      const selector = <ExecutionOptionsSelect provider={sharedProvider} model="retry" />;
      const failed = render(selector);
      await screen.findByText('Execution capabilities could not be verified.');
      failed.unmount();

      const retried = render(selector);
      await screen.findByRole('option', { name: 'Standard' });
      expect(request).toHaveBeenCalledTimes(2);
      retried.unmount();

      dateNow.mockReturnValue(start + 9_999);
      const cached = render(selector);
      await screen.findByRole('option', { name: 'Standard' });
      expect(request).toHaveBeenCalledTimes(2);
      cached.unmount();

      dateNow.mockReturnValue(start + 10_000);
      render(selector);
      await screen.findByRole('option', { name: 'Standard' });
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      dateNow.mockRestore();
    }
  });
});
