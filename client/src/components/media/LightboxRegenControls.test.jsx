import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import LightboxRegenControls from './LightboxRegenControls.jsx';

const previewRegenerate = vi.fn();
vi.mock('../../services/apiImageVideo.js', () => ({
  previewRegenerate: (...args) => previewRegenerate(...args),
}));

const item = { kind: 'image', filename: 'frame.png' };
const serverRecord = {
  modelId: 'flux2-klein-9b',
  sentPrompt: 'typed words',
  sentNegativePrompt: 'SOURCE NEGATIVE',
  promptAdditions: [{ id: 'source-negative-prompt', label: "Source image's negative prompt", text: 'SOURCE NEGATIVE' }],
};

const open = () => {
  render(<LightboxRegenControls item={item} onClose={() => {}} onRegenerate={() => {}} regenAvailable regenBounds={{}} />);
  fireEvent.click(screen.getByRole('button', { name: /Regenerate image/ }));
};

describe('LightboxRegenControls model input preview', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows the carried negative prompt as a chip and in the full prompt once a prompt is typed', async () => {
    previewRegenerate.mockResolvedValue(serverRecord);
    open();
    fireEvent.change(screen.getByLabelText(/Prompt/), { target: { value: ' typed words ' } });

    const chip = await screen.findByRole('button', { name: "+ Source image's negative prompt" }, { timeout: 2000 });
    expect(previewRegenerate).toHaveBeenCalledWith('frame.png', { prompt: 'typed words' }, { silent: true });
    fireEvent.click(chip);
    expect(screen.getByText('SOURCE NEGATIVE')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show full prompt' }));
    expect(screen.getByText(/Negative prompt: SOURCE NEGATIVE/)).toBeInTheDocument();
  });

  it('asks the server for nothing and shows no chip while the prompt is empty', async () => {
    open();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(previewRegenerate).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /negative prompt/ })).toBeNull();
  });
});
