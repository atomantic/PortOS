import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ExecutionOptionsSelect from './ExecutionOptionsSelect.jsx';
import { request } from '../../services/apiCore.js';
vi.mock('../../services/apiCore.js', () => ({ request: vi.fn() }));

describe('execution speed selection', () => {
  it('does not guess capability support from the command name on an unadvertised route', () => {
    request.mockClear();
    render(<ExecutionOptionsSelect provider={{ id: 'codex', command: 'codex', type: 'cli' }} onChange={() => {}} />);
    expect(request).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Speed')).not.toBeInTheDocument();
  });

  it('keeps Standard separate from inheritance and explains Fast usage', async () => {
    request.mockResolvedValue({ options: [{ key: 'serviceTier', label: 'Speed', values: ['standard', 'fast'], help: 'Fast may consume more subscription usage or credits.' }] });
    const onChange = vi.fn();
    render(<ExecutionOptionsSelect provider={{ id: 'example' }} model="example-model" value={{ serviceTier: 'fast' }} onChange={onChange} />);
    const select = await screen.findByLabelText('Speed');
    expect(screen.getByText(/consume more/)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'standard' } });
    expect(onChange).toHaveBeenLastCalledWith({ serviceTier: 'standard' });
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({});
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
});
