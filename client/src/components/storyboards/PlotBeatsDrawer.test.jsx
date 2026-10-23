import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// Real request() from services/apiCore runs here (no api mock), so the toast
// count below is the one the user would see for a failed background save.
vi.mock('../ui/Toast', () => {
  const toastFn = vi.fn();
  toastFn.error = vi.fn();
  return { default: toastFn };
});
vi.mock('../musicVideo/MusicVideoLlmPicker', () => ({ default: () => null }));
vi.mock('../media/SentPromptPanel', () => ({ default: () => null }));

import toast from '../ui/Toast';
import PlotBeatsDrawer from './PlotBeatsDrawer';

const board = { id: 'sb-1', name: 'Board', plot: 'Saved plot', plotLlm: null };

describe('PlotBeatsDrawer plot save', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => ({
      status: 500,
      ok: false,
      json: async () => ({ error: 'disk full' }),
    }));
    toast.mockReset();
    toast.error.mockReset();
  });
  afterEach(() => { delete global.fetch; });

  it('reports a failed blur save once and keeps the typed plot on screen', async () => {
    const onBoard = vi.fn();
    render(<PlotBeatsDrawer open board={board} onClose={() => {}} onBoard={onBoard} />);
    const textarea = screen.getByLabelText('Plot summary');
    fireEvent.change(textarea, { target: { value: 'A new plot' } });
    fireEvent.blur(textarea);
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith('disk full');
    expect(onBoard).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('A new plot');
  });
});
