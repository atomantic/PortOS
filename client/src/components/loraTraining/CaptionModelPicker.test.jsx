import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
const getVisionModels = vi.fn();
const getSettings = vi.fn();
vi.mock('../../services/api', () => ({
  getVisionModels: (...a) => getVisionModels(...a),
  getSettings: (...a) => getSettings(...a),
  patchSettingsSlice: vi.fn(),
}));

import CaptionModelPicker from './CaptionModelPicker';

const renderPicker = async (onChange = vi.fn()) => {
  render(<CaptionModelPicker onChange={onChange} />);
  await act(async () => {});
  return onChange;
};

beforeEach(() => vi.clearAllMocks());

describe('CaptionModelPicker', () => {
  it('shows a load error — not "none installed" or an Auto choice — when the model list fails', async () => {
    getVisionModels.mockRejectedValueOnce(new Error('Server unavailable'));
    getSettings.mockResolvedValue({ loraTraining: { captionModel: 'vision-a', captionProviderId: 'lmstudio' } });
    const onChange = await renderPicker();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load vision models — Server unavailable');
    expect(screen.queryByText('none installed')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    getVisionModels.mockResolvedValueOnce({ models: [{ id: 'vision-a', providerId: 'lmstudio', name: 'Vision A', backend: 'LM Studio' }] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Caption model')).toHaveValue('lmstudio::vision-a');
    expect(onChange).toHaveBeenCalledWith({ providerId: 'lmstudio', model: 'vision-a' });
  });
});
