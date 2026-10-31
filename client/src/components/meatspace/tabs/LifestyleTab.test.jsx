import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  getMeatspaceConfig: vi.fn(),
  updateMeatspaceConfig: vi.fn(async (data) => data),
}));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import * as api from '../../../services/api';
import LifestyleTab from './LifestyleTab';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('LifestyleTab profile load', () => {
  it('offers no form or Save after a failed read, so defaults are never written over the stored profile', async () => {
    api.getMeatspaceConfig.mockRejectedValueOnce(new Error('boom'));
    render(<LifestyleTab />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your lifestyle profile');
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
    expect(api.getMeatspaceConfig).toHaveBeenLastCalledWith({ silent: true });

    api.getMeatspaceConfig.mockResolvedValueOnce({ sex: 'female', lifestyle: { smokingStatus: 'former', exerciseMinutesPerWeek: 60 } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const save = await screen.findByRole('button', { name: /Save/ });
    await act(async () => { fireEvent.click(save); });
    expect(api.updateMeatspaceConfig).toHaveBeenCalledWith(expect.objectContaining({
      sex: 'female',
      lifestyle: expect.objectContaining({ smokingStatus: 'former', exerciseMinutesPerWeek: 60 }),
    }));
    expect(api.updateMeatspaceConfig).toHaveBeenCalledTimes(1);
  });
});

it('keeps a loaded profile when an older Retry read fails after a newer one succeeded', async () => {
  api.getMeatspaceConfig.mockRejectedValueOnce(new Error('boom'));
  render(<LifestyleTab />);
  const retry = await screen.findByRole('button', { name: 'Retry' });

  let rejectOlder;
  api.getMeatspaceConfig.mockImplementationOnce(() => new Promise((_, reject) => { rejectOlder = reject; }));
  fireEvent.click(retry);
  api.getMeatspaceConfig.mockResolvedValueOnce({ sex: 'female', lifestyle: {} });
  fireEvent.click(retry);
  expect(await screen.findByRole('button', { name: /Save/ })).toBeTruthy();

  await act(async () => { rejectOlder(new Error('late')); });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: /Save/ })).toBeTruthy();
});
